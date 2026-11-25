import { test, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, pbkdf2Sync } from 'node:crypto';
import { request } from 'node:http';
import { makeServer, config, LIMITS, VERSION, isHomeAddress, isKnownPassword, limitKey } from '../src/server.mjs';
import { Browser, Phone, vault, p256, b64u, derive } from './client.mjs';
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

/** A server whose passphrase is set, with a signed-in browser (0.15.0: no phones here: they join a house, v3.test.mjs). */
async function ready(over) {
  const t = await start(over);
  const web = t.browser();
  const webKey = p256();
  await web.setup({ passphrase: PASS, iterations: ITER, webId: 'webAAAAAAAA', webPub: webKey.pub });
  const l = await web.login('admin', PASS, ITER);
  assert.equal(l.status, 200);
  return { ...t, web, webKey };
}

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
    assert.equal((await b.get('/api/v3/account/salt?user=sarah')).body.setup, true);
    assert.equal((await b.post('/api/v3/account/login', { user: 'sarah', password: 'admin' })).status, 401);
    assert.equal((await b.post('/api/v3/account/login', { user: 'admin', password: 'first-start-pw' })).status, 401);
    const r = await b.post('/api/v3/account/login', { user: 'sarah', password: 'first-start-pw' });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { mustChange: true, vault: null });
    const cookie = r.headers.get('set-cookie');
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Strict/);
    assert.match(cookie, /Path=\//);
    assert.doesNotMatch(cookie, /Secure/);
    for (const [m, p] of [
      ['GET', '/api/v3/account/vault'],
      ['GET', '/api/v3/account/web'],
      ['PUT', '/api/v3/account/web'],
    ]) {
      const x = await b.req(m, p, { json: m === 'GET' ? undefined : {} });
      assert.equal(x.status, 403, `${m} ${p}`);
      assert.equal(x.body.error, 'mustChange');
    }
  });

  test('with the default "admin" password, the first login only works from home', async () => {
    const MSG = 'Finish setting up Restock server from your home network first (or start it with your own RESTOCK_PASSWORD).';
    for (const trustProxy of [true, 'cloudflare', false]) {
      const t = await start({ trustProxy });
      const login = (headers) => new Browser(t.base, { headers }).post('/api/v3/account/login', { user: 'admin', password: 'admin' });
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
    const r = await new Browser(t.base, { headers: { 'X-Forwarded-For': '203.0.113.5' } }).post('/api/v3/account/login', { user: 'admin', password: 'our-own-first-password' });
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
    assert.equal((await b.get('/api/v3/account/web')).status, 200);
    assert.equal((await t.browser().post('/api/v3/account/login', { user: 'admin', password: 'admin' })).status, 401);
    const state = JSON.parse(readFileSync(join(t.dir, 'state.json'), 'utf8'));
    const { auth } = derive(PASS, salt, ITER);
    assert.equal(state.account.salt, salt);
    assert.equal(state.account.scrypt.alg, 'scrypt');
    assert.ok(!JSON.stringify(state).includes(auth), 'the authKey itself is never stored');
    assert.ok(!JSON.stringify(state).includes(PASS));
    // The real salt for the user; a stable fake one for anyone else, the same length.
    const s1 = (await t.browser().get('/api/v3/account/salt?user=admin')).body;
    assert.deepEqual(s1, { salt });
    const f1 = (await t.browser().get('/api/v3/account/salt?user=nobody')).body.salt;
    const f2 = (await t.browser().get('/api/v3/account/salt?user=nobody')).body.salt;
    assert.equal(f1, f2);
    assert.notEqual(f1, salt);
    assert.equal(f1.length, salt.length);
  });

  test('passphrase input is checked', async () => {
    const t = await start();
    const b = t.browser();
    await b.post('/api/v3/account/login', { user: 'admin', password: 'admin' });
    const salt = b64u(randomBytes(16));
    assert.equal((await b.post('/api/v3/account/passphrase', { salt: 'abc', auth: b64u(randomBytes(32)) })).status, 400);
    assert.equal((await b.post('/api/v3/account/passphrase', { salt, auth: b64u(randomBytes(31)) })).status, 400);
    assert.equal((await b.post('/api/v3/account/passphrase', { salt, auth: b64u(randomBytes(32)), vault: b64u(randomBytes(40)) })).status, 400);
    assert.equal((await b.post('/api/v3/account/passphrase', { salt, auth: b64u(randomBytes(32)), webId: 'short', webPub: p256().pub })).status, 400);
    assert.equal((await b.post('/api/v3/account/passphrase', { salt, auth: b64u(randomBytes(32)), webId: 'webBBBBBBBB', webPub: b64u(randomBytes(65)) })).status, 400);
    assert.equal((await t.browser().post('/api/v3/account/passphrase', { salt, auth: b64u(randomBytes(32)) })).status, 401, 'needs a session');
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
    let w = (await b.get('/api/v3/account/web')).body;
    assert.equal(w.webId, null);
    assert.equal(w.session.kind, 'passphrase');
    const k = p256();
    assert.equal((await b.put('/api/v3/account/web', { webId: 'webCCCCCCCC', webPub: k.pub })).status, 200);
    w = (await b.get('/api/v3/account/web')).body;
    assert.equal(w.webId, 'webCCCCCCCC');
    assert.deepEqual(w.webs, [{ webId: 'webCCCCCCCC', webPub: k.pub }]);
    assert.equal(w.session.webId, 'webCCCCCCCC');
    const v = vault(l.vaultKey, { webId: 'webCCCCCCCC', webPriv: 'x', keys: {} });
    assert.equal((await b.put('/api/v3/account/vault', { vault: v })).status, 200);
    assert.equal((await b.put('/api/v3/account/vault', { vault: 'not a vault' })).status, 400);
    assert.equal((await b.put('/api/v3/account/vault', { vault: b64u(Buffer.concat([Buffer.from('RSV2'), randomBytes(LIMITS.maxVault)])) })).status, 400, 'size cap');
    assert.equal((await b.get('/api/v3/account/vault')).body.vault, v);
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
    const current = derive(PASS, (await t.web.get('/api/v3/account/salt?user=admin')).body.salt, ITER).auth;
    const same = await t.web.post('/api/v3/account/passphrase', { salt, auth, current, webId: 'webAAAAAAAA', webPub: p256().pub });
    assert.equal(same.status, 400);
    assert.equal(same.body.error, 'webId');
    const r = await t.web.post('/api/v3/account/passphrase', { salt, auth, current, webId: 'webDDDDDDDD', webPub: p256().pub });
    assert.equal(r.status, 200);
    assert.equal((await t.web.get('/api/v3/account/web')).status, 200, 'this browser carries on');
    assert.equal((await other.get('/api/v3/account/web')).status, 401, 'the other one is signed out');
    assert.equal((await t.browser().login('admin', PASS, ITER)).status, 401);
    assert.equal((await t.browser().login('admin', NEW, ITER)).status, 200);
    // The old webId can't come back.
    assert.equal((await t.web.put('/api/v3/account/web', { webId: 'webAAAAAAAA', webPub: p256().pub })).status, 400);
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
    t.clock.shift += LIMITS.lockoutMs + 1000;
    assert.equal((await bad.login('admin', PASS, ITER)).status, 200);
  });

  test('a page from another site gets nothing done with the session', async () => {
    const t = await ready();
    const r = await t.web.req('POST', '/api/v3/account/passphrase', { json: {}, headers: { 'Sec-Fetch-Site': 'cross-site' } });
    assert.equal(r.status, 403);
    assert.equal(r.body.error, 'forbidden');
    assert.equal((await t.web.req('POST', '/api/v3/account/passphrase', { json: {}, headers: { 'Sec-Fetch-Site': 'same-origin' } })).status, 400, 'from the page itself it gets as far as the route');
  });

  test('Secure cookies on https behind a trusted proxy, not otherwise', async () => {
    const t = await start();
    const b = t.browser({ headers: { 'X-Forwarded-Proto': 'https' } });
    const r = await b.post('/api/v3/account/login', { user: 'admin', password: 'admin' });
    assert.match(r.headers.get('set-cookie'), /; Secure/);
    const u = await start({ trustProxy: false });
    const r2 = await new Browser(u.base, { headers: { 'X-Forwarded-Proto': 'https' } }).post('/api/v3/account/login', { user: 'admin', password: 'admin' });
    assert.doesNotMatch(r2.headers.get('set-cookie'), /Secure/);
  });

  test('without RESTOCK_TRUST_PROXY a made-up X-Forwarded-For doesn\'t dodge the lockout', async () => {
    const t = await start({ trustProxy: false });
    for (let i = 0; i < 10; i++) await new Browser(t.base, { ip: freshIp() }).post('/api/v3/account/login', { user: 'admin', password: 'nope' });
    assert.equal((await new Browser(t.base, { ip: freshIp() }).post('/api/v3/account/login', { user: 'admin', password: 'admin' })).status, 429);
  });
});

