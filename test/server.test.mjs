import { test, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, readdirSync, writeFileSync, existsSync, mkdirSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, pbkdf2Sync } from 'node:crypto';
import { request } from 'node:http';
import { makeServer, config, LIMITS, VERSION, isHomeAddress, isKnownPassword, limitKey } from '../src/server.mjs';
import { parseName } from '../src/names.mjs';
import { Browser, Phone, seal, vault, p256, b64u, derive } from './client.mjs';
import { pbkdf2Js, sha256 as jsSha256 } from '../public/setup/pbkdf2.js';
import { checkPassphrase } from '../public/setup/strength.js';
const PKG_VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

const ITER = 1000; // the server never sees the iteration count; fewer keeps the tests quick
const PASS = 'kettle orbit lemon fence';
const servers = [];
after(async () => {
  for (const s of servers) {
    s.server.close();
    await s.flush();
    rmSync(s.dir, { recursive: true, force: true });
  }
});

let ipN = 1;
const freshIp = () => `10.0.${Math.floor(ipN / 250)}.${ipN++ % 250}`;

/** A server on a temp folder, with a clock the test can move. */
async function start(over = {}, dir = mkdtempSync(join(tmpdir(), 'restock-server-')), listen = '127.0.0.1') {
  const clock = { shift: 0 };
  const now = () => Date.now() + clock.shift;
  const s = await makeServer({ ...config({}), dataDir: dir, quiet: true, trustProxy: true, now, ...over });
  await new Promise((r) => s.server.listen(0, listen, r));
  const base = `http://${listen === '0.0.0.0' ? '127.0.0.1' : listen}:${s.server.address().port}`;
  const entry = { ...s, dir, base, clock, now };
  servers.push(entry);
  const browser = (o = {}) => new Browser(base, { ip: freshIp(), ...o });
  const phone = (o = {}) => new Phone(base, { ip: freshIp(), clock: now, ...o });
  return { ...entry, browser, phone, mkPhone: phone };
}
async function stop(t) {
  t.server.close();
  await t.flush();
  servers.splice(servers.indexOf(servers.find((s) => s.server === t.server)), 1);
}

/** A server that's set up, with a signed-in browser and one joined phone. */
async function ready(over) {
  const t = await start(over);
  const web = t.browser();
  const webKey = p256();
  await web.setup({ passphrase: PASS, iterations: ITER, webId: 'webAAAAAAAA', webPub: webKey.pub });
  const l = await web.login('admin', PASS, ITER);
  assert.equal(l.status, 200);
  const phone = t.mkPhone({ name: 'Kitchen phone' });
  const inv = (await web.post('/api/v2/invites')).body;
  assert.equal((await phone.join(inv.invite)).status, 200);
  return { ...t, web, phone, webKey };
}
const sealed = (msg = { entries: [] }) => seal(randomBytes(32), msg);

// ---------------------------------------------------------------------------------------------

describe('health, headers and pages', () => {
  test('health needs nothing', async () => {
    const t = await start();
    const r = await t.browser().get('/api/v2/health');
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { ok: true, app: 'restock-server', version: VERSION, api: 2 });
    assert.equal(VERSION, PKG_VERSION);
    assert.equal(r.headers.get('cache-control'), 'no-store');
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(r.headers.get('referrer-policy'), 'no-referrer');
    assert.match(r.headers.get('content-security-policy'), /frame-ancestors 'none'/);
    assert.match(r.headers.get('x-restock-time'), /^\d+$/);
  });

  test('v1 is gone, unknown API paths are 404', async () => {
    const t = await start();
    assert.equal((await t.browser().get('/api/v1/files')).status, 410);
    assert.equal((await t.browser().get('/api/v2/nope')).status, 404);
  });

  test('before setup every page goes to the setup page; after, the web app (or a "not built" page)', async () => {
    const t = await start();
    const b = t.browser();
    let r = await b.raw('GET', '/');
    assert.equal(r.status, 302);
    assert.equal(r.headers.get('location'), '/setup/');
    assert.equal((await b.raw('GET', '/lists')).headers.get('location'), '/setup/');
    r = await b.raw('GET', '/setup/');
    assert.equal(r.status, 200);
    const csp = r.headers.get('content-security-policy');
    assert.match(csp, /default-src 'self'/);
    assert.match(csp, /script-src 'self' 'wasm-unsafe-eval'/);
    assert.match(csp, /frame-ancestors 'none'/);
    assert.match(await r.text(), /Set up your server/);
    assert.equal((await b.raw('GET', '/setup/setup.js')).headers.get('content-type'), 'text/javascript; charset=utf-8');
    await b.setup({ passphrase: PASS, iterations: ITER });
    assert.equal((await b.raw('GET', '/setup/')).headers.get('location'), '/');
    r = await b.raw('GET', '/');
    assert.ok(r.status === 200 || r.status === 503, 'the web app, or the "not built" page');
    assert.match(r.headers.get('content-type'), /text\/html/);
    assert.match(r.headers.get('content-security-policy'), /wasm-unsafe-eval/);
    // A made-up asset is a 404, not the app.
    assert.equal((await b.raw('GET', '/assets/nope-123.js')).status, 404);
    assert.equal((await b.raw('POST', '/')).status, 405);
  });

  test("pages can't reach outside public/", async () => {
    const t = await start();
    const get = (path) =>
      new Promise((ok) => {
        request(t.base + '/', { path, method: 'GET' }, (r) => {
          r.resume();
          ok(r.statusCode);
        }).end();
      });
    for (const p of ['/setup/..%2fsetup%2f..%2f..%2fpackage.json', '/setup/../../package.json', '/setup/%2e%2e/%2e%2e/src/server.mjs', '/setup/.hidden', '/setup/%00']) {
      assert.notEqual(await get(p), 200, p);
    }
  });
});

