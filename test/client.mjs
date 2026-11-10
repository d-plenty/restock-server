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

// ---------- 0.9.4, protocol v3: a phone and a browser as docs/server-protocol.md "v3" says ----------
// They use the Restock core (core/restock-core.mjs) for the v3 crypto, as the web app does.

export const core = await import('../core/restock-core.mjs');
const u8 = (s) => core.unb64(s);
const SEALED = 'application/x-restock-sealed';

/** Reads a restock-server:3 / restock-handover:3 / restock-login:3 code's fields. */
export function codeFields(code) {
  return Object.fromEntries(new URLSearchParams(String(code).replace(/^[a-z-]+:3\?/, '')));
}

/** A 0.9.4 phone: its request-signing key (v2's), its kex key, its household signing key (my_priv). */
export class V3Phone extends Phone {
  constructor(base, o = {}) {
    super(base, o);
    this.kex = core.newEcdhKey();
    this.my = core.newJavaKeyPair();
    this.serverKeys = {};
    this.keys = this.keys; // the request-signing key pair (Phone)
    this.householdKeys = {};
    this.keyv = 0;
  }
  async post(path, json) {
    return this.req('POST', path, { json });
  }
  joinBody(invite, n = b64u(randomBytes(16))) {
    return { invite, device: this.device, name: this.name, pub: this.keys.pub, kex: b64u(this.kex.pub), myPub: this.my.pub, n };
  }
  /** Takes a join or upgrade answer in. */
  takeGift(serverKex, n, sealed) {
    const key = core.joinKey(this.kex.priv, u8(serverKex), u8(n));
    const g = core.openJoin(key, this.device, u8(sealed));
    this.gift = g;
    this.serverKeys = { ...this.serverKeys, ...g.serverKeys };
    this.householdKeys = { ...this.householdKeys, ...g.keys };
    this.keyv = g.keyv;
    this.serverKex = serverKex;
    return g;
  }
  async join(code, extra = {}) {
    const f = codeFields(code);
    const n = b64u(randomBytes(16));
    const r = await fetch(this.base + '/api/v3/join', { method: 'POST', headers: { ...this.headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ ...this.joinBody(f.i, n), ...extra }) });
    const body = await asJson(r);
    if (r.status === 200) this.takeGift(f.k, n, body.sealed);
    return { status: r.status, body };
  }
  async memberJoin(serverKex, { sigBy = this.my.priv } = {}) {
    const n = b64u(randomBytes(16));
    const b = { member: true, device: this.device, pub: this.keys.pub, kex: b64u(this.kex.pub), n };
    b.sig = core.signWithPkcs8(sigBy, core.memberJoinText(b));
    const r = await fetch(this.base + '/api/v3/join', { method: 'POST', headers: { ...this.headers, 'Content-Type': 'application/json' }, body: JSON.stringify(b) });
    const body = await asJson(r);
    if (r.status === 200) this.takeGift(serverKex, n, body.sealed);
    return { status: r.status, body };
  }
  async upgrade(serverKex, ha) {
    const n = b64u(randomBytes(16));
    const b = { kex: b64u(this.kex.pub), myPub: this.my.pub, n };
    if (ha) b.ha = b64u(core.sealHa(core.haKey(this.kex.priv, u8(serverKex), u8(n)), this.device, ha));
    const r = await this.req('POST', '/api/v3/upgrade', { json: b });
    if (r.status === 200) this.takeGift(serverKex, n, r.body.sealed);
    return r;
  }
  /** Its own sync file (folder-sync format, plus shares), sealed with the newest serverKey. */
  file(entries, more = {}) {
    return { format: 'restock-sync', v: 1, device: this.device, name: this.name, keyv: this.keyv, at: new Date().toISOString(), top: entries.length, seen: {}, entries, ...more };
  }
  sealFor(msg, keyv = this.keyv) {
    return Buffer.from(core.sealRsf1(u8(this.serverKeys[String(keyv)]), msg));
  }
  putOwn(msg) {
    return this.req('PUT', `/api/v3/files/restock-sync-${this.device}.bin`, { body: this.sealFor(msg) });
  }
  async getFile(name) {
    return this.req('GET', '/api/v3/files/' + name);
  }
  /** The server's own file, opened (null if it isn't there). */
  async serverFile(sid) {
    const r = await this.getFile(`restock-sync-srv-${sid}.bin`);
    if (r.status !== 200) return null;
    return core.openWithAny(this.serverKeys, r.body).msg;
  }
  /** keys/<device>.bin after a rekey: takes a higher keyv. */
  async takeKeysFile() {
    const r = await this.getFile(`keys/${this.device}.bin`);
    if (r.status !== 200) return r;
    const k = core.openKeysFile(core.keysFileKey(this.kex.priv, u8(this.serverKex)), this.device, r.body);
    if (k.keyv > this.keyv) {
      this.keyv = k.keyv;
      this.householdKeys = { ...this.householdKeys, ...k.keys };
      for (const [v, key] of Object.entries(k.keys)) this.serverKeys[v] = b64u(core.serverKeyOf(u8(key)));
    }
    return { status: 200, keys: k };
  }
}

