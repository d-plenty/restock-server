// 0.9.4, protocol v3: a house on the server (docs/server-v3-design.md section 12, P2's tests).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { request } from 'node:http';
import { nodeProblem, VERSION } from '../src/server.mjs';
import { parseNameV3 } from '../src/names.mjs';
import { start, house, addPhone, ent, item, line, rows, SHARE_PANTRY, SHARE_ALL, ITER, PASS, core, b64u, codeFields, V3Phone } from './helpers.mjs';

const DAY = 86_400_000;
const daysAgo = (d) => new Date(Date.now() - d * DAY).toISOString();

describe('modes, health and setting up', () => {
  test('a fresh server is "new"; health says so on v3 (v2 health unchanged)', async () => {
    const t = await start();
    const r = await (await fetch(t.base + '/api/v3/health')).json();
    assert.deepEqual(r, { ok: true, app: 'restock-server', version: VERSION, api: 3, mode: 'new', core: true });
    assert.deepEqual(await (await fetch(t.base + '/api/v2/health')).json(), { ok: true, app: 'restock-server', version: VERSION, api: 2 });
    assert.equal(VERSION, '0.9.4');
    // keys.json is made at first start, 0600, and has the kex key.
    const k = JSON.parse(readFileSync(join(t.dir, 'keys.json'), 'utf8'));
    assert.ok(k.kex.pub && k.kex.priv);
    assert.equal(statSync(join(t.dir, 'keys.json')).mode & 0o777, 0o600);
  });

  test('Set up this server: a house, owned by the server, all its rows signed', async () => {
    const t = await house();
    assert.equal(t.state.mode, 'v3');
    assert.equal((await (await fetch(t.base + '/api/v3/health')).json()).house, 'Declan and Sarah');
    const g = t.web.gift;
    assert.equal(g.keyv, 1);
    assert.equal(g.household.name, 'Declan and Sarah');
    assert.equal(g.mode, 'v3');
    const pin = g.household.owner_pub;
    const e = t.R.engine;
    assert.equal(e.householdValue('owner'), 'srv-' + t.sid);
    assert.equal(e.householdValue('tabs'), 'pantry,keg,pharmacy');
    assert.equal(e.householdValue('receipts'), '1');
    const srv = core.parseServerRow(e.householdValue('server'));
    assert.equal(srv.sid, t.sid);
    assert.equal(srv.keepMonths, 12);
    assert.equal(srv.kex, JSON.parse(readFileSync(join(t.dir, 'keys.json'), 'utf8')).kex.pub);
    for (const r of rows(t, "SELECT pk, stamp, deleted, sig FROM sync_log WHERE tbl = 'household'")) {
      const v = e.householdValue(r.pk);
      assert.ok(core.verifySig(pin, core.signedText({ pk: r.pk, stamp: r.stamp, deleted: !!r.deleted, row: { v } }), r.sig), r.pk);
    }
    // The recovery copy opens with the recovery key.
    const rec = await t.web.recovery();
    assert.equal(rec.sealed, true);
    assert.match(rec.body.recovery, /^[A-Z2-7]{4}(-[A-Z2-7]{4}){7}$/);
    const copy = core.openRecovery(core.unbase32(rec.body.recovery.replace(/-/g, '')), e.householdValue('recovery'));
    assert.equal(copy.keyv, '1');
    assert.equal(copy.owner_pubkey, pin);
    // Set up only once.
    assert.equal((await t.web.post('/api/v3/setup', { name: 'Again' })).status, 409);
  });

  test("the setup page's cookie session can Set up; nobody else can; not in v2 mode", async () => {
    const t = await start();
    const b = t.browser();
    assert.equal((await b.post('/api/v3/setup', { name: 'X' })).status, 401);
    await b.setup({ passphrase: PASS, iterations: ITER });
    // A form post (another page on this computer) can't.
    assert.equal((await b.req('POST', '/api/v3/setup', { body: 'name=X', headers: { 'Content-Type': 'text/plain' } })).status, 415);
    assert.equal((await b.req('POST', '/api/v3/setup', { json: { name: 'X' }, headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
    const r = await b.post('/api/v3/setup', { name: 'Our place' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body, { ok: true, mode: 'v3', house: { name: 'Our place' } });

    const t2 = await start();
    const b2 = t2.browser();
    await b2.setup({ passphrase: PASS, iterations: ITER });
    const p = t2.phone();
    await b2.login('admin', PASS, ITER);
    const inv = (await b2.post('/api/v2/invites')).body;
    assert.equal((await p.join(inv.invite)).status, 200);
    assert.equal(t2.state.mode, 'v2');
    const s = await b2.post('/api/v3/setup', { name: 'X' });
    assert.equal(s.status, 409);
    assert.equal(s.body.error, 'mode');
  });

  test('the mode on a 0.9.3 server that phones use is v2', async () => {
    const t = await start();
    const b = t.browser();
    await b.setup({ passphrase: PASS, iterations: ITER });
    await b.login('admin', PASS, ITER);
    const inv = (await b.post('/api/v2/invites')).body;
    assert.equal((await t.phone().join(inv.invite)).status, 200);
    assert.equal(t.state.mode, 'v2');
  });

  test('the Node version check', () => {
    assert.equal(nodeProblem(), null);
    assert.equal(nodeProblem({ getBuiltinModule: undefined }), 'Restock server needs Node 22.13 or newer.');
    assert.equal(nodeProblem({ getBuiltinModule: () => undefined }), 'Restock server needs Node 22.13 or newer.');
  });
});

describe('browsers: challenge sign-in, MACs, sealed answers', () => {
  test('sign in, then every answer with household data is sealed; nothing readable without a session', async () => {
    const t = await house();
    for (const [m, p] of [
      ['GET', '/api/v3/files'],
      ['GET', '/api/v3/phones'],
      ['POST', '/api/v3/phones'],
      ['GET', '/api/v3/settings'],
      ['PUT', '/api/v3/settings'],
      ['GET', '/api/v3/recovery'],
      ['POST', '/api/v3/backup'],
      ['GET', '/api/v3/activity'],
      ['GET', '/api/v3/logs'],
      ['GET', '/api/v3/homeassistant'],
      ['PUT', '/api/v3/homeassistant'],
      ['GET', '/api/v3/history?product=x'],
      ['GET', '/api/v3/stats'],
      ['GET', '/api/v3/specials'],
      ['GET', '/api/v3/browsers'],
      ['GET', '/api/v3/session'],
      ['POST', '/api/v3/prune'],
      ['POST', '/api/v3/passphrase'],
      ['DELETE', '/api/v3/phones/x'],
      ['GET', `/api/v3/files/restock-sync-srv-${t.sid}.bin`],
      ['PUT', `/api/v3/files/restock-sync-x.bin`],
    ]) {
      const r = await fetch(t.base + p, { method: m, headers: m === 'GET' ? {} : { 'Content-Type': 'application/json' }, body: m === 'GET' ? undefined : '{}' });
      assert.equal(r.status, 401, `${m} ${p}`);
      const body = await r.json();
      assert.ok(body.error === 'auth' || body.error === 'signed-out', `${m} ${p}`);
    }
    const s = await t.web.get('/api/v3/session');
    assert.equal(s.sealed, true);
    assert.equal(s.body.kind, 'passphrase');
    assert.equal(s.body.user, 'admin');
    assert.deepEqual(Object.keys(s.body.keys), ['1']);
    for (const p of ['/api/v3/phones', '/api/v3/settings', '/api/v3/activity', '/api/v3/files', '/api/v3/browsers']) {
      const r = await t.web.get(p);
      assert.equal(r.status, 200, p);
      assert.equal(r.headers.get('content-type'), 'application/x-restock-sealed', p);
    }
  });

  test('a wrong proof, a used challenge, a bad key: refused; 10 wrong tries lock the address out', async () => {
    const t = await house();
    const ip = '10.77.0.1';
    const w = t.web3({ ip });
    assert.equal((await w.login('admin', 'not the passphrase at all ok', ITER)).status, 401);
    assert.equal((await w.login('someone', PASS, ITER)).status, 401);
    // The challenge works once.
    let used;
    const r = await w.login('admin', PASS, ITER, { tamper: (b) => (used = { ...b }) });
    assert.equal(r.status, 200);
    const again = await fetch(t.base + '/api/v3/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': ip }, body: JSON.stringify(used) });
    assert.equal(again.status, 401);
    assert.equal((await again.json()).error, 'challenge');
    assert.equal((await w.login('admin', PASS, ITER, { tamper: (b) => (b.epub = 'nope') })).status, 401);
    for (let i = 0; i < 10; i++) await t.web3({ ip: '10.77.0.2' }).login('admin', 'wrong wrong wrong wrong', ITER);
    const locked = await t.web3({ ip: '10.77.0.2' }).login('admin', PASS, ITER);
    assert.equal(locked.status, 429);
    assert.equal((await t.web3({ ip: '10.77.0.3' }).login('admin', PASS, ITER)).status, 200);
    // An unknown user's salt is fake but stable.
    const s1 = await (await fetch(t.base + '/api/v3/login/challenge?user=bob')).json();
    const s2 = await (await fetch(t.base + '/api/v3/login/challenge?user=bob')).json();
    assert.equal(s1.salt, s2.salt);
    assert.notEqual(s1.c, s2.c);
  });

  test('MACs: an altered or replayed request is refused, and so is a wrong clock', async () => {
    const t = await house();
    const w = t.web;
    const h = core.webAuthorization(w.session, w.key, 'GET', '/api/v3/phones', new Uint8Array(0));
    assert.equal((await w.raw('GET', '/api/v3/phones', { auth: h })).status, 200);
    const replay = await w.raw('GET', '/api/v3/phones', { auth: h });
    assert.equal(replay.status, 401);
    assert.equal((await replay.json()).error, 'replay');
    // Signed for another path, or another body.
    assert.equal((await w.raw('GET', '/api/v3/settings', { auth: core.webAuthorization(w.session, w.key, 'GET', '/api/v3/phones', new Uint8Array(0)) })).status, 401);
    const hb = core.webAuthorization(w.session, w.key, 'POST', '/api/v3/phones', '{"label":"A"}');
    assert.equal((await w.raw('POST', '/api/v3/phones', { body: '{"label":"B"}', headers: { 'Content-Type': 'application/json' }, auth: hb })).status, 401);
    // Another key.
    assert.equal((await w.raw('GET', '/api/v3/phones', { auth: core.webAuthorization(w.session, randomBytes(32), 'GET', '/api/v3/phones', '') })).status, 401);
    // 10 minutes off.
    const off = core.webAuthorization(w.session, w.key, 'GET', '/api/v3/phones', '', Date.now() - 10 * 60_000);
    const c = await w.raw('GET', '/api/v3/phones', { auth: off });
    assert.equal(c.status, 401);
    assert.equal((await c.json()).error, 'clock');
  });

  test('Sign out, Sign out everywhere (v3 and v2 sessions), and ending one browser', async () => {
    const t = await house();
    const a = t.web3();
    await a.login('admin', PASS, ITER);
    const b = t.web3();
    await b.login('admin', PASS, ITER);
    const list = await t.web.get('/api/v3/browsers');
    assert.equal(list.body.browsers.length, 3);
    assert.equal(list.body.browsers.filter((x) => x.current).length, 1);
    const bId = list.body.browsers.find((x) => !x.current && x.lastUsed).id;
    assert.equal((await t.web.req('DELETE', '/api/v3/browsers/' + bId)).status, 200);
    assert.equal((await t.web.get('/api/v3/browsers')).body.browsers.length, 2);
    assert.equal((await a.post('/api/v3/logout', {})).status, 200);
    assert.equal((await a.get('/api/v3/phones')).status, 401);
    const v2 = t.browser();
    await v2.login('admin', PASS, ITER).catch(() => {});
    const c = t.web3();
    await c.login('admin', PASS, ITER);
    assert.equal((await t.web.post('/api/v3/logout', { everywhere: true })).status, 200);
    assert.equal((await c.get('/api/v3/phones')).status, 401);
    assert.equal((await t.web.get('/api/v3/phones')).status, 401);
    assert.equal(Object.keys(t.state.sessions).length, 0);
  });

  test('changing the passphrase: sealed, proof of the current one, everyone else signed out', async () => {
    const t = await house();
    const other = t.web3();
    await other.login('admin', PASS, ITER);
    const ch = await (await fetch(t.base + '/api/v3/login/challenge?user=admin')).json();
    const NEW = 'tractor violet harbour cinnamon';
    const salt = b64u(randomBytes(16));
    const { derive } = await import('./client.mjs');
    const { auth } = derive(NEW, salt, ITER);
    // Plain JSON: refused (it carries a secret).
    assert.equal((await t.web.post('/api/v3/passphrase', { c: ch.c, proof: 'x', salt, auth })).status, 400);
    const bad = await t.web.req('POST', '/api/v3/passphrase', { sealed: { c: ch.c, proof: core.loginProof(randomBytes(32), ch.c, t.web.session), salt, auth } });
    assert.equal(bad.status, 403);
    const ch2 = await (await fetch(t.base + '/api/v3/login/challenge?user=admin')).json();
    const ok = await t.web.req('POST', '/api/v3/passphrase', { sealed: { c: ch2.c, proof: core.loginProof(t.web.loginKey, ch2.c, t.web.session), salt, auth } });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal((await other.get('/api/v3/phones')).status, 401);
    assert.equal((await t.web.get('/api/v3/phones')).status, 200);
    assert.equal((await t.web3().login('admin', PASS, ITER)).status, 401);
    assert.equal((await t.web3().login('admin', NEW, ITER)).status, 200);
  });

  test('v2 sign-ins and codes are refused once the household lives on the server', async () => {
    const t = await house();
    const b = t.browser();
    const r = await b.login('admin', PASS, ITER);
    assert.equal(r.status, 409);
    assert.equal(r.body.error, 'v3');
    assert.equal((await b.post('/api/v2/invites')).status, 409);
    assert.equal((await b.post('/api/v2/qrlogin')).status, 409);
  });

  test('Sign in with a phone: the phone approves, only the browser with the key can use the session', async () => {
    const t = await house();
    const p = await addPhone(t, 'Sarah');
    const e = core.newEcdhKey();
    const start = await (await fetch(t.base + '/api/v3/qrlogin', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ epub: b64u(e.pub) }) })).json();
    assert.ok(start.id && start.kex);
    const poll = () => fetch(t.base + '/api/v3/qrlogin/' + start.id).then((r) => r.json());
    assert.equal((await poll()).pending, true);
    // The phone says which browser key it saw: a different one is refused.
    assert.equal((await p.post('/api/v3/qrlogin/' + start.id, { k: b64u(core.newEcdhKey().pub) })).status, 409);
    assert.equal((await p.post('/api/v3/qrlogin/' + start.id, { k: b64u(e.pub) })).status, 200);
    const done = await poll();
    assert.equal(done.pending, false);
    const key = core.sessionKeyOf(e.priv, core.unb64(start.kex), core.unb64(start.id));
    const g = core.openRsf1(key, core.unb64(done.sealed));
    assert.deepEqual(Object.keys(g.keys), ['1']);
    assert.equal(g.device, p.device);
    // Once.
    assert.equal((await fetch(t.base + '/api/v3/qrlogin/' + start.id)).status, 404);
    const w = t.web3();
    Object.assign(w, { session: done.session, key });
    assert.equal((await w.get('/api/v3/phones')).status, 200);
    // A phone session can't do passphrase things.
    assert.equal((await w.get('/api/v3/recovery')).status, 403);
    // Removing the phone ends the sessions it let in.
    assert.equal((await t.web.removePhone(p.device)).status, 200);
    assert.equal((await w.get('/api/v3/phones')).status, 401);
  });
});