describe('first start and the passphrase', () => {
  test('the setup login works only with RESTOCK_USER / RESTOCK_PASSWORD, and only gives mustChange', async () => {
    const t = await start({ user: 'sarah', password: 'first-start-pw' });
    const b = t.browser();
    // The salt says the server is still being set up (the page then sends the password).
    assert.equal((await b.get('/api/v2/login/salt?user=sarah')).body.setup, true);
    assert.equal((await b.post('/api/v2/login', { user: 'sarah', password: 'admin' })).status, 401);
    assert.equal((await b.post('/api/v2/login', { user: 'admin', password: 'first-start-pw' })).status, 401);
    const r = await b.post('/api/v2/login', { user: 'sarah', password: 'first-start-pw' });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { mustChange: true, vault: null });
    const cookie = r.headers.get('set-cookie');
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Strict/);
    assert.match(cookie, /Path=\//);
    assert.doesNotMatch(cookie, /Secure/);
    for (const [m, p] of [
      ['GET', '/api/v2/files'],
      ['GET', '/api/v2/vault'],
      ['GET', '/api/v2/web'],
      ['POST', '/api/v2/invites'],
      ['GET', '/api/v2/devices'],
      ['GET', '/api/v2/activity'],
      ['POST', '/api/v2/link'],
      ['PUT', '/api/v2/files/restock-sync-web-xxxxxxxx.bin'],
    ]) {
      const x = await b.req(m, p, { json: m === 'GET' ? undefined : {} });
      assert.equal(x.status, 403, `${m} ${p}`);
      assert.equal(x.body.error, 'mustChange');
    }
    // Sign in with a phone isn't there until the server is set up.
    assert.equal((await t.browser().post('/api/v2/qrlogin')).status, 409);
  });

  test('with the default "admin" password, the first login only works from home', async () => {
    const MSG = 'Finish setting up Restock server from your home network first (or start it with your own RESTOCK_PASSWORD).';
    for (const trustProxy of [true, 'cloudflare', false]) {
      const t = await start({ trustProxy });
      const login = (headers) => new Browser(t.base, { headers }).post('/api/v2/login', { user: 'admin', password: 'admin' });
      // From outside, whatever a proxy header says, and even with RESTOCK_TRUST_PROXY.
      for (const h of [
        { 'X-Forwarded-For': '203.0.113.5' },
        { 'X-Forwarded-For': '203.0.113.5, 192.168.1.20' },
        { 'CF-Connecting-IP': '2001:db8::1' },
        { 'X-Real-IP': '8.8.8.8' },
        { Forwarded: 'for="[2001:db8::7]:4711";proto=https' },
        { 'X-Forwarded-For': 'unknown' },
      ]) {
        const r = await login(h);
        assert.equal(r.status, 403, JSON.stringify(h));
        assert.equal(r.body.error, 'setup-remote');
        assert.equal(r.body.message, MSG);
        assert.equal(r.headers.get('set-cookie'), null, 'no session');
      }
      // From home (the socket here is 127.0.0.1), including through a proxy on the home network or Tailscale.
      for (const h of [{}, { 'X-Forwarded-For': '192.168.1.20' }, { 'X-Forwarded-For': '100.101.5.7' }, { Forwarded: 'for=10.0.0.9' }]) {
        assert.equal((await login(h)).status, 200, JSON.stringify(h));
      }
      // Refusals from outside don't lock home out.
      assert.equal((await login({})).status, 200);
    }
  });

  test('with your own RESTOCK_PASSWORD the first login works from anywhere', async () => {
    const t = await start({ password: 'our-own-first-password' });
    const r = await new Browser(t.base, { headers: { 'X-Forwarded-For': '203.0.113.5' } }).post('/api/v2/login', { user: 'admin', password: 'our-own-first-password' });
    assert.equal(r.status, 200);
    assert.equal(r.body.mustChange, true);
  });

  test('home addresses', () => {
    for (const a of ['127.0.0.1', '::1', '::ffff:192.168.1.5', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.0.1', '169.254.1.1', '100.64.0.1', '100.127.255.254', 'fe80::1%eth0', 'fd12:3456::1', '[::1]:443', '192.168.1.2:5000']) {
      assert.equal(isHomeAddress(a), true, a);
    }
    for (const a of ['8.8.8.8', '203.0.113.5', '100.63.255.255', '100.128.0.1', '172.15.0.1', '172.32.0.1', '2001:db8::1', '::ffff:8.8.8.8', 'unknown', '', undefined, 'localhost']) {
      assert.equal(isHomeAddress(a), false, String(a));
    }
  });

  test('setting the passphrase: auth stored as scrypt, the setup password stops working', async () => {
    const t = await start();
    const b = t.browser();
    const { salt } = await b.setup({ passphrase: PASS, iterations: ITER });
    // The setup session carries on as a normal one.
    assert.equal((await b.get('/api/v2/files')).status, 200);
    assert.equal((await t.browser().post('/api/v2/login', { user: 'admin', password: 'admin' })).status, 401);
    const state = JSON.parse(readFileSync(join(t.dir, 'state.json'), 'utf8'));
    const { auth } = derive(PASS, salt, ITER);
    assert.equal(state.account.salt, salt);
    assert.equal(state.account.scrypt.alg, 'scrypt');
    assert.ok(!JSON.stringify(state).includes(auth), 'the authKey itself is never stored');
    assert.ok(!JSON.stringify(state).includes(PASS));
    // The real salt for the user; a stable fake one for anyone else, the same length.
    const s1 = (await t.browser().get('/api/v2/login/salt?user=admin')).body;
    assert.deepEqual(s1, { salt });
    const f1 = (await t.browser().get('/api/v2/login/salt?user=nobody')).body.salt;
    const f2 = (await t.browser().get('/api/v2/login/salt?user=nobody')).body.salt;
    assert.equal(f1, f2);
    assert.notEqual(f1, salt);
    assert.equal(f1.length, salt.length);
  });

  test('passphrase input is checked', async () => {
    const t = await start();
    const b = t.browser();
    await b.post('/api/v2/login', { user: 'admin', password: 'admin' });
    const salt = b64u(randomBytes(16));
    assert.equal((await b.post('/api/v2/passphrase', { salt: 'abc', auth: b64u(randomBytes(32)) })).status, 400);
    assert.equal((await b.post('/api/v2/passphrase', { salt, auth: b64u(randomBytes(31)) })).status, 400);
    assert.equal((await b.post('/api/v2/passphrase', { salt, auth: b64u(randomBytes(32)), vault: b64u(randomBytes(40)) })).status, 400);
    assert.equal((await b.post('/api/v2/passphrase', { salt, auth: b64u(randomBytes(32)), webId: 'short', webPub: p256().pub })).status, 400);
    assert.equal((await b.post('/api/v2/passphrase', { salt, auth: b64u(randomBytes(32)), webId: 'webBBBBBBBB', webPub: b64u(randomBytes(65)) })).status, 400);
    assert.equal((await t.browser().post('/api/v2/passphrase', { salt, auth: b64u(randomBytes(32)) })).status, 401, 'needs a session');
  });

  test('sign in with the passphrase, then the vault and the web key', async () => {
    const t = await start();
    await t.browser().setup({ passphrase: PASS, iterations: ITER });
    const b = t.browser();
    const wrong = await b.login('admin', 'kettle orbit lemon fencf', ITER);
    assert.equal(wrong.status, 401);
    assert.equal((await b.login('Admin', PASS, ITER)).status, 401, 'the user name has to match');
    const l = await b.login('admin', PASS, ITER);
    assert.equal(l.status, 200);
    assert.deepEqual(l.body, { mustChange: false, vault: null });
    let w = (await b.get('/api/v2/web')).body;
    assert.equal(w.webId, null);
    assert.equal(w.session.kind, 'passphrase');
    const k = p256();
    assert.equal((await b.put('/api/v2/web', { webId: 'webCCCCCCCC', webPub: k.pub })).status, 200);
    w = (await b.get('/api/v2/web')).body;
    assert.equal(w.webId, 'webCCCCCCCC');
    assert.deepEqual(w.webs, [{ webId: 'webCCCCCCCC', webPub: k.pub }]);
    assert.equal(w.session.webId, 'webCCCCCCCC');
    const v = vault(l.vaultKey, { webId: 'webCCCCCCCC', webPriv: 'x', keys: {} });
    assert.equal((await b.put('/api/v2/vault', { vault: v })).status, 200);
    assert.equal((await b.put('/api/v2/vault', { vault: 'not a vault' })).status, 400);
    assert.equal((await b.put('/api/v2/vault', { vault: b64u(Buffer.concat([Buffer.from('RSV2'), randomBytes(LIMITS.maxVault)])) })).status, 400, 'size cap');
    assert.equal((await b.get('/api/v2/vault')).body.vault, v);
    // The next sign-in gets the vault back.
    assert.equal((await t.browser().login('admin', PASS, ITER)).body.vault, v);
  });

  test('changing the passphrase signs everyone else out and needs a new webId', async () => {
    const t = await ready();
    const other = t.browser();
    assert.equal((await other.login('admin', PASS, ITER)).status, 200);
    const salt = b64u(randomBytes(16));
    const NEW = 'paddock wombat silver anchor';
    const { auth } = derive(NEW, salt, ITER);
    const current = derive(PASS, (await t.web.get('/api/v2/login/salt?user=admin')).body.salt, ITER).auth;
    const same = await t.web.post('/api/v2/passphrase', { salt, auth, current, webId: 'webAAAAAAAA', webPub: p256().pub });
    assert.equal(same.status, 400);
    assert.equal(same.body.error, 'webId');
    const r = await t.web.post('/api/v2/passphrase', { salt, auth, current, webId: 'webDDDDDDDD', webPub: p256().pub });
    assert.equal(r.status, 200);
    assert.equal((await t.web.get('/api/v2/files')).status, 200, 'this browser carries on');
    assert.equal((await other.get('/api/v2/files')).status, 401, 'the other one is signed out');
    assert.equal((await t.browser().login('admin', PASS, ITER)).status, 401);
    assert.equal((await t.browser().login('admin', NEW, ITER)).status, 200);
    // The old webId can't come back.
    assert.equal((await t.web.put('/api/v2/web', { webId: 'webAAAAAAAA', webPub: p256().pub })).status, 400);
    // Phones are untouched.
    assert.equal((await t.phone.get('/api/v2/files')).status, 200);
  });

  test('10 wrong logins from one address lock it out for 15 minutes; others carry on', async () => {
    const t = await start();
    await t.browser().setup({ passphrase: PASS, iterations: ITER });
    const ip = freshIp();
    const bad = new Browser(t.base, { ip });
    for (let i = 0; i < 10; i++) assert.equal((await bad.login('admin', 'wrong wrong wrong wrong', ITER)).status, 401);
    const locked = await bad.login('admin', PASS, ITER);
    assert.equal(locked.status, 429);
    assert.equal(locked.body.error, 'locked');
    assert.ok(Number(locked.headers.get('retry-after')) > 0);
    assert.equal((await t.browser().login('admin', PASS, ITER)).status, 200, 'another address is fine');
    // Inviting with a made-up code counts too, and is locked out the same way.
    assert.equal((await new Phone(t.base, { ip }).join(b64u(randomBytes(32)))).status, 429);
    t.clock.shift += LIMITS.lockoutMs + 1000;
    assert.equal((await bad.login('admin', PASS, ITER)).status, 200);
  });

  test('a page from another site gets nothing done with the session', async () => {
    const t = await ready();
    const r = await t.web.req('POST', '/api/v2/invites', { json: {}, headers: { 'Sec-Fetch-Site': 'cross-site' } });
    assert.equal(r.status, 403);
    assert.equal((await t.web.req('POST', '/api/v2/invites', { json: {}, headers: { 'Sec-Fetch-Site': 'same-origin' } })).status, 200);
  });

  test('Secure cookies on https behind a trusted proxy, not otherwise', async () => {
    const t = await start();
    const b = t.browser({ headers: { 'X-Forwarded-Proto': 'https' } });
    const r = await b.post('/api/v2/login', { user: 'admin', password: 'admin' });
    assert.match(r.headers.get('set-cookie'), /; Secure/);
    const u = await start({ trustProxy: false });
    const r2 = await new Browser(u.base, { headers: { 'X-Forwarded-Proto': 'https' } }).post('/api/v2/login', { user: 'admin', password: 'admin' });
    assert.doesNotMatch(r2.headers.get('set-cookie'), /Secure/);
  });

  test('without RESTOCK_TRUST_PROXY a made-up X-Forwarded-For doesn\'t dodge the lockout', async () => {
    const t = await start({ trustProxy: false });
    for (let i = 0; i < 10; i++) await new Browser(t.base, { ip: freshIp() }).post('/api/v2/login', { user: 'admin', password: 'nope' });
    assert.equal((await new Browser(t.base, { ip: freshIp() }).post('/api/v2/login', { user: 'admin', password: 'admin' })).status, 429);
  });
});

