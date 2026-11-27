// 0.18.0: admin phones. Each phone is a user or an admin; phones already on a server are users. An
// admin phone adds phones and tablets, makes others admins or users, and removes them, as the web
// page does; its requests and answers go sealed with the household's server key.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { house, addPhone, core, b64u } from './helpers.mjs';

const SEALED = 'application/x-restock-sealed';

/** A sealed request from a phone (as ServerFolder.sealedCall / ios/house.ts sealed()): the answer opened, or the plain error. */
async function sealed(t, p, method, path, obj, { seal = true, ask = true } = {}) {
  const key = Buffer.from(p.serverKeys[String(p.keyv)], 'base64url');
  const body = obj === undefined ? undefined : seal ? Buffer.from(core.sealRsf1(key, obj)) : Buffer.from(JSON.stringify(obj));
  const auth = p.authHeader(method, path, body);
  const headers = { Authorization: auth, ...(ask ? { 'X-Restock-Seal': 'rsf1' } : {}), ...(body ? { 'Content-Type': seal ? SEALED : 'application/json' } : {}) };
  const r = await fetch(t.base + path, { method, body, headers });
  const raw = Buffer.from(await r.arrayBuffer());
  if (!String(r.headers.get('content-type')).startsWith(SEALED)) return { status: r.status, body: raw.length ? JSON.parse(raw.toString('utf8')) : {} };
  const out = core.openWithAny(p.serverKeys, raw).msg;
  assert.equal(out.reqN, /n=([^,]+)/.exec(auth)[1], 'the answer names its request');
  delete out.reqN;
  return { status: r.status, body: out };
}

