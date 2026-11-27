// 0.18.3: the addresses (Cloudflare tunnels), Add a phone codes that survive a restart and say when
// they're used or expired, a yes on an admin phone (sign-in and risky changes), Server admin from an
// admin phone, the last admin phone, and the new Server settings.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { house, addPhone, core, b64u, start, stop, PASS, ITER } from './helpers.mjs';
import { codeFields } from './client.mjs';
import { cleanAddress, placeOf, repairAddresses, homeName } from '../src/v3/addr.mjs';
import { compareVersions } from '../src/v3/approve.mjs';
import { isHomeAddress } from '../src/server.mjs';

const SEALED = 'application/x-restock-sealed';
const MIN = 60_000;

/** A sealed request from a phone, saying its version (X-Restock-App) as Restock does. */
async function sealed(t, p, method, path, obj) {
  const key = Buffer.from(p.serverKeys[String(p.keyv)], 'base64url');
  const body = obj === undefined ? undefined : Buffer.from(core.sealRsf1(key, obj));
  const auth = p.authHeader(method, path, body);
  const headers = { ...p.headers, Authorization: auth, 'X-Restock-Seal': 'rsf1', ...(body ? { 'Content-Type': SEALED } : {}) };
  const r = await fetch(t.base + path, { method, body, headers });
  const raw = Buffer.from(await r.arrayBuffer());
  if (!String(r.headers.get('content-type')).startsWith(SEALED)) return { status: r.status, body: raw.length ? JSON.parse(raw.toString('utf8')) : {} };
  const out = core.openWithAny(p.serverKeys, raw).msg;
  delete out.reqN;
  return { status: r.status, body: out };
}

/** A house with an admin phone on 0.18.3 (it can say yes). */
async function withAdmin(app = '0.18.3') {
  const t = await house();
  const a = await addPhone(t, "Declan's Pixel");
  a.headers['X-Restock-App'] = app;
  assert.equal((await t.web.req('PATCH', '/api/v3/phones/' + a.device, { json: { role: 'admin' } })).status, 200);
  // It says its version with its next request.
  assert.equal((await sealed(t, a, 'GET', '/api/v3/me')).status, 200);
  return { t, a };
}