describe('phones', () => {
  test('an invite works once, for 10 minutes, and has the QR code text', async () => {
    const t = await ready({ homeUrl: 'http://192.168.1.10:8787', awayUrl: 'https://restock.example.com' });
    const inv = (await t.web.post('/api/v2/invites')).body;
    assert.match(inv.invite, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(inv.expiresIn, 600);
    assert.equal(inv.home, 'http://192.168.1.10:8787');
    assert.equal(inv.away, 'https://restock.example.com');
    const q = new URLSearchParams(inv.code.slice('restock-server:2?'.length));
    assert.ok(inv.code.startsWith('restock-server:2?h=http%3A%2F%2F192.168.1.10%3A8787&a='));
    assert.equal(q.get('i'), inv.invite);
    const a = t.mkPhone();
    assert.equal((await a.join(inv.invite)).status, 200);
    const again = await t.mkPhone().join(inv.invite);
    assert.equal(again.status, 410);
    assert.equal(again.body.error, 'used');
    const late = (await t.web.post('/api/v2/invites')).body;
    t.clock.shift += LIMITS.inviteMs + 1000;
    const r = await t.mkPhone().join(late.invite);
    assert.equal(r.status, 410);
    assert.equal(r.body.error, 'expired');
    assert.equal((await t.mkPhone().join('made-up')).status, 401);
    assert.equal((await t.browser().post('/api/v2/invites')).status, 401, 'invites need a session');
  });

  test('device ids and keys are checked; web- ids are kept for the web', async () => {
    const t = await ready();
    const inv = async () => (await t.web.post('/api/v2/invites')).body.invite;
    const k = p256();
    const post = async (body) => (await fetch(t.base + '/api/v2/devices', { method: 'POST', headers: { 'X-Forwarded-For': freshIp() }, body: JSON.stringify(body) })).status;
    assert.equal(await post({ invite: await inv(), device: 'web-webAAAAAAAA', name: 'x', pub: k.pub }), 400);
    assert.equal(await post({ invite: await inv(), device: '../x', name: 'x', pub: k.pub }), 400);
    assert.equal(await post({ invite: await inv(), device: 'abc', name: 'x', pub: b64u(randomBytes(91)) }), 400);
    // An RSA key isn't a P-256 key.
    assert.equal(await post({ invite: await inv(), device: 'abc', name: 'x', pub: 'MCowBQYDK2VwAyEA' + 'A'.repeat(43) + '=' }), 400);
    // A raw 65-byte point is fine too.
    const raw = k.privateKey.export({ format: 'jwk' });
    const point = Buffer.concat([Buffer.from([4]), Buffer.from(raw.x, 'base64url'), Buffer.from(raw.y, 'base64url')]);
    assert.equal(await post({ invite: await inv(), device: 'rawkey', name: '  Lexi‮\u0000 phone  ', pub: point.toString('base64') }), 200);
    const list = (await t.web.get('/api/v2/devices')).body.devices;
    const raw1 = list.find((d) => d.device === 'rawkey');
    assert.equal(raw1.name, 'Lexi phone');
    assert.equal(raw1.seen, raw1.lastSeen);
  });

  test('signed requests: a bad, replayed, or altered request is refused', async () => {
    const t = await ready();
    const p = t.phone;
    assert.equal((await p.get('/api/v2/files')).status, 200);
    const h = p.authHeader('GET', '/api/v2/files', undefined);
    assert.equal((await p.req('GET', '/api/v2/files', { header: h })).status, 200);
    const replay = await p.req('GET', '/api/v2/files', { header: h });
    assert.equal(replay.status, 401);
    assert.equal(replay.body.error, 'replay');
    // Signed for another path, another body, another method.
    assert.equal((await p.req('GET', '/api/v2/activity', { header: p.authHeader('GET', '/api/v2/files') })).status, 401);
    const body = sealed();
    assert.equal((await p.req('PUT', `/api/v2/files/restock-sync-${p.device}.bin`, { body, header: p.authHeader('PUT', `/api/v2/files/restock-sync-${p.device}.bin`, sealed()) })).status, 401);
    assert.equal((await p.req('DELETE', '/api/v2/files/x', { header: p.authHeader('GET', '/api/v2/files/x') })).status, 401);
    // The query is signed too.
    assert.equal((await p.req('GET', '/api/v2/files?x=1', { header: p.authHeader('GET', '/api/v2/files?x=2') })).status, 401);
    // Another phone's key, garbage, and an unknown phone.
    const other = t.mkPhone({ device: p.device });
    assert.equal((await other.get('/api/v2/files')).status, 401);
    assert.equal((await p.req('GET', '/api/v2/files', { header: 'Restock2 d=' + p.device + ', t=1, n=x, s=y' })).status, 401);
    assert.equal((await p.req('GET', '/api/v2/files', { header: 'Bearer abc' })).status, 401);
    const stranger = await t.mkPhone().get('/api/v2/files');
    assert.equal(stranger.status, 401);
    assert.equal(stranger.body.error, 'auth');
  });

  test("clock skew: 401 clock with the server's time, and the retry works", async () => {
    const t = await ready();
    const p = t.phone;
    const ahead = p.authHeader('GET', '/api/v2/files', undefined, { t: t.now() + LIMITS.skewMs + 60_000 });
    const r = await p.req('GET', '/api/v2/files', { header: ahead });
    assert.equal(r.status, 401);
    assert.equal(r.body.error, 'clock');
    const serverTime = Number(r.headers.get('x-restock-time'));
    assert.ok(Math.abs(serverTime - t.now()) < 5000);
    // A phone whose clock is 20 minutes slow: the client retries once with the offset.
    const slow = new Phone(t.base, { device: p.device, clock: () => t.now() - 20 * 60_000 });
    slow.keys = p.keys;
    assert.equal((await slow.get('/api/v2/files')).status, 200);
    assert.ok(slow.skew > 19 * 60_000);
    // Within 5 minutes is fine without a retry.
    assert.equal((await p.req('GET', '/api/v2/files', { header: p.authHeader('GET', '/api/v2/files', undefined, { t: t.now() - 4 * 60_000 }) })).status, 200);
  });

  test('a nonce is remembered for the whole clock window', async () => {
    const t = await ready();
    const p = t.phone;
    const ts = t.now() + 4 * 60_000;
    const h = p.authHeader('GET', '/api/v2/files', undefined, { t: ts });
    assert.equal((await p.req('GET', '/api/v2/files', { header: h })).status, 200);
    t.clock.shift += 8 * 60_000; // still within 5 minutes of ts
    assert.equal((await p.req('GET', '/api/v2/files', { header: h })).status, 401);
  });

  test('phones list; a phone removes itself, or the web removes one; removed phones are told so', async () => {
    const t = await ready();
    const b = t.mkPhone({ name: 'Tablet' });
    assert.equal((await b.join((await t.web.post('/api/v2/invites')).body.invite)).status, 200);
    let list = (await t.web.get('/api/v2/devices')).body.devices;
    assert.deepEqual(list.map((d) => d.name).sort(), ['Kitchen phone', 'Tablet']);
    assert.ok(list.every((d) => d.lastSeen && d.added));
    assert.ok(!JSON.stringify(list).includes(t.phone.keys.pub), 'no keys in the list');
    assert.equal((await t.phone.get('/api/v2/devices')).status, 403, 'the list is for the web page');
    assert.equal((await t.phone.req('DELETE', '/api/v2/devices/' + b.device)).status, 403, 'not another phone');
    assert.equal((await b.req('DELETE', '/api/v2/devices/' + b.device)).status, 200);
    const gone = await b.get('/api/v2/files');
    assert.equal(gone.status, 401);
    assert.equal(gone.body.error, 'removed');
    assert.equal((await t.web.req('DELETE', '/api/v2/devices/' + t.phone.device)).status, 200);
    assert.equal((await t.phone.get('/api/v2/files')).status, 401);
    assert.equal((await t.web.req('DELETE', '/api/v2/devices/' + t.phone.device)).status, 404);
    list = (await t.web.get('/api/v2/devices')).body.devices;
    assert.equal(list.length, 0);
    // Re-adding works.
    assert.equal((await b.join((await t.web.post('/api/v2/invites')).body.invite)).status, 200);
    assert.equal((await b.get('/api/v2/files')).status, 200);
  });

  test('phones can read the web key registry (for webkeys/), sessions get more', async () => {
    const t = await ready();
    const r = await t.phone.get('/api/v2/web');
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { webId: 'webAAAAAAAA', webPub: t.webKey.pub, webs: [{ webId: 'webAAAAAAAA', webPub: t.webKey.pub }] });
    assert.equal((await t.phone.req('PUT', '/api/v2/web', { json: { webId: 'webZZZZZZZZ', webPub: p256().pub } })).status, 403);
  });
});