describe('0.18.0: users and admins', () => {
  test('a phone is a user to start with; the web page (passphrase) makes it an admin, and a user again', async () => {
    const t = await house();
    const a = await addPhone(t, 'A');
    // 0.18.3: and the server's version.
    assert.deepEqual((await sealed(t, a, 'GET', '/api/v3/me')).body, { device: a.device, role: 'user', label: 'A', server: t.state.version ?? (await t.web.get('/api/v3/health')).body.version });
    let list = (await t.web.get('/api/v3/phones')).body.phones;
    assert.equal(list.find((p) => p.device === a.device).role, 'user');
    // A user phone can't see or change the phones.
    assert.equal((await sealed(t, a, 'GET', '/api/v3/phones')).status, 403);
    assert.equal((await sealed(t, a, 'POST', '/api/v3/phones', { label: 'X' })).status, 403);
    // The web page with the passphrase: Make admin.
    const r = await t.web.req('PATCH', '/api/v3/phones/' + a.device, { json: { role: 'admin' } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.role, 'admin');
    assert.equal((await sealed(t, a, 'GET', '/api/v3/me')).body.role, 'admin');
    list = (await sealed(t, a, 'GET', '/api/v3/phones')).body.phones;
    assert.equal(list.find((p) => p.device === a.device).me, true);
    assert.equal(list.find((p) => p.device === a.device).role, 'admin');
    // 0.18.3: not while it's the only admin phone.
    const only = await t.web.req('PATCH', '/api/v3/phones/' + a.device, { json: { role: 'user' } });
    assert.equal(only.status, 409);
    assert.equal(only.body.error, 'last-admin');
    const two = await addPhone(t, 'Two');
    await t.web.req('PATCH', '/api/v3/phones/' + two.device, { json: { role: 'admin' } });
    // And a user again.
    assert.equal((await t.web.req('PATCH', '/api/v3/phones/' + a.device, { json: { role: 'user' } })).body.role, 'user');
    assert.equal((await sealed(t, a, 'GET', '/api/v3/phones')).status, 403);
    assert.equal((await t.web.req('PATCH', '/api/v3/phones/' + a.device, { json: { role: 'boss' } })).status, 400);
    // The activity log says who did it.
    const log = (await t.web.get('/api/v3/activity')).body;
    assert.ok(JSON.stringify(log).includes('phone-role'));
  });

  test("an admin phone adds a phone or tablet (a user, or an admin with Make admin); the code works once", async () => {
    const t = await house();
    const a = await addPhone(t, 'A');
    await t.web.req('PATCH', '/api/v3/phones/' + a.device, { json: { role: 'admin' } });
    // Plain (not sealed) is refused: the code would cross the network readable.
    assert.equal((await sealed(t, a, 'POST', '/api/v3/phones', { label: 'Tablet' }, { seal: false })).status, 400);
    assert.equal((await sealed(t, a, 'GET', '/api/v3/phones', undefined, { ask: false })).status, 400);
    const c = await sealed(t, a, 'POST', '/api/v3/phones', { label: 'Kitchen tablet' });
    assert.equal(c.status, 200, JSON.stringify(c.body));
    assert.match(c.body.code, /^restock-server:3\?/);
    assert.equal(c.body.role, 'user');
    const tab = t.phone3({ name: 'iPad' });
    assert.equal((await tab.join(c.body.code)).status, 200);
    assert.equal(t.state.devices[tab.device].role, undefined);
    assert.equal((await t.phone3().join(c.body.code)).status, 410);
    // Make admin: the new phone is an admin.
    const c2 = await sealed(t, a, 'POST', '/api/v3/phones', { label: "Sarah's phone", admin: true });
    assert.equal(c2.body.role, 'admin');
    const s = t.phone3();
    assert.equal((await s.join(c2.body.code)).status, 200);
    assert.equal((await sealed(t, s, 'GET', '/api/v3/me')).body.role, 'admin');
    // The web page's code for an admin needs the passphrase sign-in (a passphrase one here works).
    const w = await t.web.post('/api/v3/phones', { label: 'Mum', admin: true });
    assert.equal(w.body.role, 'admin');
  });

  test('an admin phone renames, makes admins and users, and removes others (not itself); a user is refused', async () => {
    const t = await house();
    const a = await addPhone(t, 'A');
    const b = await addPhone(t, 'B');
    const c = await addPhone(t, 'C');
    await t.web.req('PATCH', '/api/v3/phones/' + a.device, { json: { role: 'admin' } });
    assert.equal((await sealed(t, a, 'PATCH', '/api/v3/phones/' + b.device, { label: 'Bedroom tablet' })).body.label, 'Bedroom tablet');
    assert.deepEqual(JSON.parse(t.R.engine.householdValue('member:' + b.device)).name, 'Bedroom tablet');
    assert.equal((await sealed(t, a, 'PATCH', '/api/v3/phones/' + b.device, { role: 'admin' })).body.role, 'admin');
    assert.equal((await sealed(t, b, 'GET', '/api/v3/me')).body.role, 'admin');
    // A user can't change anyone (itself included) or remove anyone.
    assert.equal((await sealed(t, c, 'PATCH', '/api/v3/phones/' + c.device, { role: 'admin' })).status, 403);
    assert.equal((await sealed(t, c, 'DELETE', '/api/v3/phones/' + a.device, {})).status, 403);
    // An admin can't remove itself here (Leave does that).
    assert.equal((await sealed(t, a, 'DELETE', '/api/v3/phones/' + a.device, {})).status, 403);
    // Remove from an admin phone: as from the web page (a new key; the removed phone refused).
    const r = await sealed(t, a, 'DELETE', '/api/v3/phones/' + c.device, {});
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.keyv, 2);
    assert.equal((await c.get('/api/v3/files')).body.error, 'removed');
    assert.equal(t.state.devices[c.device].status, 'removed');
    // Admin phones answer with the household's newest key.
    await a.takeKeysFile();
    assert.equal((await sealed(t, a, 'GET', '/api/v3/me')).status, 200);
    // After a Remove the household has a new key: a phone takes it from keys/ (its next sync) before its answers open.
    await b.takeKeysFile();
    // Made a user again: the phones are out of reach.
    assert.equal((await sealed(t, b, 'PATCH', '/api/v3/phones/' + a.device, { role: 'user' })).status, 200);
    assert.equal((await sealed(t, a, 'GET', '/api/v3/phones')).status, 403);
  });

  test('a removed admin that comes back with a user code is a user; old phones (no role) are users', async () => {
    const t = await house();
    const a = await addPhone(t, 'A');
    await t.web.req('PATCH', '/api/v3/phones/' + a.device, { json: { role: 'admin' } });
    // 0.18.3: the last admin phone can't be removed; with another admin it can.
    assert.equal((await t.web.removePhone(a.device)).status, 409);
    const keeper = await addPhone(t, 'Keeper');
    await t.web.req('PATCH', '/api/v3/phones/' + keeper.device, { json: { role: 'admin' } });
    assert.equal((await t.web.removePhone(a.device)).status, 200);
    const code = (await t.web.post('/api/v3/phones', { label: 'A again' })).body.code;
    const back = t.phone3({ device: a.device });
    back.keys = a.keys;
    assert.equal((await back.join(code)).status, 200);
    assert.equal(t.state.devices[a.device].role, undefined);
    // A phone with no role at all (on the server before 0.18.0): a user.
    const old = await addPhone(t, 'Old');
    delete t.state.devices[old.device].role;
    assert.equal((await sealed(t, old, 'GET', '/api/v3/me')).body.role, 'user');
    assert.equal((await t.web.get('/api/v3/phones')).body.phones.find((p) => p.device === old.device).role, 'user');
  });

  test('a browser signed in with a phone looks after the phones only when that phone is an admin', async () => {
    const t = await house();
    const p = await addPhone(t, 'Sarah');
    const signIn = async () => {
      const e = core.newEcdhKey();
      const start = await (await fetch(t.base + '/api/v3/qrlogin', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ epub: b64u(e.pub) }) })).json();
      assert.equal((await p.post('/api/v3/qrlogin/' + start.id, { k: b64u(e.pub) })).status, 200);
      const done = await (await fetch(t.base + '/api/v3/qrlogin/' + start.id)).json();
      const w = t.web3();
      Object.assign(w, { session: done.session, key: core.sessionKeyOf(e.priv, core.unb64(start.kex), core.unb64(start.id)) });
      return w;
    };
    const w = await signIn();
    assert.equal((await w.get('/api/v3/phones')).status, 200);
    assert.equal((await w.post('/api/v3/phones', { label: 'X' })).status, 403);
    assert.equal((await w.req('PATCH', '/api/v3/phones/' + p.device, { json: { label: 'Y' } })).status, 403);
    // Sarah made an admin: the browser she signed in can add a user phone (not an admin: that's the passphrase, or the phone itself).
    await t.web.req('PATCH', '/api/v3/phones/' + p.device, { json: { role: 'admin' } });
    assert.equal((await w.post('/api/v3/phones', { label: 'X' })).status, 200);
    assert.equal((await w.post('/api/v3/phones', { label: 'X', admin: true })).status, 403);
  });
});