describe('sessions, sign out everywhere, activity, state', () => {
  test('sign out, and sign out everywhere (the web app moves to a new webId first)', async () => {
    const t = await ready();
    const second = t.browser();
    await second.login('admin', PASS, ITER);
    const third = t.browser();
    await third.login('admin', PASS, ITER);
    assert.equal((await third.post('/api/v3/account/logout')).status, 200);
    assert.equal((await third.get('/api/v3/account/web')).status, 401);
    assert.equal((await second.get('/api/v3/account/web')).status, 200, 'one sign-out leaves the others');
    assert.equal((await t.browser().post('/api/v3/account/logout', { everywhere: true })).status, 401);
    // As the web app does it: a new webId and key in the vault, then sign out everywhere.
    const k = p256();
    const vk = (await t.web.login('admin', PASS, ITER)).vaultKey;
    assert.equal((await t.web.put('/api/v3/account/vault', { vault: vault(vk, {}), webId: 'webEEEEEEEE', webPub: k.pub })).status, 200);
    assert.equal((await t.web.post('/api/v3/account/logout', { everywhere: true })).status, 200);
    const r = await second.get('/api/v3/account/web');
    assert.equal(r.status, 401);
    assert.equal(r.body.error, 'signed-out');
    assert.equal((await t.web.get('/api/v3/account/web')).status, 401);
    const back = t.browser();
    await back.login('admin', PASS, ITER);
    assert.equal((await back.put('/api/v3/account/web', { webId: 'webAAAAAAAA', webPub: p256().pub })).status, 400, 'the old webId is retired');
    assert.equal((await back.put('/api/v3/account/vault', { vault: vault(vk, {}), webId: 'webAAAAAAAA', webPub: p256().pub })).status, 400);
    assert.equal((await back.put('/api/v3/account/vault', { vault: vault(vk, {}), webId: 'webEEEEEEEE', webPub: k.pub })).status, 200, 'the current one is fine');
  });

  test('sessions expire after 30 days unused', async () => {
    const t = await ready();
    t.clock.shift += 29 * 24 * 3600_000;
    assert.equal((await t.web.get('/api/v3/account/web')).status, 200);
    t.clock.shift += 29 * 24 * 3600_000;
    assert.equal((await t.web.get('/api/v3/account/web')).status, 200, 'used, so it carries on');
    t.clock.shift += 31 * 24 * 3600_000;
    const r = await t.web.get('/api/v3/account/web');
    assert.equal(r.status, 401);
    assert.equal(r.body.error, 'signed-out');
  });

  test('state survives a restart; reset-passphrase clears the web side', async () => {
    const t = await ready();
    await stop(t);
    const u = await start({}, t.dir);
    const web = new Browser(u.base, { ip: freshIp() });
    web.jar = t.web.jar;
    assert.equal((await web.get('/api/v3/account/web')).status, 200, 'still signed in');
    await stop(u);
    writeFileSync(join(t.dir, 'reset-passphrase'), '');
    const v = await start({}, t.dir);
    assert.ok(v.wasReset);
    assert.ok(!existsSync(join(t.dir, 'reset-passphrase')));
    web.base = v.base;
    assert.equal((await web.get('/api/v3/account/web')).status, 401, 'signed out');
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
  const currentAuth = async (t, b = t.web) => derive(PASS, (await b.get('/api/v3/account/salt?user=admin')).body.salt, ITER).auth;
  const newPassphrase = (words = 'paddock wombat silver anchor') => {
    const salt = b64u(randomBytes(16));
    return { salt, auth: derive(words, salt, ITER).auth };
  };

  test('a new passphrase needs the current one (a stolen session cookie is not enough)', async () => {
    const t = await ready();
    const thief = new Browser(t.base, { ip: freshIp() });
    thief.jar = new Map(t.web.jar);
    const np = newPassphrase();
    let r = await thief.post('/api/v3/account/passphrase', np);
    assert.equal(r.status, 400);
    assert.equal(r.body.error, 'current');
    r = await thief.post('/api/v3/account/passphrase', { ...np, current: b64u(randomBytes(32)) });
    assert.equal(r.status, 403);
    assert.equal(r.body.error, 'current');
    assert.equal((await t.web.get('/api/v3/account/web')).status, 200, 'nobody was signed out');
    assert.equal((await t.browser().login('admin', PASS, ITER)).status, 200, 'the passphrase is unchanged');
    // Wrong guesses count towards the lockout.
    for (let i = 0; i < LIMITS.failsBeforeLockout; i++) await thief.post('/api/v3/account/passphrase', { ...np, current: b64u(randomBytes(32)) });
    assert.equal((await thief.post('/api/v3/account/passphrase', { ...np, current: await currentAuth(t) })).status, 429);
    // With the real one, from the owner's browser, it works.
    assert.equal((await t.web.post('/api/v3/account/passphrase', { ...np, current: await currentAuth(t) })).status, 200);
  });

  test('setting the passphrase gives the browser a new session cookie; the setup one stops working', async () => {
    const t = await start();
    const b = t.browser();
    await b.post('/api/v3/account/login', { user: 'admin', password: 'admin' });
    const setupCookie = b.cookie('restock_session');
    const sniffer = new Browser(t.base, { ip: freshIp() });
    sniffer.jar.set('restock_session', setupCookie);
    const r = await b.raw('POST', '/api/v3/account/passphrase', { json: newPassphrase(PASS) });
    assert.equal(r.status, 200);
    assert.match(r.headers.get('set-cookie'), /Max-Age=2592000/, 'a 30-day cookie, not the setup one-hour one');
    assert.notEqual(b.cookie('restock_session'), setupCookie);
    assert.equal((await b.get('/api/v3/account/web')).status, 200, 'this browser carries on');
    assert.equal((await sniffer.get('/api/v3/account/web')).status, 401, 'the setup cookie is no good any more');
  });

  test('the compose file\'s placeholder password counts as a known one: first login only from home', async () => {
    assert.ok(isKnownPassword('change-me-now'));
    assert.ok(isKnownPassword('admin'));
    assert.ok(!isKnownPassword('a5Gq-first-start-9'));
    const t = await start({ password: 'change-me-now' });
    const away = await t.browser({ ip: '203.0.113.9' }).post('/api/v3/account/login', { user: 'admin', password: 'change-me-now' });
    assert.equal(away.status, 403);
    assert.equal(away.body.error, 'setup-remote');
    assert.equal((await t.browser().post('/api/v3/account/login', { user: 'admin', password: 'change-me-now' })).status, 200, 'from home it works');
  });

  test('a page on another port of the same computer (plain http, no Sec-Fetch-Site) can\'t post with the session', async () => {
    const t = await ready();
    for (const type of ['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=x']) {
      const r = await t.web.req('POST', '/api/v3/account/logout', { body: '{"everywhere":true}', headers: { 'Content-Type': type } });
      assert.equal(r.status, 415, type);
    }
    assert.equal((await t.web.req('POST', '/api/v3/account/passphrase', { body: '{}' })).status, 415, 'no type at all');
    assert.equal((await t.web.get('/api/v3/account/web')).status, 200, 'still signed in');
    assert.equal((await t.web.post('/api/v3/account/passphrase', {})).status, 400, 'JSON, as the web app sends, gets as far as the route');
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
    const r = await t.browser({ headers: { 'X-Forwarded-Proto': 'https' } }).raw('POST', '/api/v3/account/login', { json: { user: 'admin', password: PW } });
    assert.equal(r.status, 200);
    assert.doesNotMatch(r.headers.get('set-cookie'), /Secure/);
    await t.browser().setup({ password: PW, passphrase: PASS, iterations: ITER });
    // ...and a made-up X-Forwarded-For doesn't give a fresh address each time.
    for (let i = 0; i < 10; i++) await t.browser().login('admin', 'wrong wrong wrong wrong', ITER);
    assert.equal((await t.browser().login('admin', PASS, ITER)).status, 429);
  });
});

