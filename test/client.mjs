// Small clients for the Restock server's v2 API, for the tests and for anyone testing against a
// real server (the phone and web engineers): a browser with a cookie jar, and a phone that signs
// its requests with its own P-256 key, exactly as docs/server-protocol.md says.

import { createHash, createCipheriv, generateKeyPairSync, pbkdf2Sync, randomBytes, sign } from 'node:crypto';
import { gzipSync } from 'node:zlib';

export const b64u = (b) => Buffer.from(b).toString('base64url');
const sha256hex = (b) => createHash('sha256').update(b ?? Buffer.alloc(0)).digest('hex');

/** PBKDF2-HMAC-SHA256(NFKC(passphrase), salt, iterations, 64): { auth (b64url), vaultKey (Buffer) }. */
export function derive(passphrase, saltB64u, iterations = 600000) {
  const bits = pbkdf2Sync(Buffer.from(passphrase.normalize('NFKC'), 'utf8'), Buffer.from(saltB64u, 'base64url'), iterations, 64, 'sha256');
  return { auth: b64u(bits.subarray(0, 32)), vaultKey: bits.subarray(32, 64) };
}

/** A sealed RSF1 file, like SyncFolder.seal on the phone (the key doesn't matter to the server). */
export function seal(key, message, magic = 'RSF1') {
  const nonce = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, nonce);
  c.setAAD(Buffer.from(magic));
  const body = Buffer.concat([c.update(gzipSync(JSON.stringify(message))), c.final(), c.getAuthTag()]);
  return Buffer.concat([Buffer.from(magic), nonce, body]);
}

/** A stand-in vault: RSV2 + nonce + AES-GCM(vaultKey, JSON). */
export function vault(vaultKey, inside) {
  const nonce = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', vaultKey, nonce);
  const body = Buffer.concat([c.update(JSON.stringify(inside)), c.final(), c.getAuthTag()]);
  return b64u(Buffer.concat([Buffer.from('RSV2'), nonce, body]));
}

/** A P-256 key pair: { privateKey, pub (SPKI, base64) }. */
export function p256() {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  return { privateKey, pub: publicKey.export({ type: 'spki', format: 'der' }).toString('base64') };
}

async function asJson(r) {
  const text = await r.text();
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return { text };
  }
}

/** A browser: keeps cookies, sends JSON. */
export class Browser {
  constructor(base, { ip, headers = {} } = {}) {
    this.base = base;
    this.jar = new Map();
    this.headers = { ...(ip ? { 'X-Forwarded-For': ip } : {}), ...headers };
  }
  cookie(name) {
    return this.jar.get(name);
  }
  async raw(method, path, { json, body, headers = {} } = {}) {
    const h = { ...this.headers, ...headers };
    if (this.jar.size) h.Cookie = [...this.jar].map(([k, v]) => `${k}=${v}`).join('; ');
    if (json !== undefined) {
      h['Content-Type'] = 'application/json';
      body = JSON.stringify(json);
    }
    const r = await fetch(this.base + path, { method, headers: h, body, redirect: 'manual' });
    for (const c of r.headers.getSetCookie()) {
      const [kv, ...attrs] = c.split(';');
      const i = kv.indexOf('=');
      const k = kv.slice(0, i).trim();
      const v = kv.slice(i + 1).trim();
      if (!v || attrs.some((a) => /^\s*max-age=0\s*$/i.test(a))) this.jar.delete(k);
      else this.jar.set(k, v);
    }
    return r;
  }
  async req(method, path, opts) {
    const r = await this.raw(method, path, opts);
    return { status: r.status, headers: r.headers, body: await asJson(r) };
  }
  get(path) {
    return this.req('GET', path);
  }
  post(path, json = {}) {
    return this.req('POST', path, { json });
  }
  put(path, json) {
    return this.req('PUT', path, { json });
  }
  /** First start: the RESTOCK_USER / RESTOCK_PASSWORD login, then a passphrase. */
  async setup({ user = 'admin', password = 'admin', passphrase, iterations = 600000, webId, webPub } = {}) {
    const l = await this.post('/api/v2/login', { user, password });
    if (l.status !== 200) throw new Error('setup login failed: ' + JSON.stringify(l.body));
    const salt = b64u(randomBytes(16));
    const { auth, vaultKey } = derive(passphrase, salt, iterations);
    const p = await this.post('/api/v2/passphrase', { salt, auth, ...(webId ? { webId, webPub } : {}) });
    if (p.status !== 200) throw new Error('setting the passphrase failed: ' + JSON.stringify(p.body));
    return { salt, auth, vaultKey };
  }
  /** Sign in with the passphrase. */
  async login(user, passphrase, iterations = 600000) {
    const { salt } = (await this.get('/api/v2/login/salt?user=' + encodeURIComponent(user))).body;
    const { auth, vaultKey } = derive(passphrase, salt, iterations);
    const r = await this.post('/api/v2/login', { user, auth });
    return { ...r, vaultKey, salt, auth };
  }
}

/** A phone: its own P-256 key; every request signed (Authorization: Restock2 ...). */
export class Phone {
  constructor(base, { device = 'p' + randomBytes(6).toString('hex'), name = 'Test phone', ip, clock = Date.now } = {}) {
    Object.assign(this, { base, device, name, clock });
    this.keys = p256();
    this.skew = 0;
    this.headers = ip ? { 'X-Forwarded-For': ip } : {};
  }
  authHeader(method, pathAndQuery, body, { t = this.clock() + this.skew, n = b64u(randomBytes(16)) } = {}) {
    const text = `${method}\n${pathAndQuery}\n${t}\n${n}\n${sha256hex(body)}`;
    const s = sign('sha256', Buffer.from(text), { key: this.keys.privateKey, dsaEncoding: 'der' }).toString('base64');
    return `Restock2 d=${this.device}, t=${t}, n=${n}, s=${s}`;
  }
  async raw(method, path, { body, json, header, retryClock = true } = {}) {
    if (json !== undefined) body = Buffer.from(JSON.stringify(json));
    if (typeof body === 'string') body = Buffer.from(body);
    // Sign the path exactly as it goes on the wire (fetch escapes spaces and the like).
    const u = new URL(this.base + path);
    const wire = u.pathname + u.search;
    const r = await fetch(this.base + path, { method, body, headers: { ...this.headers, Authorization: header ?? this.authHeader(method, wire, body), ...(json !== undefined ? { 'Content-Type': 'application/json' } : {}) } });
    if (r.status === 401 && retryClock && !header) {
      const copy = r.clone();
      const e = await asJson(copy);
      if (e.error === 'clock') {
        // The contract: retry once with the server's time.
        this.skew = Number(r.headers.get('X-Restock-Time')) - this.clock();
        return this.raw(method, path, { body, header, retryClock: false });
      }
    }
    return r;
  }
  async req(method, path, opts) {
    const r = await this.raw(method, path, opts);
    const type = r.headers.get('content-type') || '';
    return { status: r.status, headers: r.headers, body: type.startsWith('application/octet-stream') ? Buffer.from(await r.arrayBuffer()) : await asJson(r) };
  }
  /** Join with an invite from the web page. */
  async join(invite) {
    const r = await fetch(this.base + '/api/v2/devices', {
      method: 'POST',
      headers: { ...this.headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ invite, device: this.device, name: this.name, pub: this.keys.pub }),
    });
    return { status: r.status, body: await asJson(r) };
  }
  put(name, body) {
    return this.req('PUT', '/api/v2/files/' + name, { body });
  }
  get(path) {
    return this.req('GET', path);
  }
}