describe('phones: join, member join, upgrade, Remove, Leave', () => {
  test('Add a phone: the code, the sealed answer (only that phone opens it), once, 10 minutes', async () => {
    const t = await house();
    const c = await t.web.post('/api/v3/phones', { label: "Sister's phone" });
    const f = codeFields(c.body.code);
    assert.match(c.body.code, /^restock-server:3\?/);
    assert.ok(f.h && f.i && f.k);
    const a = t.phone3();
    const j = await a.join(c.body.code);
    assert.equal(j.status, 200);
    assert.equal(a.gift.label, "Sister's phone");
    assert.equal(a.gift.seed, true);
    assert.equal(a.gift.household.sid, t.sid);
    assert.ok(a.gift.secret);
    assert.deepEqual(a.gift.server, { home: f.h, away: null, keepMonths: 12 });
    // Someone else's kex key doesn't open it.
    assert.throws(() => core.openJoin(core.joinKey(core.newEcdhKey().priv, core.unb64(f.k), randomBytes(16)), a.device, core.unb64(j.body.sealed)));
    const member = JSON.parse(t.R.engine.householdValue('member:' + a.device));
    assert.deepEqual(member, { name: "Sister's phone", pub: a.my.pub });
    assert.equal((await t.phone3().join(c.body.code)).status, 410);
    const c2 = await t.web.post('/api/v3/phones', { label: 'Late' });
    t.clock.shift = 11 * 60_000;
    const late = t.phone3();
    late.clock = t.now;
    assert.equal((await late.join(c2.body.code)).status, 410);
    t.clock.shift = 0;
    assert.equal((await t.phone3().join('restock-server:3?i=nope&k=' + f.k)).status, 401);
    // Reserved ids.
    for (const device of ['srv-x', 'web-x', 'keys-x']) {
      const c3 = await t.web.post('/api/v3/phones', { label: 'X' });
      assert.equal((await t.phone3({ device }).join(c3.body.code)).status, 400, device);
    }
  });

  test('a phone writes its own file; another phone gets it in the server file; the device-taken rule', async () => {
    const t = await house();
    const a = await addPhone(t, 'A');
    const b = await addPhone(t, 'B');
    assert.equal(b.gift.seed, false);
    assert.equal((await a.putOwn(a.file([ent('list_entries', 'l1', Date.now(), a.device, line('l1', 'Milk'))], { shares: SHARE_PANTRY }))).status, 200);
    t.settle();
    const f = await b.serverFile(t.sid);
    assert.ok(f.entries.find((x) => x.pk === 'l1' && x.row.text === 'Milk'));
    assert.equal(f.device, 'srv-' + t.sid);
    assert.equal(f.name, 'Declan and Sarah');
    // Nobody but the server writes the server's file, or keys/.
    for (const name of [`restock-sync-srv-${t.sid}.bin`, `keys/${a.device}.bin`, `restock-sync-${b.device}.bin`]) {
      assert.equal((await a.req('PUT', '/api/v3/files/' + name, { body: a.sealFor(a.file([])) })).status, 403, name);
    }
    // The web writes only its own file.
    const webName = `restock-sync-web-${t.web.gift.webId}.bin`;
    const wf = { format: 'restock-sync', v: 1, device: 'web-' + t.web.gift.webId, name: 'Web', keyv: 1, at: new Date().toISOString(), top: 1, seen: {}, entries: [ent('list_entries', 'l2', Date.now(), 'web-' + t.web.gift.webId, line('l2', 'Bread'))] };
    assert.equal((await t.web.req('PUT', '/api/v3/files/' + webName, { body: Buffer.from(core.sealRsf1(core.unb64(t.web.gift.keys['1']), wf)) })).status, 200);
    assert.equal((await t.web.req('PUT', `/api/v3/files/restock-sync-${a.device}.bin`, { body: a.sealFor(a.file([])) })).status, 403);
    t.settle();
    assert.equal(rows(t, "SELECT text FROM list_entries WHERE id = 'l2'")[0]?.text, 'Bread');
    // The same id with another key: refused while that phone is on the server.
    const c = await t.web.post('/api/v3/phones', { label: 'Thief' });
    const thief = t.phone3({ device: a.device });
    assert.equal((await thief.join(c.body.code)).status, 409);
  });

  test('member join: a household member that isn’t on the server joins with its household key', async () => {
    const t = await house();
    const m = t.phone3({ name: 'Mum' });
    t.R.house.signMember(m.device, 'Mum', m.my.pub);
    const kex = t.R.house.kexPub();
    assert.equal((await m.memberJoin(kex, { sigBy: core.newJavaKeyPair().priv })).status, 401);
    const r = await m.memberJoin(kex);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(m.gift.label, 'Mum');
    assert.equal(m.gift.seed, false);
    assert.equal(t.state.devices[m.device].api, 3);
    assert.equal((await m.get('/api/v3/files')).status, 200);
    // Not a member at all.
    const x = t.phone3();
    assert.equal((await x.memberJoin(kex)).status, 401);
  });

  test('Remove: a new household key, keys/ for the others (theirs only), the removed phone refused, nothing deleted', async () => {
    const t = await house();
    const a = await addPhone(t, 'A');
    const b = await addPhone(t, 'B');
    const gone = await addPhone(t, 'Stolen');
    await gone.putOwn(gone.file([ent('items', 'i-gone', Date.now(), gone.device, item('i-gone'))], { shares: SHARE_PANTRY }));
    t.settle();
    const r = await t.web.removePhone(gone.device);
    assert.equal(r.status, 200);
    assert.equal(r.body.keyv, 2);
    const e = t.R.engine;
    assert.equal(e.householdValue('member:' + gone.device), null);
    assert.ok(e.householdValue('removed:' + gone.device));
    // Refused from now on, as removed.
    const x = await gone.get('/api/v3/files');
    assert.equal(x.status, 401);
    assert.equal(x.body.error, 'removed');
    // keys/<device>.bin: each phone reads only its own (the listing shows only its own too).
    const la = (await a.get('/api/v3/files')).body.files.map((f) => f.name);
    assert.ok(la.includes(`keys/${a.device}.bin`));
    assert.ok(!la.includes(`keys/${b.device}.bin`));
    assert.equal((await a.getFile(`keys/${b.device}.bin`)).status, 404);
    assert.equal((await t.web.req('GET', `/api/v3/files/keys/${a.device}.bin`)).status, 404);
    assert.ok(!(await t.web.get('/api/v3/files')).body.files.some((f) => f.name.startsWith('keys/')));
    // The server's file is now sealed with the new key: a phone takes it from keys/ first.
    assert.throws(() => core.openRsf1(core.unb64(a.serverKeys['1']), new Uint8Array(1)));
    const k = await a.takeKeysFile();
    assert.equal(k.status, 200);
    assert.equal(a.keyv, 2);
    const own = await a.serverFile(t.sid);
    assert.equal(own.keyv, 2);
    assert.ok(own.entries.find((x) => x.pk === 'removed:' + gone.device));
    // A browser asks again for the keys (GET /api/v3/session) and gets the new one too.
    const s = await t.web.get('/api/v3/session');
    assert.deepEqual(Object.keys(s.body.keys).sort(), ['1', '2']);
    assert.equal(s.body.keyv, 2);
    // Nothing it shared was deleted; its file is still there.
    assert.equal(rows(t, "SELECT id FROM items WHERE id = 'i-gone'").length, 1);
    assert.ok(existsSync(join(t.dir, 'files', `restock-sync-${gone.device}.bin`)));
    assert.ok(!own.entries.some((x) => x.pk === 'i-gone' && x.deleted));
    // The recovery copy has the new key and not the removed phone's secret.
    const rec = (await t.web.recovery()).body.recovery;
    const copy = core.openRecovery(core.unbase32(rec.replace(/-/g, '')), e.householdValue('recovery'));
    assert.equal(copy.keyv, '2');
    assert.equal(copy.secrets[gone.device], undefined);
    assert.ok(copy.secrets[a.device]);
    // The phones list still shows it, as Removed.
    const ph = (await t.web.get('/api/v3/phones')).body.phones.find((p) => p.device === gone.device);
    assert.equal(ph.status, 'removed');
    // Only a passphrase session removes.
    assert.equal((await t.web.removePhone(gone.device)).status, 404);
  });

  test('Leave: status left, its member row goes, no rekey', async () => {
    const t = await house();
    const a = await addPhone(t, 'A');
    assert.equal((await a.req('DELETE', '/api/v3/devices/someone-else')).status, 403);
    const r = await a.req('DELETE', '/api/v3/devices/' + a.device);
    assert.equal(r.status, 200);
    assert.equal(t.state.devices[a.device].status, 'left');
    assert.equal(t.R.engine.householdValue('member:' + a.device), null);
    assert.equal(t.R.engine.householdValue('removed:' + a.device), null);
    assert.equal(t.R.keys.data.keyv, 1);
    assert.equal((await a.get('/api/v3/files')).status, 401);
    // It can come back with a new code (same key).
    const c = await t.web.post('/api/v3/phones', { label: 'A again' });
    const again = new V3Phone(t.base, { device: a.device, clock: t.now });
    again.keys = a.keys;
    assert.equal((await again.join(c.body.code)).status, 200);
  });

  test('renaming a phone signs its member row', async () => {
    const t = await house();
    const a = await addPhone(t, 'A');
    assert.equal((await t.web.req('PATCH', '/api/v3/phones/' + a.device, { json: { label: 'Kitchen tablet' } })).status, 200);
    assert.deepEqual(JSON.parse(t.R.engine.householdValue('member:' + a.device)), { name: 'Kitchen tablet', pub: a.my.pub });
  });
});

