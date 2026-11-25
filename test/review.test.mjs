// 0.9.4 security review: what a removed phone, another member, a page elsewhere (DNS rebinding) or a
// signed-in browser could do, and what the fixes for those keep from them.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { request } from 'node:http';
import { randomBytes } from 'node:crypto';
import { start, house, addPhone, ITER, PASS, b64u } from './helpers.mjs';
import { startFakeHa } from './fake-ha.mjs';

/** A first-start login with the Host header a browser would send for `host`. */
function loginAs(base, host, password = 'admin') {
  const u = new URL(base + '/api/v3/account/login');
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
    const t = await start();
    const web = t.browser();
    await web.setup({ passphrase: PASS, iterations: ITER });
    assert.equal((await web.login('admin', PASS, ITER)).status, 200);
    delete t.state.account.loginKey; // a session from before 0.9.4
    const r = await web.post('/api/v3/setup', { name: 'Declan and Sarah' });
    assert.equal(r.status, 409);
    assert.equal(r.body.error, 'signin');
    // Signing in again teaches it.
    assert.equal((await web.login('admin', PASS, ITER)).status, 200);
    assert.ok(t.state.account.loginKey);
    assert.equal((await web.post('/api/v3/setup', { name: 'Declan and Sarah' })).status, 200);
  });


  test("household.db is the server's user's only (0600)", async () => {
    const t = await house();
    await addPhone(t, 'A');
    for (const f of ['household.db', 'keys.json', 'state.json']) assert.equal(statSync(join(t.dir, f)).mode & 0o077, 0, f);
  });
});