describe('0.18.3: addresses', () => {
  test('home names, typed addresses, and where an opened address belongs', () => {
    for (const h of ['192.168.1.20', '10.0.0.5', '100.101.102.103', 'nas.local', 'restock', 'pi.tailnet-abc.ts.net', 'box.home.arpa']) assert.equal(homeName(h, isHomeAddress), true, h);
    for (const h of ['restock-server.plenty.family', '8.8.8.8', 'example.com']) assert.equal(homeName(h, isHomeAddress), false, h);
    assert.deepEqual(cleanAddress('192.168.1.20:8787', 'home', isHomeAddress), { value: 'http://192.168.1.20:8787' });
    assert.deepEqual(cleanAddress('restock-server.plenty.family/', 'away', isHomeAddress), { value: 'https://restock-server.plenty.family' });
    assert.match(cleanAddress('http://restock-server.plenty.family', 'away', isHomeAddress).error, /https/);
    assert.match(cleanAddress('http://restock-server.plenty.family', 'home', isHomeAddress).error, /Away from home/);
    assert.match(cleanAddress('http://192.168.1.20', 'away', isHomeAddress).error, /At home/);
    assert.match(cleanAddress('https://a.example?x=1', 'away', isHomeAddress).error, /\?/);
    assert.deepEqual(cleanAddress('', 'away', isHomeAddress), { value: null });
    // A tunnel passes plain http on: the away address is still https.
    assert.deepEqual(placeOf('http://restock-server.plenty.family', isHomeAddress), { away: 'https://restock-server.plenty.family' });
    assert.deepEqual(placeOf('http://192.168.1.20:8787', isHomeAddress), { home: 'http://192.168.1.20:8787' });
    assert.equal(placeOf('http://127.0.0.1:8787', isHomeAddress).loop, true);
    // Kept before 0.18.3: put right.
    assert.deepEqual(repairAddresses({ home: 'http://192.168.1.20:8787', away: 'http://restock-server.plenty.family' }, isHomeAddress), { home: 'http://192.168.1.20:8787', away: 'https://restock-server.plenty.family', changed: true });
    assert.deepEqual(repairAddresses({ home: 'http://restock-server.plenty.family', away: null }, isHomeAddress), { home: '', away: 'https://restock-server.plenty.family', changed: true });
    assert.equal(repairAddresses({ home: 'http://192.168.1.20:8787', away: 'https://a.example' }, isHomeAddress).changed, false);
  });

  test('a code made through a Cloudflare tunnel has the https away address (the bug: http://)', async () => {
    const t = await house();
    // Opened through the tunnel: the request arrives as plain http with the public name.
    const web = t.web;
    web.headers['X-Forwarded-Host'] = 'restock-server.plenty.family';
    const c = await web.post('/api/v3/phones', { label: 'Sarah' });
    delete web.headers['X-Forwarded-Host'];
    assert.equal(c.status, 200);
    const f = codeFields(c.body.code);
    assert.equal(f.a, 'https://restock-server.plenty.family');
    assert.equal(c.body.away, 'https://restock-server.plenty.family');
    // The home one (where it was set up) stays.
    assert.ok(f.h?.startsWith('http://127.0.0.1'));
    // And the signed server row has it too.
    const p = t.phone3();
    assert.equal((await p.join(c.body.code)).status, 200);
    assert.equal(p.gift.server.away, 'https://restock-server.plenty.family');
  });

  test('an http:// away address kept by an older server is put right when it starts', async () => {
    const t = await house();
    t.state.house.away = 'http://restock-server.plenty.family';
    await t.flush();
    const dir = t.dir;
    await stop(t);
    const t2 = await start({}, dir);
    assert.equal(t2.state.house.away, 'https://restock-server.plenty.family');
    await stop(t2);
  });

  test('Server settings → Addresses: set by hand (checked), then not learnt any more; at least one', async () => {
    const t = await house();
    let r = await t.web.put('/api/v3/settings', { home: '192.168.1.20:8787', away: 'restock-server.plenty.family' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.home, 'http://192.168.1.20:8787');
    assert.equal(r.body.away, 'https://restock-server.plenty.family');
    assert.equal(r.body.addrSet, true);
    assert.equal((await t.web.put('/api/v3/settings', { away: 'http://x.example' })).status, 400);
    assert.equal((await t.web.put('/api/v3/settings', { home: '', away: '' })).status, 400);
    // Opening the page from elsewhere doesn't change them now.
    t.web.headers['X-Forwarded-Host'] = 'other.example';
    const c = await t.web.post('/api/v3/phones', { label: 'X' });
    delete t.web.headers['X-Forwarded-Host'];
    assert.equal(codeFields(c.body.code).a, 'https://restock-server.plenty.family');
    assert.equal(codeFields(c.body.code).h, 'http://192.168.1.20:8787');
  });
});

describe('0.18.3: Add a phone codes', () => {
  test('a used one says used, an expired one says expired (not "isn\'t from this server")', async () => {
    const t = await house();
    const c = (await t.web.post('/api/v3/phones', { label: 'A' })).body.code;
    assert.equal((await t.phone3().join(c)).status, 200);
    const again = await t.phone3().join(c);
    assert.equal(again.status, 410);
    assert.equal(again.body.error, 'used');
    const c2 = (await t.web.post('/api/v3/phones', { label: 'B' })).body.code;
    t.clock.shift += 11 * MIN;
    // The minute's tidy-up has run: still remembered.
    t.R.v3.invites.size;
    const late = await t.phone3().join(c2);
    assert.equal(late.status, 410);
    assert.equal(late.body.error, 'expired');
    assert.match(late.body.message, /10 minutes/);
  });

  test('a code still works after the server restarts', async () => {
    const t = await house();
    const c = (await t.web.post('/api/v3/phones', { label: 'A' })).body.code;
    await t.flush();
    const dir = t.dir;
    await stop(t);
    const t2 = await start({}, dir);
    assert.equal((await t2.phone3().join(c)).status, 200);
    await stop(t2);
  });
});

describe('0.18.3: a yes on an admin phone', () => {
  test('versions compare', () => {
    assert.ok(compareVersions('0.18.3', '0.18.10') < 0);
    assert.ok(compareVersions('0.18.3', '0.18.3') === 0);
    assert.ok(compareVersions('1.0.0', '0.99.99') > 0);
    assert.ok(compareVersions('', '0.0.1') < 0);
  });

  test('signing in waits for the phone: no keys, nothing else, until it says yes', async () => {
    const { t, a } = await withAdmin();
    const w = t.web3();
    const l = await w.login('admin', PASS, ITER);
    assert.equal(l.status, 200);
    assert.ok(l.approve, 'it waits');
    assert.equal(l.body.sealed, undefined, 'no keys yet');
    assert.match(l.approve.number, /^\d\d$/);
    assert.deepEqual(l.approve.phones, ["Declan's Pixel"]);
    // Nothing else while it waits.
    const blocked = await w.get('/api/v3/phones');
    assert.equal(blocked.status, 403);
    assert.equal(blocked.body.error, 'approve');
    assert.equal((await w.signInStatus()).body.status, 'waiting');
    // The phone sees it, with the same number.
    const list = (await sealed(t, a, 'GET', '/api/v3/approvals')).body.approvals;
    assert.equal(list.length, 1);
    assert.equal(list[0].number, l.approve.number);
    assert.equal(list[0].what, 'sign-in');
    assert.match(list[0].browser, /browser|on/i);
    assert.equal((await sealed(t, a, 'POST', '/api/v3/approvals/' + list[0].id, { yes: true })).status, 200);
    const done = await w.signInStatus();
    assert.equal(done.body.status, 'yes');
    assert.ok(w.gift.keys, 'the keys came with the yes');
    assert.equal((await w.get('/api/v3/phones')).status, 200);
    // Answered once.
    assert.equal((await sealed(t, a, 'POST', '/api/v3/approvals/' + list[0].id, { yes: true })).status, 410);
  });

  test('"No, block it" ends that sign-in; the recovery key says yes in place of a phone', async () => {
    const { t, a } = await withAdmin();
    const w = t.web3();
    const l = await w.login('admin', PASS, ITER);
    const id = (await sealed(t, a, 'GET', '/api/v3/approvals')).body.approvals[0].id;
    assert.equal((await sealed(t, a, 'POST', '/api/v3/approvals/' + id, { yes: false })).status, 200);
    assert.equal((await w.signInStatus(l.approve.id)).status, 401);
    // The recovery key (every admin phone lost).
    const key = (await t.web.post('/api/v3/recovery', { confirm: await t.web.confirm() }));
    // The signed-in browser asking for the key itself waits for a yes too.
    assert.equal(key.status, 403);
    assert.equal(key.body.error, 'approve');
    const kid = (await sealed(t, a, 'GET', '/api/v3/approvals')).body.approvals.find((x) => x.what === 'recovery-key').id;
    await sealed(t, a, 'POST', '/api/v3/approvals/' + kid, { yes: true });
    const shown = await t.web.post('/api/v3/recovery', { approved: key.body.approve.id });
    assert.equal(shown.status, 200, JSON.stringify(shown.body));
    // Taken once.
    assert.equal((await t.web.post('/api/v3/recovery', { approved: key.body.approve.id })).status, 403);
    const w2 = t.web3();
    const l2 = await w2.login('admin', PASS, ITER);
    assert.equal((await w2.req('POST', '/api/v3/approve/' + l2.approve.id, { sealed: { recovery: 'AAAA-BBBB' } })).status, 403);
    const ok = await w2.req('POST', '/api/v3/approve/' + l2.approve.id, { sealed: { recovery: shown.body.recovery } });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal((await w2.signInStatus(l2.approve.id)).body.status, 'yes');
  });

  test('no admin phone on 0.18.3 yet: the passphrase alone, as before', async () => {
    const { t } = await withAdmin('0.18.2');
    const l = await t.web3().login('admin', PASS, ITER);
    assert.ok(l.gift, 'signed in straight away');
  });

  test('deleting data waits for a yes, then goes once', async () => {
    const { t, a } = await withAdmin();
    const r = await t.web.post('/api/v3/data/delete', { kinds: ['logs'], typed: 'DELETE', confirm: await t.web.confirm() });
    assert.equal(r.status, 403);
    assert.equal(r.body.error, 'approve');
    const req = (await sealed(t, a, 'GET', '/api/v3/approvals')).body.approvals[0];
    assert.equal(req.what, 'delete-data');
    assert.equal(req.words, 'delete data');
    await sealed(t, a, 'POST', '/api/v3/approvals/' + req.id, { yes: true });
    const go = await t.web.post('/api/v3/data/delete', { kinds: ['logs'], typed: 'DELETE', approved: r.body.approve.id });
    assert.equal(go.status, 200, JSON.stringify(go.body));
    // Another kind of change can't use that yes.
    const r2 = await t.web.put('/api/v3/settings', { keepMonths: 3, typed: 'DELETE', approved: r.body.approve.id });
    assert.equal(r2.status, 403);
  });

  test('a user phone sees no requests and can\'t answer; only an admin phone signs a browser in', async () => {
    const { t } = await withAdmin();
    const u = await addPhone(t, 'Kitchen iPad');
    u.headers['X-Restock-App'] = '0.18.3';
    assert.deepEqual((await sealed(t, u, 'GET', '/api/v3/approvals')).body, { approvals: [] });
    assert.equal((await sealed(t, u, 'POST', '/api/v3/approvals/' + 'x'.repeat(24), { yes: true })).status, 403);
    const e = core.newEcdhKey();
    const st = await (await fetch(t.base + '/api/v3/qrlogin', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ epub: b64u(e.pub) }) })).json();
    assert.equal((await u.post('/api/v3/qrlogin/' + st.id, { k: b64u(e.pub) })).status, 403);
  });
});