describe('what each phone shares (D9), and taking it back (section 14)', () => {
  test('entries outside a phone’s shares are passed over; its own deletes of them are taken', async () => {
    const t = await house();
    const all = await addPhone(t, 'All');
    const groc = await addPhone(t, 'Groceries only');
    const now = Date.now();
    await all.putOwn(all.file([ent('items', 'k-all', now, all.device, item('k-all', 'keg'))], { shares: SHARE_ALL }));
    t.settle();
    await groc.putOwn(
      groc.file(
        [
          ent('items', 'k-groc', now, groc.device, item('k-groc', 'keg')),
          ent('items', 'p-groc', now, groc.device, item('p-groc', 'pantry')),
          ent('receipts', 'r1', now, groc.device, { id: 'r1', scanned_at: new Date().toISOString(), section: 'pantry' }),
          ent('items', 'k-all', now + 5, groc.device, null, { moved: true, created: now - 1 }),
          ent('items', 'k-all', now + 6, groc.device, null, { created: now - 1 }),
        ],
        { shares: SHARE_PANTRY },
      ),
    );
    t.settle();
    assert.deepEqual(rows(t, 'SELECT id FROM items ORDER BY id').map((r) => r.id), ['k-all', 'p-groc']);
    assert.equal(rows(t, 'SELECT 1 FROM receipts').length, 0);
    const log = (await t.web.get('/api/v3/logs')).body.logs.find((l) => l.what === 'merged' && l.device === groc.device);
    assert.equal(log.detail.dropped, 4);
    // "Also take what this phone shared off the server": it shared a keg item, turned keg off, deletes it.
    await groc.putOwn(groc.file([ent('items', 'k2', now + 10, groc.device, item('k2', 'keg'))], { shares: { tabs: ['pantry', 'keg'], receipts: false, cards: false } }));
    t.settle();
    assert.equal(rows(t, "SELECT 1 FROM items WHERE id = 'k2'").length, 1);
    await groc.putOwn(groc.file([ent('items', 'k2', now + 20, groc.device, null, { created: now })], { shares: SHARE_PANTRY }));
    t.settle();
    assert.equal(rows(t, "SELECT 1 FROM items WHERE id = 'k2'").length, 0);
    const own = await all.serverFile(t.sid);
    assert.ok(own.entries.find((x) => x.pk === 'k2' && x.deleted));
    // The phones list says what each shares.
    const ph = (await t.web.get('/api/v3/phones')).body.phones.find((p) => p.device === groc.device);
    assert.deepEqual(ph.shares, SHARE_PANTRY);
  });

  test('loyalty card numbers never reach household.db; the server file has no cards', async () => {
    const t = await house();
    const a = await addPhone(t, 'A');
    await a.putOwn(a.file([ent('cards', 'c1', Date.now(), a.device, { id: 'c1', program: 'flybuys', label: 'F', number: '6008943212345678', created_at: 'x' })], { shares: { ...SHARE_PANTRY, cards: true } }));
    t.settle();
    assert.deepEqual(rows(t, 'SELECT number FROM cards'), [{ number: '' }]);
    assert.ok(!(await a.serverFile(t.sid)).entries.some((x) => x.tbl === 'cards'));
    assert.ok(!readFileSync(join(t.dir, 'household.db')).includes(Buffer.from('6008943212345678')));
  });

  test('household default branches (branch:<chain>) only in their shape; shared specials kept per chain and passed on', async () => {
    const t = await house();
    const a = await addPhone(t, 'A');
    const now = Date.now();
    const hs = (k, v, s = now) => ent('household_settings', k, s, a.device, { k, v: JSON.stringify(v) });
    const at = new Date().toISOString();
    await a.putOwn(
      a.file([hs('branch:coles', { name: 'Coles Kirwan', storeNo: '0844' }), hs('branch:woolworths', { name: 'W', evil: 'x' }), hs('branch:../x', { name: 'x' })], {
        shares: SHARE_PANTRY,
        specials: {
          at,
          lists: [
            { chain: 'coles', at, items: [{ storeProductId: '123', name: 'Tim Tams', price: 3.5, wasPrice: 5, promo: '1/2 price', imageUrl: 'https://productimages.coles.com.au/x.jpg', isSpecial: true, extra: 'dropped' }] },
            { chain: 'danmurphys', at, items: [{ storeProductId: '9', name: 'Beer', price: 50 }] },
            { chain: 'BAD CHAIN', at, items: [] },
          ],
        },
        catalogues: { coles: { url: 'https://www.coles.com.au/catalogues', note: 'This week' }, aldi: { url: 'javascript:alert(1)' } },
      }),
    );
    t.settle();
    assert.deepEqual(rows(t, "SELECT k FROM household_settings WHERE k LIKE 'branch:%'").map((r) => r.k), ['branch:coles']);
    const own = await a.serverFile(t.sid);
    // Dan Murphy's is on the Keg tab, which this phone doesn't share.
    assert.deepEqual(own.specials.lists.map((l) => l.chain), ['coles']);
    assert.deepEqual(own.specials.lists[0].items[0], { storeProductId: '123', name: 'Tim Tams', price: 3.5, wasPrice: 5, promo: '1/2 price', imageUrl: 'https://productimages.coles.com.au/x.jpg', isSpecial: true });
    assert.deepEqual(own.catalogues, { coles: { url: 'https://www.coles.com.au/catalogues', note: 'This week' } });
    const sp = await t.web.get('/api/v3/specials');
    assert.equal(sp.body.lists.length, 1);
    // An older list doesn't replace a newer one.
    const old = new Date(now - DAY).toISOString();
    await a.putOwn(a.file([], { shares: SHARE_PANTRY, specials: { at: old, lists: [{ chain: 'coles', at: old, items: [] }] } }));
    t.settle();
    assert.equal((await a.serverFile(t.sid)).specials.lists[0].items.length, 1);
  });
});