describe('files', () => {
  test('a phone writes its own files and reads everyone\'s', async () => {
    const t = await ready();
    const p = t.phone;
    const body = sealed({ device: p.device, entries: [] });
    const w = await p.put(`restock-sync-${p.device}.bin`, body);
    assert.equal(w.status, 200);
    assert.match(w.body.version, /^\d+:\d+$/);
    assert.equal(w.body.by, p.device);
    for (const name of [`archive/${p.device}/2026-10.bin`, `photos/${'ab'.repeat(32)}.bin`, 'restock-sync-keys-h1.json', 'webkeys/webAAAAAAAA.bin']) {
      const b = name.endsWith('.json') ? Buffer.from('{"format":"restock-sync-keys"}') : name.startsWith('webkeys/') ? seal(randomBytes(32), {}, 'RSE2') : sealed();
      assert.equal((await p.put(name, b)).status, 200, name);
    }
    // Slashes may be sent encoded too.
    assert.equal((await p.put(encodeURIComponent(`archive/${p.device}/2026-11.bin`), sealed())).status, 200);
    const list = (await p.get('/api/v2/files')).body.files;
    assert.deepEqual(
      list.map((f) => f.name),
      [`archive/${p.device}/2026-10.bin`, `archive/${p.device}/2026-11.bin`, `photos/${'ab'.repeat(32)}.bin`, 'restock-sync-keys-h1.json', `restock-sync-${p.device}.bin`, 'webkeys/webAAAAAAAA.bin'].sort((a, b) => a.localeCompare(b)),
    );
    const mine = list.find((f) => f.name === `restock-sync-${p.device}.bin`);
    assert.equal(mine.version, w.body.version, 'offload: the listing shows the version the upload returned');
    assert.equal(mine.size, body.length);
    assert.equal(mine.by, p.device);
    const back = await t.web.raw('GET', `/api/v2/files/restock-sync-${p.device}.bin`);
    assert.equal(back.status, 200);
    assert.equal(back.headers.get('content-type'), 'application/octet-stream');
    assert.equal(back.headers.get('x-restock-version'), w.body.version);
    assert.deepEqual(Buffer.from(await back.arrayBuffer()), body);
    // Not changed: 304.
    const etag = back.headers.get('etag');
    assert.equal((await t.web.raw('GET', `/api/v2/files/restock-sync-${p.device}.bin`, { headers: { 'If-None-Match': etag } })).status, 304);
    assert.equal((await p.get('/api/v2/files/restock-sync-nobody.bin')).status, 404);
    // Nothing half-written is left about.
    assert.deepEqual(readdirSync(join(t.dir, 'tmp')), []);
  });

  test("a phone can't write another phone's files", async () => {
    const t = await ready();
    const other = t.mkPhone();
    await other.join((await t.web.post('/api/v2/invites')).body.invite);
    await other.put(`restock-sync-${other.device}.bin`, sealed());
    for (const name of [`restock-sync-${other.device}.bin`, `archive/${other.device}/2026-10.bin`, 'restock-sync-web-webAAAAAAAA.bin']) {
      const r = await t.phone.put(name, sealed());
      assert.equal(r.status, 403, name);
    }
    assert.equal((await t.phone.req('DELETE', `/api/v2/files/restock-sync-${other.device}.bin`)).status, 403);
    assert.equal((await other.req('DELETE', `/api/v2/files/restock-sync-${other.device}.bin`)).status, 200);
  });

  test('the web session writes only restock-sync-web-<its webId>.bin', async () => {
    const t = await ready();
    const own = await t.web.req('PUT', '/api/v2/files/restock-sync-web-webAAAAAAAA.bin', { body: sealed() });
    assert.equal(own.status, 200);
    assert.equal(own.body.by, 'web-webAAAAAAAA');
    for (const name of [`restock-sync-${t.phone.device}.bin`, 'restock-sync-web-webBBBBBBBB.bin', `archive/${t.phone.device}/2026-10.bin`, `photos/${'cd'.repeat(32)}.bin`, 'webkeys/webAAAAAAAA.bin', 'restock-sync-keys-h1.json']) {
      const r = await t.web.req('PUT', '/api/v2/files/' + name, { body: name.endsWith('.json') ? '{}' : sealed() });
      assert.equal(r.status, 403, name);
    }
    assert.equal((await t.web.req('DELETE', `/api/v2/files/restock-sync-${t.phone.device}.bin`)).status, 403);
    assert.equal((await t.web.get('/api/v2/files')).status, 200);
    // Without a registered webId there's nothing it can write.
    const u = await start();
    const b = u.browser();
    await b.setup({ passphrase: PASS, iterations: ITER });
    assert.equal((await b.req('PUT', '/api/v2/files/restock-sync-web-.bin', { body: sealed() })).status, 403);
    assert.equal((await b.req('PUT', '/api/v2/files/restock-sync-web-webAAAAAAAA.bin', { body: sealed() })).status, 403);
  });

  test('name rules: anything else is refused', async () => {
    const t = await ready();
    const bad = [
      'evil.txt', '..%2Fetc%2Fpasswd', '%2E%2E%2Fstate.json', 'restock-sync-.bin', 'restock-sync-a b.bin', 'restock-sync-a.json', 'restock-sync-keys-h1.bin.json',
      `archive/${t.phone.device}/2026-13.bin`, `archive/${t.phone.device}/26-01.bin`, `archive/${t.phone.device}/2026-01.json`, 'archive/2026-01.bin',
      `photos/${'AB'.repeat(32)}.bin`, `photos/${'ab'.repeat(31)}.bin`, 'photos/x.bin', 'webkeys/short.bin', 'webkeys/a/b.bin', 'state.json', 'tmp/x.bin', '%ZZ',
    ];
    for (const name of bad) {
      const r = await t.phone.put(name, sealed());
      assert.equal(r.status, 400, name);
      assert.equal(r.body.error, 'name', name);
    }
    assert.equal(parseName('restock-sync-keys-h1.json').kind, 'keys');
    assert.equal(parseName('restock-sync-web-abc.bin').owner, 'web-abc');
  });

  test('bodies must be sealed (RSF1, RSE2 for webkeys) or JSON', async () => {
    const t = await ready();
    const p = t.phone;
    const cases = [
      [`restock-sync-${p.device}.bin`, Buffer.from('plain text, not sealed at all, no no no')],
      [`restock-sync-${p.device}.bin`, Buffer.from('RSF1short')],
      [`restock-sync-${p.device}.bin`, seal(randomBytes(32), {}, 'RSE2')],
      ['webkeys/webAAAAAAAA.bin', sealed()],
      ['restock-sync-keys-h1.json', Buffer.from('not json')],
      ['restock-sync-keys-h1.json', Buffer.from('[1,2]')],
    ];
    for (const [name, body] of cases) assert.equal((await p.put(name, body)).status, 400, name);
  });

  test('size caps: per file and per volume', async () => {
    const t = await ready({ maxFileMb: 1, maxTotalMb: 1 });
    const p = t.phone;
    const big = Buffer.concat([Buffer.from('RSF1'), randomBytes(1024 * 1024)]);
    const r = await p.put(`restock-sync-${p.device}.bin`, big);
    assert.equal(r.status, 413);
    const half = () => Buffer.concat([Buffer.from('RSF1'), randomBytes(600 * 1024)]);
    assert.equal((await p.put(`archive/${p.device}/2026-01.bin`, half())).status, 200);
    const full = await p.put(`archive/${p.device}/2026-02.bin`, half());
    assert.equal(full.status, 507);
    assert.equal(full.body.error, 'full');
    // Replacing a file only counts the difference.
    assert.equal((await p.put(`archive/${p.device}/2026-01.bin`, half())).status, 200);
    assert.equal((await p.req('DELETE', `/api/v2/files/archive/${p.device}/2026-01.bin`)).status, 200);
    // A deleted archive stays in the trash for 30 days, and still counts.
    assert.equal((await p.put(`archive/${p.device}/2026-02.bin`, half())).status, 507);
    t.clock.shift += (LIMITS.trashDays + 1) * 24 * 3600_000;
    assert.equal((await p.put(`archive/${p.device}/2026-02.bin`, half())).status, 200);
    // JSON requests have their own small cap.
    assert.equal((await t.web.req('PUT', '/api/v2/vault', { body: 'x'.repeat(LIMITS.maxJson + 10), headers: { 'Content-Type': 'application/json' } })).status, 413);
  });

  test('files need a phone or a session', async () => {
    const t = await ready();
    const b = t.browser();
    assert.equal((await b.get('/api/v2/files')).status, 401);
    assert.equal((await b.get(`/api/v2/files/restock-sync-${t.phone.device}.bin`)).status, 401);
    assert.equal((await b.req('PUT', '/api/v2/files/restock-sync-web-webAAAAAAAA.bin', { body: sealed() })).status, 401);
  });
});