describe('0.18.3: Server admin from an admin phone', () => {
  test('settings, activity, Home Assistant and browsers; a user phone gets none', async () => {
    const { t, a } = await withAdmin();
    const s = await sealed(t, a, 'GET', '/api/v3/settings');
    assert.equal(s.status, 200);
    assert.equal(s.body.name, 'Declan and Sarah');
    assert.equal(s.body.version, (await t.web3().get('/api/v3/health')).body.version);
    assert.equal(s.body.sessionHours, 720);
    const put = await sealed(t, a, 'PUT', '/api/v3/settings', { away: 'restock-server.plenty.family', timeZone: 'Australia/Brisbane', sessionHours: 24 });
    assert.equal(put.status, 200, JSON.stringify(put.body));
    assert.equal(put.body.away, 'https://restock-server.plenty.family');
    assert.equal(put.body.timeZone, 'Australia/Brisbane');
    assert.equal((await sealed(t, a, 'PUT', '/api/v3/settings', { timeZone: 'Mars/Olympus' })).status, 400);
    assert.equal((await sealed(t, a, 'GET', '/api/v3/activity')).status, 200);
    assert.equal((await sealed(t, a, 'GET', '/api/v3/homeassistant')).status, 200);
    assert.equal((await sealed(t, a, 'GET', '/api/v3/browsers')).status, 200);
    assert.equal((await sealed(t, a, 'GET', '/api/v3/data/summary')).status, 200);
    assert.ok((await sealed(t, a, 'GET', '/api/v3/server/log')).body.text.includes('Restock server'));
    const u = await addPhone(t, 'User');
    assert.equal((await sealed(t, u, 'GET', '/api/v3/settings')).status, 403);
    assert.equal((await sealed(t, u, 'GET', '/api/v3/activity')).status, 403);
  });

  test("the phone's risky changes need the passphrase, proved over its device id", async () => {
    const { t, a } = await withAdmin();
    assert.equal((await sealed(t, a, 'POST', '/api/v3/recovery', { confirm: { c: 'x', proof: 'y' } })).status, 403);
    const ch = (await sealed(t, a, 'GET', '/api/v3/confirm/challenge')).body;
    assert.equal(ch.user, 'admin');
    const proof = core.loginProof(t.web.loginKey, ch.c, 'phone:' + a.device);
    const r = await sealed(t, a, 'POST', '/api/v3/recovery', { confirm: { c: ch.c, proof } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.ok(r.body.recovery);
  });

  test('Oldest Restock that can join: older phones are told to update, and new ones turned away', async () => {
    const { t, a } = await withAdmin();
    const old = await addPhone(t, 'Old');
    old.headers['X-Restock-App'] = '0.18.0';
    assert.equal((await old.get('/api/v3/files')).status, 200);
    assert.equal((await sealed(t, a, 'PUT', '/api/v3/settings', { minApp: '9.0.0' })).status, 400);
    const v = (await sealed(t, a, 'GET', '/api/v3/settings')).body.version;
    assert.equal((await sealed(t, a, 'PUT', '/api/v3/settings', { minApp: v })).status, 200);
    const r = await old.get('/api/v3/files');
    assert.equal(r.status, 403);
    assert.match(r.body.message, new RegExp(v.replace(/\./g, '\\.')));
  });

  test('the server log, updates and restart answer', async () => {
    const t = await house();
    const u = await t.web.get('/api/v3/server/updates');
    assert.equal(u.status, 200);
    assert.equal(typeof u.body.version, 'string');
    // Not in Docker here: restart says so.
    assert.equal((await t.web.post('/api/v3/server/restart')).status, 409);
  });

  test('user name: changed with the passphrase; sign in with the new one', async () => {
    const t = await house();
    const r = await t.web.post('/api/v3/username', { user: 'declan', confirm: await t.web.confirm() });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal((await t.web3().login('declan', PASS, ITER)).status, 200);
    assert.equal((await t.web3().login('admin', PASS, ITER)).status, 401);
  });
});