/** A browser on v3: challenge sign-in, a session key, MACed requests, sealed answers. */
export class V3Browser {
  constructor(base, { ip, headers = {} } = {}) {
    this.base = base;
    this.headers = { ...(ip ? { 'X-Forwarded-For': ip } : {}), ...headers };
  }
  async login(user, passphrase, iterations = 600000, { tamper } = {}) {
    const ch = await (await fetch(`${this.base}/api/v3/login/challenge?user=${encodeURIComponent(user)}`, { headers: this.headers })).json();
    const { auth } = derive(passphrase, ch.salt, iterations);
    const loginKey = core.loginKeyOf(u8(auth));
    const e = core.newEcdhKey();
    const epub = b64u(e.pub);
    const body = { user, c: ch.c, epub, proof: core.loginProof(loginKey, ch.c, epub) };
    if (tamper) tamper(body);
    const r = await fetch(this.base + '/api/v3/login', { method: 'POST', headers: { ...this.headers, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const out = await asJson(r);
    if (r.status !== 200) return { status: r.status, body: out };
    this.loginKey = loginKey;
    this.session = out.session;
    this.key = core.sessionKeyOf(e.priv, u8(ch.kex), u8(ch.c), loginKey);
    this.kex = ch.kex;
    this.gift = core.openRsf1(this.key, u8(out.sealed));
    return { status: 200, body: out, gift: this.gift };
  }
  /** A request: `json` (plain), `sealed` (RSF1 with the session key) or raw `body`. */
  async raw(method, path, { json, sealed, body, headers = {}, auth } = {}) {
    const h = { ...this.headers, ...headers };
    if (json !== undefined) {
      body = Buffer.from(JSON.stringify(json));
      h['Content-Type'] = 'application/json';
    } else if (sealed !== undefined) {
      body = Buffer.from(core.sealRsf1(this.key, sealed));
      h['Content-Type'] = SEALED;
    }
    const wire = new URL(this.base + path);
    if (this.session) h.Authorization = auth ?? core.webAuthorization(this.session, this.key, method, wire.pathname + wire.search, body ?? new Uint8Array(0));
    return fetch(this.base + path, { method, headers: h, body });
  }
  async req(method, path, opts) {
    const r = await this.raw(method, path, opts);
    const type = r.headers.get('content-type') || '';
    const bytes = Buffer.from(await r.arrayBuffer());
    let out;
    if (type.startsWith(SEALED)) out = core.openRsf1(this.key, bytes);
    else if (type.startsWith('application/json')) out = bytes.length ? JSON.parse(bytes.toString('utf8')) : {};
    else out = bytes;
    return { status: r.status, headers: r.headers, body: out, sealed: type.startsWith(SEALED) };
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
  /**
   * 0.9.4: the passphrase again, for the dangerous admin actions: `{ c, proof }` over a fresh
   * challenge, bound to this session (a wrong `loginKey` makes a wrong proof).
   */
  async confirm(loginKey = this.loginKey) {
    const ch = await (await fetch(`${this.base}/api/v3/login/challenge?user=admin`, { headers: this.headers })).json();
    return { c: ch.c, proof: core.loginProof(loginKey, ch.c, this.session) };
  }
  async recovery() {
    return this.post('/api/v3/recovery', { confirm: await this.confirm() });
  }
  async removePhone(device) {
    return this.req('DELETE', '/api/v3/phones/' + device, { json: { confirm: await this.confirm() } });
  }
}