describe('Keep data for', () => {
  test('old prices and receipts never come in; changing it prunes quietly (no deletes go out); archives and logs too', async () => {
    const t = await house();
    const a = await addPhone(t, 'A');
    const now = Date.now();
    const share = { tabs: ['pantry'], receipts: true, cards: false };
    const price = (pid, d, p) => ent('prices', `${pid}|${daysAgo(d)}`, now, a.device, { product_id: pid, date: daysAgo(d), price: p, source: 'check' });
    await a.putOwn(
      a.file(
        [
          ent('products', 'p1', now, a.device, { id: 'p1', chain: 'coles', name: 'Milk', created_at: 'x' }),
          price('p1', 10, 3),
          price('p1', 100, 2.5),
          price('p1', 500, 2),
          ent('receipts', 'r-new', now, a.device, { id: 'r-new', scanned_at: daysAgo(5), section: 'pantry', pinned: 0, photo: 'receipts/new.jpg' }),
          ent('receipts', 'r-mid', now, a.device, { id: 'r-mid', scanned_at: daysAgo(150), section: 'pantry', pinned: 0, photo: 'receipts/mid.jpg' }),
          ent('receipts', 'r-old', now, a.device, { id: 'r-old', scanned_at: daysAgo(500), section: 'pantry', pinned: 0 }),
        ],
        { shares: share, photos: { 'receipts/mid.jpg': 'b'.repeat(64) } },
      ),
    );
    // A photo and archives: one month from long ago, one recent.
    await a.req('PUT', `/api/v3/files/photos/${'b'.repeat(64)}.bin`, { body: a.sealFor({ format: 'restock-photo' }) });
    const oldMonth = daysAgo(400).slice(0, 7);
    const newMonth = daysAgo(1).slice(0, 7);
    await a.req('PUT', `/api/v3/files/archive/${a.device}/${oldMonth}.bin`, { body: a.sealFor({ format: 'restock-archive', device: a.device, prices: [] }) });
    await a.req('PUT', `/api/v3/files/archive/${a.device}/${newMonth}.bin`, { body: a.sealFor({ format: 'restock-archive', device: a.device, prices: [] }) });
    t.settle();
    // 12 months: the 500-day-old price and receipt never came in.
    assert.deepEqual(rows(t, 'SELECT price FROM prices ORDER BY date').map((r) => r.price), [2.5, 3]);
    assert.deepEqual(rows(t, 'SELECT id FROM receipts ORDER BY id').map((r) => r.id), ['r-mid', 'r-new']);
    t.R.merger.logLine('log', 'ancient', null, null);
    t.R.merger.raw().prepare("UPDATE srv_log SET at = ? WHERE what = 'ancient'").run(daysAgo(200));
    const deletes = () => rows(t, 'SELECT COUNT(*) AS n FROM sync_log WHERE deleted = 1')[0].n;
    const before = deletes();
    // 3 months: keeping less deletes data, so it needs the passphrase again (0.9.4 review).
    const no = await t.web.put('/api/v3/settings', { keepMonths: 3 });
    assert.equal(no.status, 403);
    assert.equal(no.body.error, 'confirm');
    assert.equal(rows(t, 'SELECT COUNT(*) AS n FROM prices')[0].n, 2);
    const wrong = await t.web.put('/api/v3/settings', { keepMonths: 3, confirm: await t.web.confirm(Buffer.alloc(32, 7)) });
    assert.equal(wrong.status, 403);
    assert.equal(wrong.body.error, 'current');
    assert.equal(core.parseServerRow(t.R.engine.householdValue('server')).keepMonths, 12);
    const s = await t.web.put('/api/v3/settings', { keepMonths: 3, confirm: await t.web.confirm() });
    assert.equal(s.status, 200);
    assert.equal(s.body.keepMonths, 3);
    assert.deepEqual(rows(t, 'SELECT price FROM prices ORDER BY date').map((r) => r.price), [3]);
    assert.deepEqual(rows(t, 'SELECT id FROM receipts').map((r) => r.id), ['r-new']);
    assert.equal(deletes(), before);
    assert.equal(rows(t, "SELECT 1 FROM srv_log WHERE what = 'ancient'").length, 0);
    const names = (await a.get('/api/v3/files')).body.files.map((f) => f.name);
    assert.ok(!names.includes(`archive/${a.device}/${oldMonth}.bin`));
    assert.ok(names.includes(`archive/${a.device}/${newMonth}.bin`));
    assert.ok(!names.includes(`photos/${'b'.repeat(64)}.bin`));
    // To the trash, not gone.
    const trash = readdirSync(join(t.dir, 'trash'));
    assert.ok(trash.length >= 1);
    // The signed server row says 3, and the server's file has no deletes for what went.
    assert.equal(core.parseServerRow(t.R.engine.householdValue('server')).keepMonths, 3);
    const own = await a.serverFile(t.sid);
    assert.ok(!own.entries.some((x) => x.deleted && (x.tbl === 'prices' || x.tbl === 'receipts')));
    // Until I delete, and Delete older data now.
    assert.equal((await t.web.put('/api/v3/settings', { keepMonths: 7 })).status, 400);
    assert.equal((await t.web.put('/api/v3/settings', { keepMonths: null })).body.keepMonths, null);
    assert.equal(core.parseServerRow(t.R.engine.householdValue('server')).keepMonths, null);
    // Delete older data now: the passphrase again too, and a challenge works once.
    assert.equal((await t.web.post('/api/v3/prune', { before: daysAgo(2) })).status, 403);
    assert.equal(rows(t, 'SELECT COUNT(*) AS n FROM receipts')[0].n, 1);
    const confirm = await t.web.confirm();
    const p = await t.web.post('/api/v3/prune', { before: daysAgo(2), confirm });
    assert.equal(p.status, 200);
    assert.equal(rows(t, 'SELECT COUNT(*) AS n FROM receipts')[0].n, 0);
    assert.equal((await t.web.post('/api/v3/prune', { before: daysAgo(2), confirm })).status, 403);
    assert.equal((await t.web.post('/api/v3/prune', { before: new Date(now + DAY).toISOString() })).status, 400);
    // From Until I delete to any window deletes data; keeping more (or Until I delete) deletes nothing.
    assert.equal((await t.web.put('/api/v3/settings', { keepMonths: 6 })).status, 403);
    assert.equal((await t.web.put('/api/v3/settings', { keepMonths: 6, confirm: await t.web.confirm() })).status, 200);
    assert.equal((await t.web.put('/api/v3/settings', { keepMonths: 12 })).status, 200);
    assert.equal((await t.web.put('/api/v3/settings', { keepMonths: null })).status, 200);
  });
});

