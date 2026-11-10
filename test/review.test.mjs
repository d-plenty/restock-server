// 0.9.4 security review: what a removed phone, another member, a page elsewhere (DNS rebinding) or a
// signed-in browser could do, and what the fixes for those keep from them.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { statSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { request } from 'node:http';
import { randomBytes, createHash } from 'node:crypto';
import { start, house, addPhone, v2Household, handoverBody, ent, ITER, PASS, Phone, b64u } from './helpers.mjs';
import { startFakeHa } from './fake-ha.mjs';

/** A first-start login with the Host header a browser would send for `host`. */
function loginAs(base, host, password = 'admin') {
  const u = new URL(base + '/api/v2/login');
  const body = JSON.stringify({ user: 'admin', password });
  return new Promise((ok, no) => {
    const r = request({ host: u.hostname, port: u.port, path: u.pathname, method: 'POST', headers: { Host: host, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, (res) => {
      let text = '';
      res.on('data', (c) => (text += c));
      res.on('end', () => ok({ status: res.statusCode, body: text ? JSON.parse(text) : {} }));
    });
    r.on('error', no);
    r.end(body);
  });
}

async function handoverCode(t) {
  const r = await t.web.post('/api/v3/handover', {});
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body.code;
}

describe('security review (0.9.4)', () => {
  test('the default password from home, but through a page that pointed its own name at the server (DNS rebinding), is refused', async () => {
    const t = await start({ trustProxy: false, homeUrl: 'http://restock.example.net:8787' });
    for (const host of ['evil.example.com', 'evil.example.com:8787', '192-168-1-10.rebind.example.org']) {
      const r = await loginAs(t.base, host);
      assert.equal(r.status, 403, host);
      assert.equal(r.body.error, 'setup-remote', host);
    }
    for (const host of ['192.168.1.10:8787', '[fd00::5]:8787', 'localhost:8787', 'nas.local', 'restock', 'nas.tail1234.ts.net', 'restock.example.net:8787']) {
      assert.equal((await loginAs(t.base, host)).status, 200, host);
    }
    // Your own RESTOCK_PASSWORD works whatever the address.
    const own = await start({ trustProxy: false, password: 'our-own-first-password' });
    assert.equal((await loginAs(own.base, 'restock.example.com', 'our-own-first-password')).status, 200);
  });

  test('a v2 phone may not join with an id the server keeps for itself (srv-, web-, keys-)', async () => {
    const t = await start();
    const web = t.browser();
    await web.setup({ passphrase: PASS, iterations: ITER });
    await web.login('admin', PASS, ITER);
    for (const device of ['srv-0123456789', 'keys-abc', 'WEB-abc']) {
      const inv = (await web.post('/api/v2/invites')).body;
      const p = new Phone(t.base, { device, clock: t.now });
      const r = await p.join(inv.invite);
      assert.equal(r.status, 400, device);
      assert.equal(r.body.error, 'device', device);
    }
  });

  test('after the handover, a phone the household removed (still on the server) or one never in it gets no keys', async () => {
    const t = await v2Household();
    // Two more phones on the v2 server: one the household removed, one that was never in it.
    const gone = t.phone3({ name: 'Old phone' });
    const stranger = t.phone3({ name: 'Visitor' });
    for (const p of [gone, stranger]) {
      const inv = (await t.web.post('/api/v2/invites')).body;
      assert.equal((await Phone.prototype.join.call(p, inv.invite)).status, 200);
    }
    // The household's removal (signed by the owner) reached the server in another member's file.
    const now = Date.now();
    const removed = t.sign(ent('household', 'removed:' + gone.device, now - 1000, t.owner.device, { k: 'removed:' + gone.device, v: String(now - 1000) }));
    const msg = { format: 'restock-sync', v: 1, device: t.other.device, name: 'Sarah', keyv: 1, at: new Date().toISOString(), top: 1, seen: {}, entries: [removed] };
    const { core } = await import('./helpers.mjs');
    assert.equal((await t.other.req('PUT', `/api/v2/files/restock-sync-${t.other.device}.bin`, { body: Buffer.from(core.sealRsf1(t.hh.serverKey, msg)) })).status, 200);
    const h = handoverBody(await handoverCode(t), t.hh, t.owner);
    assert.equal((await t.owner.req('POST', '/api/v3/handover/' + h.token, { json: h.json })).status, 200);
    assert.notEqual(t.R.engine.householdValue('removed:' + gone.device), null);
    assert.equal(t.state.devices[gone.device].status, 'removed');
    const kex = t.R.house.kexPub();
    const a = await gone.upgrade(kex);
    assert.equal(a.status, 401, JSON.stringify(a.body));
    assert.equal(a.body.error, 'removed');
    assert.equal(gone.gift, undefined);
    const b = await stranger.upgrade(kex);
    assert.equal(b.status, 403, JSON.stringify(b.body));
    assert.equal(b.body.error, 'member');
    assert.equal(stranger.gift, undefined);
    assert.equal(t.state.devices[stranger.device].api, 2);
    // A member still upgrades.
    assert.equal((await t.other.upgrade(kex)).status, 200);
  });

  test("Remove on the server also signs out a 0.9.3 browser that phone signed in (v2's cookie session)", async () => {
    const t = await v2Household();
    // A v2 "signed in with a phone" session for the other phone, as /api/v2/qrlogin makes.
    const tok = b64u(randomBytes(32));
    t.state.sessions[b64u(createHash('sha256').update(tok).digest())] = { kind: 'phone', device: t.other.device, created: t.now(), lastUsed: t.now() };
    const b = t.browser();
    b.jar.set('restock_session', tok);
    assert.equal((await b.get('/api/v2/files')).status, 200);
    const h = handoverBody(await handoverCode(t), t.hh, t.owner);
    assert.equal((await t.owner.req('POST', '/api/v3/handover/' + h.token, { json: h.json })).status, 200);
    assert.equal((await b.get('/api/v2/files')).status, 200, 'a 0.9.3 tab carries on after the handover');
    const web3 = t.web3();
    assert.equal((await web3.login('admin', PASS, ITER)).status, 200);
    assert.equal((await web3.removePhone(t.other.device)).status, 200);
    const after = await b.get('/api/v2/files');
    assert.equal(after.status, 401);
    const put = await b.req('PUT', `/api/v2/files/restock-sync-web-x.bin`, { body: Buffer.alloc(40) });
    assert.equal(put.status, 401);
  });

  test("the saved Home Assistant token only goes to the address it was saved for", async () => {
    const TOKEN = 'eyJhbGciOiJIUzI1NiJ9.' + b64u(randomBytes(24));
    const ha = await startFakeHa({ token: TOKEN });
    const t = await house({ haEveryMs: 3_600_000 });
    try {
      assert.equal((await t.web.req('PUT', '/api/v3/homeassistant', { sealed: { address: ha.url, entity: 'todo.shopping_list', enabled: false, token: TOKEN } })).status, 200);
      // Somewhere else, without the token again: refused (test and save).
      const other = await startFakeHa({ token: 'x'.repeat(20) });
      try {
        const tst = await t.web.req('POST', '/api/v3/homeassistant/test', { sealed: { address: other.url } });
        assert.equal(tst.body.ok, false);
        assert.match(tst.body.message, /token again/);
        assert.equal(other.log.length, 0, "nothing was sent there");
        const put = await t.web.req('PUT', '/api/v3/homeassistant', { sealed: { address: other.url, entity: 'todo.shopping_list' } });
        assert.equal(put.status, 400);
        assert.equal(put.body.error, 'token');
        assert.equal(t.R.keys.data.ha.address, ha.url);
      } finally {
        await other.close();
      }
      // The same Home Assistant: the saved token is used.
      assert.equal((await t.web.req('POST', '/api/v3/homeassistant/test', { sealed: { address: ha.url + '/' } })).body.ok, true);
      assert.equal((await t.web.req('PUT', '/api/v3/homeassistant', { sealed: { address: ha.url, enabled: true } })).status, 200);
      assert.equal(t.R.keys.data.ha.token, TOKEN);
    } finally {
      t.R.ha.stop();
      await ha.close();
    }
  });

  test('a house is made only once the server knows the passphrase\'s login key (else no one could sign in to it)', async () => {
    const t = await v2Household();
    delete t.state.account.loginKey; // a v2 session from before the update
    const r = await t.web.post('/api/v3/handover', {});
    assert.equal(r.status, 409);
    assert.equal(r.body.error, 'signin');
    // Signing in again (v2) teaches it.
    assert.equal((await t.web.login('admin', PASS, ITER)).status, 200);
    assert.ok(t.state.account.loginKey);
    assert.equal((await t.web.post('/api/v3/handover', {})).status, 200);
  });

  test('a handover that fails part-way is rolled back at once (no half-made house left running)', async () => {
    const t = await v2Household();
    const real = t.R.mergeEverything;
    t.R.mergeEverything = () => {
      throw new Error('stopped');
    };
    const h = handoverBody(await handoverCode(t), t.hh, t.owner);
    const r = await t.owner.req('POST', '/api/v3/handover/' + h.token, { json: h.json });
    assert.equal(r.status, 500);
    t.R.mergeEverything = real;
    assert.equal(t.state.mode, 'v2');
    assert.equal(t.R.engine, null);
    assert.ok(!existsSync(join(t.dir, 'household.db')));
    const keys = JSON.parse(readFileSync(join(t.dir, 'keys.json'), 'utf8'));
    assert.equal(keys.owner, undefined);
    assert.equal(keys.handoverPending, undefined);
    assert.equal((await t.owner.get('/api/v2/files')).status, 200);
    const h2 = handoverBody(await handoverCode(t), t.hh, t.owner);
    assert.equal((await t.owner.req('POST', '/api/v3/handover/' + h2.token, { json: h2.json })).status, 200);
    assert.equal(t.state.mode, 'v3');
  });

  test("household.db is the server's user's only (0600)", async () => {
    const t = await house();
    await addPhone(t, 'A');
    for (const f of ['household.db', 'keys.json', 'state.json']) assert.equal(statSync(join(t.dir, f)).mode & 0o077, 0, f);
  });
});