describe('linking the web, and signing in with a phone', () => {
  test('link: one phone answers once; only the browser that asked reads it, once', async () => {
    const t = await ready();
    const l = await t.web.post('/api/v2/link');
    assert.equal(l.status, 200);
    const { id } = l.body;
    assert.equal((await t.web.get('/api/v2/link/' + id)).body.pending, true);
    const eph = p256();
    const sealedAnswer = b64u(randomBytes(120));
    assert.equal((await t.phone.req('POST', '/api/v2/link/' + id, { json: { pub: eph.pub, sealed: sealedAnswer } })).status, 200);
    assert.equal((await t.phone.req('POST', '/api/v2/link/' + id, { json: { pub: eph.pub, sealed: sealedAnswer } })).status, 409, 'one answer');
    const other = t.browser();
    await other.login('admin', PASS, ITER);
    assert.equal((await other.get('/api/v2/link/' + id)).status, 404, "another browser can't read it");
    const done = await t.web.get('/api/v2/link/' + id);
    assert.equal(done.body.status, 'done');
    assert.equal(done.body.pub, eph.pub);
    assert.equal(done.body.sealed, sealedAnswer);
    assert.equal(done.body.device, t.phone.device);
    assert.equal(done.body.deviceName, 'Kitchen phone');
    assert.equal((await t.web.get('/api/v2/link/' + id)).status, 404, 'read once');
    // Only phones answer, and only signed.
    const id2 = (await t.web.post('/api/v2/link')).body.id;
    assert.equal((await t.web.post('/api/v2/link/' + id2, { pub: eph.pub, sealed: sealedAnswer })).status, 403);
    assert.equal((await t.browser().post('/api/v2/link/' + id2, { pub: eph.pub, sealed: sealedAnswer })).status, 401);
    assert.equal((await t.phone.req('POST', '/api/v2/link/' + id2, { json: { pub: 'nope', sealed: sealedAnswer } })).status, 400);
    assert.equal((await t.phone.req('POST', '/api/v2/link/' + id2, { json: { pub: eph.pub, sealed: b64u(randomBytes(LIMITS.maxSealed + 1)) } })).status, 400);
    // Expiry.
    t.clock.shift += LIMITS.linkMs + 1000;
    assert.equal((await t.phone.req('POST', '/api/v2/link/' + id2, { json: { pub: eph.pub, sealed: sealedAnswer } })).status, 410);
    assert.equal((await t.web.get('/api/v2/link/' + id2)).status, 404);
  });

  test('sign in with a phone: only the asking browser gets the session; one use; 2 minutes', async () => {
    const t = await ready();
    const b = t.browser();
    const q = await b.post('/api/v2/qrlogin');
    assert.equal(q.status, 200);
    assert.equal(q.body.expiresIn, 120);
    assert.ok(b.cookie('restock_qr'), 'a poll cookie, so someone who sees the QR code cannot take the session');
    const waiting = (await b.get('/api/v2/qrlogin/' + q.body.id)).body;
    assert.equal(waiting.status, 'waiting');
    assert.equal(waiting.pending, true);
    const eph = p256();
    const answer = { pub: eph.pub, sealed: b64u(randomBytes(100)) };
    assert.equal((await t.phone.req('POST', '/api/v2/qrlogin/' + q.body.id, { json: answer })).status, 200);
    assert.equal((await t.phone.req('POST', '/api/v2/qrlogin/' + q.body.id, { json: answer })).status, 409);
    const thief = t.browser();
    assert.equal((await thief.get('/api/v2/qrlogin/' + q.body.id)).status, 404);
    const done = await b.get('/api/v2/qrlogin/' + q.body.id);
    assert.equal(done.status, 200);
    assert.equal(done.body.status, 'done');
    assert.equal(done.body.sealed, answer.sealed);
    assert.ok(b.cookie('restock_session'));
    assert.equal((await b.get('/api/v2/qrlogin/' + q.body.id)).status, 404, 'once');
    assert.equal(done.body.pending, false);
    // What this session can do: read, write the web's file (the household's webId), add a phone.
    const web = (await b.get('/api/v2/web')).body;
    assert.equal(web.user, 'admin');
    assert.equal(web.webId, 'webAAAAAAAA');
    assert.equal(web.session.kind, 'phone');
    assert.equal(web.session.approvedBy, t.phone.device);
    assert.equal(web.session.webId, 'webAAAAAAAA');
    assert.equal(done.body.webId, 'webAAAAAAAA');
    assert.equal((await b.get('/api/v2/files')).status, 200);
    assert.equal((await b.req('PUT', '/api/v2/files/restock-sync-web-webAAAAAAAA.bin', { body: sealed() })).status, 200);
    assert.equal((await b.req('PUT', '/api/v2/files/restock-sync-web-webBBBBBBBB.bin', { body: sealed() })).status, 403);
    assert.equal((await b.post('/api/v2/invites')).status, 200);
    // ...but not the vault, the web key or linking, which need the passphrase.
    assert.equal((await b.put('/api/v2/vault', { vault: vault(randomBytes(32), {}) })).status, 403);
    assert.equal((await b.put('/api/v2/web', { webId: 'webQQQQQQQQ', webPub: p256().pub })).status, 403);
    assert.equal((await b.post('/api/v2/link')).status, 403);
    // Removing the phone that approved it signs that browser out.
    await t.web.req('DELETE', '/api/v2/devices/' + t.phone.device);
    assert.equal((await b.get('/api/v2/files')).status, 401);
  });

  test('sign-in codes expire after 2 minutes and are rate-limited', async () => {
    const t = await ready();
    const b = t.browser();
    const q = (await b.post('/api/v2/qrlogin')).body;
    t.clock.shift += LIMITS.qrLoginMs + 1000;
    assert.equal((await t.phone.req('POST', '/api/v2/qrlogin/' + q.id, { json: { pub: p256().pub, sealed: b64u(randomBytes(60)) } })).status, 410);
    const c = t.browser();
    for (let i = 0; i < LIMITS.qrLoginsPer10Min; i++) assert.equal((await c.post('/api/v2/qrlogin')).status, 200);
    assert.equal((await c.post('/api/v2/qrlogin')).status, 429);
  });
});