describe('files: names, sizes, history and stats', () => {
  test('v3 names: no v2 keys files or webkeys/, no traversal; sizes capped; nobody uploads without signing', async () => {
    const t = await house({ maxFileMb: 1 });
    const a = await addPhone(t, 'A');
    for (const n of ['restock-sync-keys-h1.json', 'webkeys/abcdefgh.bin', 'keys/../x.bin', '../state.json', 'archive/x/2026-13.bin', 'photos/xyz.bin', 'keys.json', '%2e%2e%2fstate.json']) {
      assert.equal(parseNameV3(decodeURIComponent(n)), null, n);
      const r = await a.req('GET', '/api/v3/files/' + n);
      assert.ok(r.status === 400 || r.status === 404, n + ' ' + r.status);
    }
    const raw = await new Promise((ok) => {
      request(t.base + '/', { path: '/api/v3/files/..%2f..%2fkeys.json', method: 'GET' }, (r) => {
        r.resume();
        ok(r.statusCode);
      }).end();
    });
    assert.notEqual(raw, 200);
    const big = Buffer.concat([Buffer.from('RSF1'), randomBytes(2 * 1024 * 1024)]);
    assert.equal((await a.req('PUT', `/api/v3/files/restock-sync-${a.device}.bin`, { body: big })).status, 413);
    assert.equal((await a.req('PUT', `/api/v3/files/restock-sync-${a.device}.bin`, { body: Buffer.from('not sealed, not at all, no no no no no') })).status, 400);
    const r = await fetch(t.base + '/api/v3/files/restock-sync-x.bin', { method: 'PUT', body: big });
    assert.equal(r.status, 401);
  });

  test('history and stats from household.db', async () => {
    const t = await house();
    const a = await addPhone(t, 'A');
    const now = Date.now();
    await a.putOwn(
      a.file(
        [
          ent('products', 'p1', now, a.device, { id: 'p1', chain: 'coles', name: 'Milk', created_at: 'x' }),
          ent('prices', 'p1|' + daysAgo(40), now, a.device, { product_id: 'p1', date: daysAgo(40), price: 3, source: 'check' }),
          ent('prices', 'p1|' + daysAgo(3), now, a.device, { product_id: 'p1', date: daysAgo(3), price: 2, was_price: 3, is_special: 1, promo: 'Save $1', source: 'check' }),
          ent('receipts', 'r1', now, a.device, { id: 'r1', scanned_at: daysAgo(1), section: 'pantry', total: 42.5 }),
        ],
        { shares: { tabs: ['pantry'], receipts: true, cards: false } },
      ),
    );
    t.settle();
    const h = await t.web.get('/api/v3/history?product=p1');
    assert.deepEqual(h.body.prices.map((p) => p.price), [3, 2]);
    assert.deepEqual(Object.keys(h.body.prices[0]).sort(), ['date', 'is_special', 'member_only', 'price', 'product_id', 'promo', 'source', 'was_price']);
    assert.equal((await t.web.get('/api/v3/history?product=p1&from=' + daysAgo(10))).body.prices.length, 1);
    const st = await t.web.get('/api/v3/stats?months=3');
    const month = st.body.months.find((m) => m.month === daysAgo(1).slice(0, 7));
    assert.equal(month.receipts.pantry, 42.5);
    const sp = await t.web.get('/api/v3/specials');
    assert.equal(sp.body.specials[0].product_id, 'p1');
  });

  test('the activity log says who did what; household.db and state survive a restart', async () => {
    const t = await house();
    const a = await addPhone(t, 'A');
    await a.putOwn(a.file([ent('items', 'i1', Date.now(), a.device, item('i1'))], { shares: SHARE_PANTRY }));
    t.settle();
    const act = (await t.web.get('/api/v3/activity')).body.activity;
    assert.ok(act.find((x) => x.what === 'phone-joined' && x.device === a.device && x.who === 'A'));
    assert.ok(act.find((x) => x.what === 'upload'));
    for (const x of act) assert.deepEqual(Object.keys(x).sort(), ['at', 'detail', 'device', 'kind', 'what', 'who']);
  });
});