describe('sessions, sign out everywhere, activity, state', () => {
  test('sign out, and sign out everywhere (the web app moves to a new webId first)', async () => {
    const t = await ready();
    const second = t.browser();
    await second.login('admin', PASS, ITER);
    const third = t.browser();
    await third.login('admin', PASS, ITER);
    assert.equal((await third.post('/api/v2/logout')).status, 200);
    assert.equal((await third.get('/api/v2/files')).status, 401);
    assert.equal((await second.get('/api/v2/files')).status, 200, 'one sign-out leaves the others');
    assert.equal((await t.browser().post('/api/v2/logout', { everywhere: true })).status, 401);
    // As the web app does it: a new webId and key in the vault, then sign out everywhere.
    const k = p256();
    const vk = (await t.web.login('admin', PASS, ITER)).vaultKey;
    assert.equal((await t.web.put('/api/v2/vault', { vault: vault(vk, {}), webId: 'webEEEEEEEE', webPub: k.pub })).status, 200);
    assert.equal((await t.web.post('/api/v2/logout', { everywhere: true })).status, 200);
    const r = await second.get('/api/v2/files');
    assert.equal(r.status, 401);
    assert.equal(r.body.error, 'signed-out');
    assert.equal((await t.web.get('/api/v2/files')).status, 401);
    // Phones carry on, and see the new web key.
    assert.deepEqual((await t.phone.get('/api/v2/web')).body.webs, [{ webId: 'webEEEEEEEE', webPub: k.pub }]);
    assert.equal((await t.phone.get('/api/v2/files')).status, 200);
    const back = t.browser();
    await back.login('admin', PASS, ITER);
    assert.equal((await back.put('/api/v2/web', { webId: 'webAAAAAAAA', webPub: p256().pub })).status, 400, 'the old webId is retired');
    assert.equal((await back.put('/api/v2/vault', { vault: vault(vk, {}), webId: 'webAAAAAAAA', webPub: p256().pub })).status, 400);
    assert.equal((await back.put('/api/v2/vault', { vault: vault(vk, {}), webId: 'webEEEEEEEE', webPub: k.pub })).status, 200, 'the current one is fine');
    assert.equal((await back.req('PUT', '/api/v2/files/restock-sync-web-webEEEEEEEE.bin', { body: sealed() })).status, 200);
    assert.equal((await back.req('PUT', '/api/v2/files/restock-sync-web-webAAAAAAAA.bin', { body: sealed() })).status, 403);
  });

  test('sessions expire after 30 days unused', async () => {
    const t = await ready();
    t.clock.shift += 29 * 24 * 3600_000;
    assert.equal((await t.web.get('/api/v2/files')).status, 200);
    t.clock.shift += 29 * 24 * 3600_000;
    assert.equal((await t.web.get('/api/v2/files')).status, 200, 'used, so it carries on');
    t.clock.shift += 31 * 24 * 3600_000;
    const r = await t.web.get('/api/v2/files');
    assert.equal(r.status, 401);
    assert.equal(r.body.error, 'signed-out');
  });

  test('the activity log says who did what, never contents or secrets', async () => {
    const t = await ready();
    const body = sealed({ secret: 'MILK-2L' });
    await t.phone.put(`restock-sync-${t.phone.device}.bin`, body);
    await t.web.get(`/api/v2/files/restock-sync-${t.phone.device}.bin`);
    await t.browser().login('admin', 'wrong wrong wrong wrong', ITER);
    const a = await t.web.get('/api/v2/activity');
    assert.equal(a.status, 200);
    const what = a.body.activity.map((x) => x.what);
    for (const w of ['upload', 'fetch', 'phone-added', 'invite-made', 'login', 'login-failed', 'passphrase-set']) assert.ok(what.includes(w), w);
    const up = a.body.activity.find((x) => x.what === 'upload');
    assert.equal(up.by, t.phone.device);
    assert.equal(up.size, body.length);
    assert.equal(a.body.devices[t.phone.device], 'Kitchen phone');
    assert.equal(up.who, 'Kitchen phone');
    assert.equal(up.device, t.phone.device);
    assert.equal(a.body.activity.find((x) => x.what === 'login-failed').ip.endsWith('.x'), true, 'addresses are masked');
    assert.equal((await t.phone.get('/api/v2/activity')).status, 403);
    // Nothing secret on disk outside state.json's hashes.
    const log = readFileSync(join(t.dir, 'activity.jsonl'), 'utf8');
    const state = readFileSync(join(t.dir, 'state.json'), 'utf8');
    const cookie = t.web.cookie('restock_session');
    for (const secret of [cookie, PASS, 'MILK-2L', derive(PASS, JSON.parse(state).account.salt, ITER).auth]) {
      assert.ok(!log.includes(secret), 'log: ' + secret);
      assert.ok(!state.includes(secret), 'state: ' + secret);
    }
  });

  test('state survives a restart; reset-passphrase clears the web side and keeps the phones', async () => {
    const t = await ready();
    await t.phone.put(`restock-sync-${t.phone.device}.bin`, sealed());
    await stop(t);
    const u = await start({}, t.dir);
    const web = new Browser(u.base, { ip: freshIp() });
    web.jar = t.web.jar;
    assert.equal((await web.get('/api/v2/files')).status, 200, 'still signed in');
    const phone = new Phone(u.base, { device: t.phone.device, clock: u.now });
    phone.keys = t.phone.keys;
    const list = (await phone.get('/api/v2/files')).body.files;
    assert.equal(list[0].by, t.phone.device);
    await stop(u);
    writeFileSync(join(t.dir, 'reset-passphrase'), '');
    const v = await start({}, t.dir);
    assert.ok(v.wasReset);
    assert.ok(!existsSync(join(t.dir, 'reset-passphrase')));
    web.base = v.base;
    phone.base = v.base;
    assert.equal((await web.get('/api/v2/files')).status, 401, 'signed out');
    assert.equal((await phone.get('/api/v2/files')).status, 200, 'phones carry on');
    assert.equal((await new Browser(v.base).raw('GET', '/')).headers.get('location'), '/setup/');
    const b = new Browser(v.base, { ip: freshIp() });
    await b.setup({ passphrase: 'new words for a new start', iterations: ITER, webId: 'webAAAAAAAA', webPub: p256().pub }).then(
      () => assert.fail('the old webId is retired'),
      () => {},
    );
    await b.setup({ passphrase: 'new words for a new start', iterations: ITER });
  });
});