describe('taken back, brought in, and the pages', () => {
  test('a phone takes the household back with the recovery key: the server stops acting as owner, then can start afresh', async () => {
    const t = await house();
    const a = await addPhone(t, 'A');
    const rec = (await t.web.recovery()).body.recovery;
    const copy = core.openRecovery(core.unbase32(rec.replace(/-/g, '')), t.R.engine.householdValue('recovery'));
    // Take over (0.9.0's): the phone signs owner = itself with the owner key from the recovery copy.
    const e = { tbl: 'household', pk: 'owner', stamp: Date.now() + 10_000, device: a.device, deleted: false, created: Date.now(), row: { k: 'owner', v: a.device } };
    e.sig = core.signWithPkcs8(copy.owner_priv, core.signedText(e));
    await a.putOwn(a.file([e], { shares: SHARE_PANTRY }));
    t.settle();
    assert.equal(t.state.mode, 'released');
    assert.equal(t.state.releasedBy, a.device);
    const r = await a.get('/api/v3/files');
    assert.equal(r.status, 409);
    assert.equal(r.body.error, 'released');
    assert.equal((await (await fetch(t.base + '/api/v3/health')).json()).mode, 'released');
    // Start afresh: a new house, the old files in the trash.
    assert.equal((await t.web.post('/api/v3/setup', { name: 'New start' })).status, 409);
    const s = await t.web.post('/api/v3/setup', { name: 'New start', afresh: true });
    assert.equal(s.status, 200, JSON.stringify(s.body));
    assert.equal(t.state.mode, 'v3');
    assert.equal(t.R.engine.householdValue('name'), 'New start');
    assert.equal(Object.keys(t.state.devices).length, 0);
    assert.ok(!existsSync(join(t.dir, 'files', `restock-sync-${a.device}.bin`)));
  });

  test('a phone household brought onto a new server by its owner phone', async () => {
    const t = await house({}, { name: 'Our server' });
    const key = randomBytes(32);
    const owner = core.newJavaKeyPair();
    const c = await t.web.post('/api/v3/phones', { label: "Declan's phone" });
    const f = codeFields(c.body.code);
    const p = t.phone3();
    const e = core.newEcdhKey();
    const payload = { format: 'restock-handover', v: 3, key: b64u(key), keyv: 3, serverKeys: { 2: b64u(randomBytes(32)) }, owner_priv: owner.priv, owner_pubkey: owner.pub, owner_secrets: { other1: b64u(randomBytes(32)) }, secret: b64u(randomBytes(32)), hid: 'hidXYZ123', name: 'Phone house' };
    const bring = { epub: b64u(e.pub), sealed: b64u(core.sealHandover(core.handoverKey(e.priv, core.unb64(f.k), core.unb64(f.i)), payload)) };
    const j = await p.join(c.body.code, { bring });
    assert.equal(j.status, 200, JSON.stringify(j.body));
    assert.equal(p.gift.keyv, 3);
    assert.equal(p.gift.keys['3'], b64u(key));
    assert.ok(p.gift.serverKeys['2']);
    assert.equal(p.gift.household.owner_pub, owner.pub);
    assert.equal(p.gift.household.hid, 'hidXYZ123');
    assert.equal(p.gift.household.name, 'Our server');
    assert.equal(p.gift.seed, false);
    assert.equal(t.R.engine.householdValue('owner'), 'srv-' + t.sid);
    assert.equal(t.R.engine.householdValue('owner_pub'), owner.pub);
    // Its own tabs and receipts until its owner phone's file is in and every member is on the server (D10).
    assert.equal(t.R.engine.householdValue('tabs'), null);
    // The household's other members can now join through the household (their rows come with the owner's file).
    const m = t.phone3();
    const signed = (k, v) => {
      const row = { tbl: 'household', pk: k, stamp: Date.now() - 1000, device: p.device, deleted: false, created: Date.now() - 1000, row: { k, v } };
      row.sig = core.signWithPkcs8(owner.priv, core.signedText(row));
      return row;
    };
    await p.putOwn(p.file([signed('member:' + m.device, JSON.stringify({ name: 'Mum', pub: m.my.pub })), signed('tabs', 'pantry'), signed('receipts', '0')], { shares: SHARE_PANTRY }));
    t.settle();
    assert.equal(t.R.engine.householdValue('tabs'), 'pantry');
    assert.equal(t.R.engine.householdValue('receipts'), '0');
    assert.equal((await m.memberJoin(f.k)).status, 200);
    // Every member is on the server now: widened.
    assert.equal(t.R.engine.householdValue('tabs'), 'pantry,keg,pharmacy');
    assert.equal(t.R.engine.householdValue('receipts'), '1');
    // Once a phone has joined, nobody can bring another household.
    const c2 = await t.web.post('/api/v3/phones', { label: 'X' });
    const again = await t.phone3().join(c2.body.code, { bring });
    assert.equal(again.status, 409);
    assert.equal(again.body.error, 'not-empty');
  });

  test('the setup page has Set up this server; the app page may show the shops’ product photos only', async () => {
    const t = await start();
    const r = await fetch(t.base + '/setup/');
    assert.match(await r.text(), /Set up this server/);
    assert.match(r.headers.get('content-security-policy'), /img-src 'self' data: blob:;/);
    const b = t.browser();
    await b.setup({ passphrase: PASS, iterations: ITER });
    const app = await b.raw('GET', '/');
    const csp = app.headers.get('content-security-policy');
    assert.match(csp, /img-src 'self' data: blob: https:\/\/\*\.woolworths\.media https:\/\/productimages\.coles\.com\.au/);
    assert.doesNotMatch(csp, /img-src[^;]* https:(;| )/);
    assert.match(csp, /connect-src 'self'/);
  });
});