describe('the setup page code', () => {
  test("its PBKDF2 matches Node's", () => {
    for (const [pass, salt, iter, len] of [
      ['kettle orbit lemon fence', randomBytes(16), 1, 64],
      ['ünïcødé pass phrase ok', randomBytes(16), 1000, 64],
      ['x'.repeat(100), randomBytes(32), 7, 33],
      ['', Buffer.alloc(0), 2, 32],
    ]) {
      const a = Buffer.from(pbkdf2Js(new TextEncoder().encode(pass.normalize('NFKC')), new Uint8Array(salt), iter, len));
      const b = pbkdf2Sync(Buffer.from(pass.normalize('NFKC')), salt, iter, len, 'sha256');
      assert.deepEqual(a, b);
    }
    assert.equal(Buffer.from(jsSha256(new TextEncoder().encode('abc'))).toString('hex'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  test('passphrase rules', () => {
    assert.equal(checkPassphrase('kettle orbit lemon fence').ok, true);
    assert.equal(checkPassphrase('a-long-enough-single-thing!').ok, true);
    assert.equal(checkPassphrase('short one').ok, false);
    assert.equal(checkPassphrase('admin').ok, false);
    assert.equal(checkPassphrase('admin admin admin admin admin').ok, false);
    assert.equal(checkPassphrase('sarah', 'sarah').ok, false);
    assert.equal(checkPassphrase('correct horse battery staple').ok, false);
    assert.equal(checkPassphrase('passwordpasswordpassword').ok, false);
    assert.equal(checkPassphrase('aaaaaaaaaaaaaaaaaaaaaaaaa').ok, false);
    assert.equal(checkPassphrase('abcabcabcabcabcabcabcabc').ok, false);
    assert.equal(checkPassphrase('one one two one').ok, false);
    assert.ok(checkPassphrase('paddock wombat silver anchor tram').score >= 3);
  });
});

// ---------------------------------------------------------------------------------------------
// From the 0.9.2 security review: each of these failed before its fix.

describe('security review', () => {
  const currentAuth = async (t, b = t.web) => derive(PASS, (await b.get('/api/v2/login/salt?user=admin')).body.salt, ITER).auth;
  const newPassphrase = (words = 'paddock wombat silver anchor') => {
    const salt = b64u(randomBytes(16));
    return { salt, auth: derive(words, salt, ITER).auth };
  };

  test('a browser signed in with a phone can neither set a new passphrase nor fetch the vault', async () => {
    const t = await ready();
    const b = t.browser();
    const q = (await b.post('/api/v2/qrlogin')).body;
    await t.phone.req('POST', '/api/v2/qrlogin/' + q.id, { json: { pub: p256().pub, sealed: b64u(randomBytes(60)) } });
    assert.equal((await b.get('/api/v2/qrlogin/' + q.id)).body.status, 'done');
    const r = await b.post('/api/v2/passphrase', { ...newPassphrase(), current: await currentAuth(t, b) });
    assert.equal(r.status, 403);
    assert.equal(r.body.error, 'passphrase');
    assert.equal((await b.get('/api/v2/vault')).status, 403);
    assert.equal((await t.browser().login('admin', PASS, ITER)).status, 200, 'the passphrase is unchanged');
  });

  test('a new passphrase needs the current one (a stolen session cookie is not enough)', async () => {
    const t = await ready();
    const thief = new Browser(t.base, { ip: freshIp() });
    thief.jar = new Map(t.web.jar);
    const np = newPassphrase();
    let r = await thief.post('/api/v2/passphrase', np);
    assert.equal(r.status, 400);
    assert.equal(r.body.error, 'current');
    r = await thief.post('/api/v2/passphrase', { ...np, current: b64u(randomBytes(32)) });
    assert.equal(r.status, 403);
    assert.equal(r.body.error, 'current');
    assert.equal((await t.web.get('/api/v2/files')).status, 200, 'nobody was signed out');
    assert.equal((await t.browser().login('admin', PASS, ITER)).status, 200, 'the passphrase is unchanged');
    // Wrong guesses count towards the lockout.
    for (let i = 0; i < LIMITS.failsBeforeLockout; i++) await thief.post('/api/v2/passphrase', { ...np, current: b64u(randomBytes(32)) });
    assert.equal((await thief.post('/api/v2/passphrase', { ...np, current: await currentAuth(t) })).status, 429);
    // With the real one, from the owner's browser, it works.
    assert.equal((await t.web.post('/api/v2/passphrase', { ...np, current: await currentAuth(t) })).status, 200);
  });

  test('setting the passphrase gives the browser a new session cookie; the setup one stops working', async () => {
    const t = await start();
    const b = t.browser();
    await b.post('/api/v2/login', { user: 'admin', password: 'admin' });
    const setupCookie = b.cookie('restock_session');
    const sniffer = new Browser(t.base, { ip: freshIp() });
    sniffer.jar.set('restock_session', setupCookie);
    const r = await b.raw('POST', '/api/v2/passphrase', { json: newPassphrase(PASS) });
    assert.equal(r.status, 200);
    assert.match(r.headers.get('set-cookie'), /Max-Age=2592000/, 'a 30-day cookie, not the setup one-hour one');
    assert.notEqual(b.cookie('restock_session'), setupCookie);
    assert.equal((await b.get('/api/v2/files')).status, 200, 'this browser carries on');
    assert.equal((await sniffer.get('/api/v2/files')).status, 401, 'the setup cookie is no good any more');
  });

  test('the compose file\'s placeholder password counts as a known one: first login only from home', async () => {
    assert.ok(isKnownPassword('change-me-now'));
    assert.ok(isKnownPassword('admin'));
    assert.ok(!isKnownPassword('a5Gq-first-start-9'));
    const t = await start({ password: 'change-me-now' });
    const away = await t.browser({ ip: '203.0.113.9' }).post('/api/v2/login', { user: 'admin', password: 'change-me-now' });
    assert.equal(away.status, 403);
    assert.equal(away.body.error, 'setup-remote');
    assert.equal((await t.browser().post('/api/v2/login', { user: 'admin', password: 'change-me-now' })).status, 200, 'from home it works');
  });

  test('an upload from nobody is refused before its body is read', async () => {
    const t = await start();
    const status = await new Promise((ok, no) => {
      const req = request(t.base + '/api/v2/files/restock-sync-abc.bin', { method: 'PUT', headers: { 'Content-Length': 30 * 1024 * 1024 } }, (r) => {
        r.resume();
        ok(r.statusCode);
        req.destroy();
      });
      req.on('error', () => {});
      req.flushHeaders();
      setTimeout(() => no(new Error('the server waited for the 30 MB body')), 3000);
    });
    assert.equal(status, 401);
  });

  test('bodies held in memory at once are capped', async () => {
    const t = await ready();
    const was = LIMITS.maxInFlightBytes;
    LIMITS.maxInFlightBytes = 1000;
    try {
      const r = await t.phone.put(`restock-sync-${t.phone.device}.bin`, sealed({ big: 'x'.repeat(4000), r: b64u(randomBytes(3000)) }));
      assert.equal(r.status, 503);
      assert.equal(r.body.error, 'busy');
    } finally {
      LIMITS.maxInFlightBytes = was;
    }
    assert.equal((await t.phone.put(`restock-sync-${t.phone.device}.bin`, sealed())).status, 200, 'and released after');
  });

  test('a page on another port of the same computer (plain http, no Sec-Fetch-Site) can\'t post with the session', async () => {
    const t = await ready();
    for (const type of ['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=x']) {
      const r = await t.web.req('POST', '/api/v2/logout', { body: '{"everywhere":true}', headers: { 'Content-Type': type } });
      assert.equal(r.status, 415, type);
    }
    assert.equal((await t.web.req('POST', '/api/v2/invites', { body: '{}' })).status, 415, 'no type at all');
    assert.equal((await t.web.get('/api/v2/files')).status, 200, 'still signed in');
    assert.equal((await t.web.post('/api/v2/invites')).status, 200, 'JSON, as the web app sends, is fine');
  });

  test('device ids like __proto__ and constructor are only names', async () => {
    const t = await ready();
    for (const id of ['constructor', 'toString', 'hasOwnProperty']) {
      const r = await new Phone(t.base, { device: id, ip: freshIp() }).get('/api/v2/files');
      assert.equal(r.status, 401, id);
      assert.equal(r.body.error, 'auth', id);
    }
    const p = new Phone(t.base, { device: '__proto__', ip: freshIp() });
    assert.equal((await p.join((await t.web.post('/api/v2/invites')).body.invite)).status, 200);
    assert.equal((await p.get('/api/v2/files')).status, 200);
    assert.ok((await t.web.get('/api/v2/devices')).body.devices.some((d) => d.device === '__proto__'));
    assert.equal(Object.getPrototypeOf(t.state.devices), null);
    await t.flush();
    assert.ok(JSON.parse(readFileSync(join(t.dir, 'state.json'), 'utf8')).devices.__proto__?.pub, 'saved as an ordinary key');
    // ...and it comes back after a restart.
    await stop(t);
    const u = await start({}, t.dir);
    const again = new Phone(u.base, { device: '__proto__', clock: u.now, ip: freshIp() });
    again.keys = p.keys;
    assert.equal((await again.get('/api/v2/files')).status, 200);
  });

  test('links in the data volume: never followed out of the files folder', async () => {
    const t = await ready();
    const outside = mkdtempSync(join(tmpdir(), 'restock-outside-'));
    writeFileSync(join(outside, 'secret.txt'), 'NOT-FOR-YOU-' + 'x'.repeat(40));
    try {
      const hex = 'a'.repeat(64);
      mkdirSync(join(t.dir, 'files', 'photos'), { recursive: true });
      symlinkSync(join(outside, 'secret.txt'), join(t.dir, 'files', 'photos', hex + '.bin'));
      const r = await t.phone.get(`/api/v2/files/photos/${hex}.bin`);
      assert.equal(r.status, 404);
      assert.ok(!(await t.web.get('/api/v2/files')).body.files.some((f) => f.name.includes(hex)), 'not listed');
      // A linked folder: nothing is written through it.
      mkdirSync(join(t.dir, 'files', 'archive'), { recursive: true });
      symlinkSync(outside, join(t.dir, 'files', 'archive', t.phone.device));
      const w = await t.phone.put(`archive/${t.phone.device}/2026-01.bin`, sealed());
      assert.equal(w.status, 409);
      assert.deepEqual(readdirSync(outside), ['secret.txt']);
      assert.equal((await t.phone.req('DELETE', `/api/v2/files/photos/${hex}.bin`)).status, 404);
      assert.ok(existsSync(join(outside, 'secret.txt')));
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test('lockouts count an IPv6 /64 as one address', async () => {
    assert.equal(limitKey('2001:db8:1:2:aaaa::1'), '2001:0db8:0001:0002::/64');
    assert.equal(limitKey('2001:db8:1:2::ffff'), limitKey('2001:0db8:0001:0002:9:8:7:6'));
    assert.notEqual(limitKey('2001:db8:1:3::1'), limitKey('2001:db8:1:2::1'));
    assert.equal(limitKey('10.0.0.1'), '10.0.0.1');
    assert.equal(limitKey('::1'), '0000:0000:0000:0000::/64');
    const t = await start({ trustProxy: 'cloudflare' });
    await t.browser().setup({ passphrase: PASS, iterations: ITER });
    for (let i = 0; i < 10; i++) {
      const r = await new Browser(t.base, { headers: { 'CF-Connecting-IP': `2001:db8:1:2::${i + 1}` } }).login('admin', 'wrong wrong wrong wrong', ITER);
      assert.equal(r.status, 401);
    }
    assert.equal((await new Browser(t.base, { headers: { 'CF-Connecting-IP': '2001:db8:1:2:dead:beef:0:1' } }).login('admin', PASS, ITER)).status, 429);
    assert.equal((await new Browser(t.base, { headers: { 'CF-Connecting-IP': '2001:db8:1:3::1' } }).login('admin', PASS, ITER)).status, 200);
  });

  test('proxy headers only count when the connection comes from home', async () => {
    const host = Object.values((await import('node:os')).networkInterfaces())
      .flat()
      .find((i) => i && i.family === 'IPv4' && !i.internal && !isHomeAddress(i.address))?.address;
    if (!host) return; // no public-looking address on this machine to test from
    const PW = 'a5Gq-first-start-9';
    const t = await start({ password: PW }, undefined, host);
    // X-Forwarded-Proto doesn't make the cookie Secure (it would be lost on plain http)...
    const r = await t.browser({ headers: { 'X-Forwarded-Proto': 'https' } }).raw('POST', '/api/v2/login', { json: { user: 'admin', password: PW } });
    assert.equal(r.status, 200);
    assert.doesNotMatch(r.headers.get('set-cookie'), /Secure/);
    await t.browser().setup({ password: PW, passphrase: PASS, iterations: ITER });
    // ...and a made-up X-Forwarded-For doesn't give a fresh address each time.
    for (let i = 0; i < 10; i++) await t.browser().login('admin', 'wrong wrong wrong wrong', ITER);
    assert.equal((await t.browser().login('admin', PASS, ITER)).status, 429);
  });
});

describe('the trash, and phones joining again', () => {
  const trashed = (dir) => {
    const out = [];
    const walk = (d, rel) => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        if (e.isDirectory()) walk(join(d, e.name), rel ? rel + '/' + e.name : e.name);
        else out.push(rel + '/' + e.name);
      }
    };
    if (existsSync(join(dir, 'trash'))) walk(join(dir, 'trash'), '');
    return out;
  };

  test('a deleted archive or photo goes to trash/<when>/<name> for 30 days, never listed', async () => {
    const t = await ready();
    const p = t.phone;
    const arch = sealed({ prices: [1] });
    const photo = `photos/${'ab'.repeat(32)}.bin`;
    await p.put(`archive/${p.device}/2026-01.bin`, arch);
    await p.put(photo, sealed());
    await p.put(`restock-sync-${p.device}.bin`, sealed());
    for (const n of [`archive/${p.device}/2026-01.bin`, photo, `restock-sync-${p.device}.bin`]) assert.equal((await p.req('DELETE', '/api/v2/files/' + n)).status, 200, n);
    const tr = trashed(t.dir);
    assert.equal(tr.length, 2, 'the sync file is simply deleted; archive and photo are kept: ' + tr.join(', '));
    const a = tr.find((x) => x.endsWith(`archive/${p.device}/2026-01.bin`));
    assert.match(a, /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}Z(-[0-9a-f]+)?\/archive\//);
    assert.deepEqual(readFileSync(join(t.dir, 'trash', a)), arch);
    assert.deepEqual((await p.get('/api/v2/files')).body.files, [], 'never listed');
    assert.equal((await p.get('/api/v2/files/' + photo)).status, 404);
    const act = (await t.web.get('/api/v2/activity')).body;
    assert.ok(act.activity.some((x) => x.what === 'trashed' && x.file === photo));
    assert.ok(act.server.trashBytes > 0);
    // Emptied once 30 days have gone (checked at most daily, and at start).
    t.clock.shift += (LIMITS.trashDays + 1) * 24 * 3600_000;
    await stop(t);
    const u = await start({ now: () => Date.now() + t.clock.shift }, t.dir);
    void u;
    assert.deepEqual(trashed(t.dir), []);
  });

  test("another writer replacing an archive or photo: the old one goes to the trash first", async () => {
    const t = await ready();
    const other = t.mkPhone();
    await other.join((await t.web.post('/api/v2/invites')).body.invite);
    const photo = `photos/${'cd'.repeat(32)}.bin`;
    const first = sealed({ data: 'the real photo' });
    await t.phone.put(photo, first);
    await t.phone.put(photo, first); // the same writer, the same bytes: nothing to keep
    assert.deepEqual(trashed(t.dir), []);
    assert.equal((await other.put(photo, sealed({ data: 'something else' }))).status, 200);
    const tr = trashed(t.dir);
    assert.equal(tr.length, 1);
    assert.deepEqual(readFileSync(join(t.dir, 'trash', tr[0])), first);
  });

  test('a phone deletes only its own archive, and only photos it put there itself', async () => {
    const t = await ready();
    const other = t.mkPhone();
    await other.join((await t.web.post('/api/v2/invites')).body.invite);
    await t.phone.put(`archive/${t.phone.device}/2026-01.bin`, sealed());
    const photo = `photos/${'ef'.repeat(32)}.bin`;
    await t.phone.put(photo, sealed());
    assert.equal((await other.req('DELETE', `/api/v2/files/archive/${t.phone.device}/2026-01.bin`)).status, 403);
    // Another phone deleting it lets go of it (200, as phones expect), but the file stays.
    const r = await other.req('DELETE', '/api/v2/files/' + photo);
    assert.equal(r.status, 200);
    assert.equal(r.body.kept, photo);
    assert.equal(r.body.deleted, null);
    assert.equal((await other.get('/api/v2/files/' + photo)).status, 200, 'still there');
    assert.deepEqual(trashed(t.dir), []);
    assert.equal((await t.web.req('DELETE', '/api/v2/files/' + photo)).status, 403, 'the web may not');
    assert.equal((await other.req('DELETE', `/api/v2/files/photos/${'00'.repeat(32)}.bin`)).status, 404, 'not there: 404, as before');
    assert.equal((await t.phone.req('DELETE', '/api/v2/files/' + photo)).status, 200);
    assert.equal((await t.phone.req('DELETE', `/api/v2/files/archive/${t.phone.device}/2026-01.bin`)).status, 200);
  });

  test('a listed phone id joins again only with its own key', async () => {
    const t = await ready();
    const inv = async () => (await t.web.post('/api/v2/invites')).body.invite;
    const thief = new Phone(t.base, { device: t.phone.device, ip: freshIp() });
    const code = await inv();
    const r = await thief.join(code);
    assert.equal(r.status, 409);
    assert.equal(r.body.error, 'device-taken');
    assert.equal(r.body.message, 'That phone is already on this server. Remove it on the Phones page first, then add it again.');
    assert.equal((await t.phone.get('/api/v2/files')).status, 200, 'the real phone carries on');
    assert.equal((await thief.get('/api/v2/files')).status, 401);
    // The same key again (the same phone retrying): fine, and the refused invite still works.
    const same = new Phone(t.base, { device: t.phone.device, ip: freshIp() });
    same.keys = t.phone.keys;
    assert.equal((await same.join(code)).status, 200);
    assert.equal((await t.phone.get('/api/v2/files')).status, 200);
    // Removed first, then a new key is fine.
    await t.web.req('DELETE', '/api/v2/devices/' + t.phone.device);
    assert.equal((await thief.join(await inv())).status, 200);
    assert.equal((await thief.get('/api/v2/files')).status, 200);
  });
});
