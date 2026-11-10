// 0.9.4: handing a 0.9.3 server household to the server (docs/server-v3-design.md section 7): the
// happy path, every crash point (RESTOCK_TEST_CRASH, in a real server process), refusals, the v2
// phones and browsers afterwards.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, mkdtempSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { start, stop, v2Household, handoverBody, rows, ent, item, ITER, PASS, core, b64u, Phone, Browser, forget } from './helpers.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

async function code(t) {
  const r = await t.web.post('/api/v3/handover', {});
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.match(r.body.code, /^restock-handover:3\?/);
  return r.body.code;
}
const handover = (t, h, opts) => t.owner.req('POST', '/api/v3/handover/' + h.token, { json: h.json, ...opts });

describe('the handover', () => {
  test('happy path: the server becomes the owner; phones are told to update and upgrade; nothing re-pinned', async () => {
    const t = await v2Household();
    assert.equal(t.state.mode, 'v2');
    // The owner phone sees v2 mode on v3 health.
    assert.equal((await (await fetch(t.base + '/api/v3/health')).json()).mode, 'v2');
    const h = handoverBody(await code(t), t.hh, t.owner);
    const r = await handover(t, h);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(t.state.mode, 'v3');
    const e = t.R.engine;
    const sid = t.state.sid;
    assert.equal(e.householdValue('owner'), 'srv-' + sid);
    assert.equal(e.householdValue('name'), 'The Plenty house');
    // The household's own tabs and receipts stay as they were while 0.9.3 phones are on it.
    assert.equal(e.householdValue('tabs'), 'pantry');
    assert.equal(e.householdValue('receipts'), '0');
    assert.equal(e.householdValue('owner_pub'), t.hh.owner.pub); // the same owner key: phones keep their pin
    assert.ok(e.householdValue('member:' + t.other.device));
    assert.equal(rows(t, "SELECT id FROM items ORDER BY id").map((x) => x.id).join(','), 'i-bread,i-milk');
    assert.equal(JSON.parse(readFileSync(join(t.dir, 'keys.json'), 'utf8')).handoverPending, undefined);
    assert.ok(!existsSync(join(t.dir, 'activity.jsonl')));
    // The server's own file, sealed with the household's serverKey, with the signed owner change.
    const f = core.openRsf1(t.hh.serverKey, readFileSync(join(t.dir, 'files', `restock-sync-srv-${sid}.bin`)));
    const ow = f.entries.find((x) => x.pk === 'owner');
    assert.equal(ow.row.v, 'srv-' + sid);
    assert.ok(core.verifySig(t.hh.owner.pub, core.signedText(ow), ow.sig));
    // v2 phones: 403 update with api 3; nothing forgotten.
    for (const p of [t.owner, t.other]) {
      const x = await p.get('/api/v2/files');
      assert.equal(x.status, 403);
      assert.equal(x.body.error, 'update');
      assert.equal(x.body.api, 3);
    }
    // A 0.9.4 phone upgrades with its v2 key, and gets the keys and its label.
    const kex = (await (await fetch(t.base + '/api/v3/login/challenge?user=admin')).json()).kex;
    const u = await t.other.upgrade(kex);
    assert.equal(u.status, 200, JSON.stringify(u.body));
    assert.equal(t.other.gift.label, 'Sarah');
    assert.equal(t.other.gift.keys['1'], b64u(t.hh.key));
    assert.equal((await t.other.get('/api/v3/files')).status, 200);
    // A phone that hasn't upgraded can't use v3 (but may upgrade).
    assert.equal((await t.owner.get('/api/v3/files')).status, 403);
    // The retry after the 200 got lost: done.
    const again = await handover(t, h);
    assert.equal(again.status, 409);
    assert.equal(again.body.error, 'done');
    // The activity moved into srv_log.
    const act = rows(t, "SELECT what FROM srv_log WHERE kind = 'activity'").map((x) => x.what);
    assert.ok(act.includes('phone-added'));
    assert.ok(act.includes('handover-done'));
  });

  test('an old v2 browser session still reads files, and its file is merged', async () => {
    const t = await v2Household();
    const h = handoverBody(await code(t), t.hh, t.owner);
    assert.equal((await handover(t, h)).status, 200);
    const list = await t.web.get('/api/v2/files');
    assert.equal(list.status, 200);
    assert.ok(list.body.files.every((f) => !f.name.startsWith('keys/')));
    const own = await t.web.req('GET', `/api/v2/files/restock-sync-srv-${t.state.sid}.bin`);
    assert.equal(own.status, 200);
    // New v2 sign-ins aren't.
    assert.equal((await new Browser(t.base).login('admin', PASS, ITER)).status, 409);
  });

  test('refused before anything changes: wrong key, wrong owner, another phone, a replayed or made-up token', async () => {
    const t = await v2Household();
    const wrongKey = handoverBody(await code(t), t.hh, t.owner, { key: randomBytes(32) });
    let r = await handover(t, wrongKey);
    assert.equal(r.status, 409);
    assert.equal(r.body.error, 'handover');
    assert.equal(t.state.mode, 'v2');
    assert.ok(!existsSync(join(t.dir, 'household.db')));
    // Replayed (the token works once).
    r = await handover(t, wrongKey);
    assert.equal(r.status, 404);
    // Another owner key than the household's.
    r = await handover(t, handoverBody(await code(t), t.hh, t.owner, { ownerKey: core.newJavaKeyPair() }));
    assert.equal(r.status, 409);
    // A phone that isn't the owner.
    const h = handoverBody(await code(t), t.hh, t.owner);
    r = await t.other.req('POST', '/api/v3/handover/' + h.token, { json: h.json });
    assert.equal(r.status, 409);
    // Made up.
    r = await handover(t, { token: b64u(randomBytes(32)), json: h.json });
    assert.equal(r.status, 404);
    // Not a phone.
    assert.equal((await t.web.req('POST', '/api/v3/handover/' + h.token, { json: h.json })).status, 401);
    assert.equal(t.state.mode, 'v2');
    assert.equal(JSON.parse(readFileSync(join(t.dir, 'keys.json'), 'utf8')).owner, undefined);
    // Still works afterwards.
    r = await handover(t, handoverBody(await code(t), t.hh, t.owner));
    assert.equal(r.status, 200);
  });

  test('Home Assistant moves with the owner phone, sealed in the handover (its token never answered back)', async () => {
    const t = await v2Household();
    const TOKEN = 'eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.test-token-' + b64u(randomBytes(12));
    const state = { pairs: [{ id: 'l-milk', uid: 'u1', r: { s: 'Milk', c: false }, h: { s: 'Milk', c: false } }], pick: [] };
    const h = handoverBody(await code(t), t.hh, t.owner, { ha: { address: 'http://127.0.0.1:1', entity: 'todo.shopping_list', enabled: true, token: TOKEN, state } });
    assert.equal((await handover(t, h)).status, 200);
    assert.equal(t.R.keys.data.ha.token, TOKEN);
    assert.deepEqual(JSON.parse(rows(t, "SELECT value FROM kv WHERE key = 'homeAssistantState'")[0].value), state);
    // ha:phone = the server, noted as the server's change, in the server's own file (the old HA phone stops on it).
    const sid = t.state.sid;
    assert.equal(JSON.parse(t.R.engine.db.query("SELECT v FROM household_settings WHERE k = 'ha:phone'")[0].v), 'srv-' + sid);
    assert.equal(rows(t, "SELECT device FROM sync_log WHERE tbl = 'household_settings' AND pk = 'ha:phone'")[0].device, 'srv-' + sid);
    const own = core.openRsf1(t.hh.serverKey, readFileSync(join(t.dir, 'files', `restock-sync-srv-${sid}.bin`)));
    const row = own.entries.find((x) => x.tbl === 'household_settings' && x.pk === 'ha:phone');
    assert.equal(JSON.parse(row.row.v), 'srv-' + sid);
    assert.equal(row.device, 'srv-' + sid);
    t.R.ha.stop();
  });
});

// ---------- crash points: a real server process that stops part-way ----------

function freePort() {
  return new Promise((ok) => {
    const s = createServer().listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => ok(p));
    });
  });
}
async function child(dir, crash) {
  const port = await freePort();
  const p = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', join(ROOT, 'src/server.mjs')], {
    env: { ...process.env, DATA_DIR: dir, PORT: String(port), HOST: '127.0.0.1', RESTOCK_QUIET: '1', RESTOCK_TRUST_PROXY: '1', RESTOCK_TEST_CRASH: crash },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let err = '';
  p.stderr.on('data', (d) => (err += d));
  const exited = new Promise((ok) => p.on('exit', (code) => ok(code)));
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/api/v2/health`)).ok) break;
    } catch {
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  return { base: `http://127.0.0.1:${port}`, exited, err: () => err, kill: () => p.kill() };
}

describe("the household's tabs after the handover (D10)", () => {
  test('a 0.9.3 phone stays on its old tabs; all three and receipts only once the last member upgrades', async () => {
    const t = await v2Household();
    assert.equal((await handover(t, handoverBody(await code(t), t.hh, t.owner))).status, 200);
    const e = t.R.engine;
    const sid = t.state.sid;
    const kex = (await (await fetch(t.base + '/api/v3/login/challenge?user=admin')).json()).kex;
    // A keg item from a 0.9.4 phone that shares keg: not taken while the household shares only groceries.
    assert.equal((await t.other.upgrade(kex)).status, 200);
    const now = Date.now();
    await t.other.putOwn(t.other.file([ent('items', 'k-beer', now, t.other.device, item('k-beer', 'keg', 'Beer'))], { shares: { tabs: ['pantry', 'keg'], receipts: false, cards: false } }));
    t.settle();
    // The owner phone is still on 0.9.3 (not upgraded): nothing widens. What it reads (the server's
    // file, with the old key) still says groceries only.
    assert.equal(e.householdValue('tabs'), 'pantry');
    assert.equal(e.householdValue('receipts'), '0');
    const f = core.openRsf1(t.hh.serverKey, readFileSync(join(t.dir, 'files', `restock-sync-srv-${sid}.bin`)));
    assert.equal(f.entries.find((x) => x.pk === 'tabs')?.row?.v ?? 'pantry', 'pantry');
    assert.ok(!f.entries.some((x) => x.pk === 'k-beer'));
    assert.equal(rows(t, "SELECT 1 FROM items WHERE id = 'k-beer'").length, 0);
    assert.ok(!rows(t, 'SELECT what FROM srv_log').some((r) => r.what === 'household-widened'));
    // The last member upgrades: widened, signed, logged, and what was passed over comes in.
    assert.equal((await t.owner.upgrade(kex)).status, 200);
    assert.equal(e.householdValue('tabs'), 'pantry,keg,pharmacy');
    assert.equal(e.householdValue('receipts'), '1');
    for (const pk of ['tabs', 'receipts']) {
      const r = rows(t, "SELECT stamp, sig FROM sync_log WHERE tbl = 'household' AND pk = ?", pk)[0];
      assert.ok(core.verifySig(t.hh.owner.pub, core.signedText({ pk, stamp: r.stamp, row: { v: e.householdValue(pk) } }), r.sig), pk);
    }
    const log = rows(t, "SELECT detail FROM srv_log WHERE kind = 'log' AND what = 'household-widened'");
    assert.equal(log.length, 1);
    assert.deepEqual(JSON.parse(log[0].detail).was, { tabs: 'pantry', receipts: '0' });
    assert.equal(rows(t, "SELECT 1 FROM items WHERE id = 'k-beer'").length, 1);
    const own = await t.other.serverFile(sid);
    assert.equal(own.entries.find((x) => x.pk === 'tabs').row.v, 'pantry,keg,pharmacy');
    assert.equal(t.state.house.narrow, undefined);
  });

  test('a member that is removed (not upgraded) no longer holds it back', async () => {
    const t = await v2Household();
    assert.equal((await handover(t, handoverBody(await code(t), t.hh, t.owner))).status, 200);
    const kex = (await (await fetch(t.base + '/api/v3/login/challenge?user=admin')).json()).kex;
    assert.equal((await t.owner.upgrade(kex)).status, 200);
    assert.equal(t.R.engine.householdValue('tabs'), 'pantry');
    const web3 = t.web3();
    await web3.login('admin', PASS, ITER);
    assert.equal((await web3.removePhone(t.other.device)).status, 200);
    assert.equal(t.R.engine.householdValue('tabs'), 'pantry,keg,pharmacy');
  });
});

describe('the handover, stopped part-way', () => {
  for (const point of ['after-keys', 'after-db', 'after-mode']) {
    test(`RESTOCK_TEST_CRASH=${point}`, async () => {
      const dir = mkdtempSync(join(tmpdir(), 'restock-crash-'));
      const t = await v2Household({}, dir);
      const cookieWeb = t.web;
      await stop(t);
      const c = await child(dir, point);
      // The same phones and browser, talking to the server process.
      for (const x of [cookieWeb, t.owner, t.other]) x.base = c.base;
      const r = await cookieWeb.post('/api/v3/handover', {});
      assert.equal(r.status, 200, JSON.stringify(r.body) + c.err());
      const h = handoverBody(r.body.code, t.hh, t.owner);
      await t.owner.req('POST', '/api/v3/handover/' + h.token, { json: h.json }).catch(() => null);
      assert.equal(await c.exited, 70, c.err());
      // Start again on the same folder.
      const t2 = await start({}, dir);
      const keys = JSON.parse(readFileSync(join(dir, 'keys.json'), 'utf8'));
      assert.equal(keys.handoverPending, undefined);
      for (const x of [cookieWeb, t.owner, t.other]) x.base = t2.base;
      if (point === 'after-mode') {
        // Finished: the household lives on the server; the phone's retry is told it's done.
        assert.equal(t2.state.mode, 'v3');
        assert.equal(t2.R.engine.householdValue('owner'), 'srv-' + t2.state.sid);
        assert.ok(existsSync(join(dir, 'files', `restock-sync-srv-${t2.state.sid}.bin`)));
        const again = await t.owner.req('POST', '/api/v3/handover/' + h.token, { json: h.json });
        assert.equal(again.status, 409);
        assert.equal(again.body.error, 'done');
      } else {
        // Rolled back: still v2, no household keys, no household.db; the owner phone can try again.
        assert.equal(t2.state.mode, 'v2');
        assert.equal(keys.owner, undefined);
        assert.ok(keys.kex);
        assert.ok(!existsSync(join(dir, 'household.db')));
        assert.equal((await t.owner.get('/api/v2/files')).status, 200);
        const web = { ...t2, web: cookieWeb };
        const h2 = handoverBody(await code(web), t.hh, t.owner);
        const ok = await t.owner.req('POST', '/api/v3/handover/' + h2.token, { json: h2.json });
        assert.equal(ok.status, 200, JSON.stringify(ok.body));
        assert.equal(t2.state.mode, 'v3');
      }
      await stop(t2);
      forget(dir);
    });
  }
});

describe('a v2 phone on a v3 server, and v2 joins', () => {
  test('v2 invites and joins are refused in v3; removed v2 phones are told so', async () => {
    const t = await v2Household();
    assert.equal((await handover(t, handoverBody(await code(t), t.hh, t.owner))).status, 200);
    const web3 = t.web3();
    assert.equal((await web3.login('admin', PASS, ITER)).status, 200);
    assert.equal((await web3.removePhone(t.other.device)).status, 200);
    const x = await t.other.get('/api/v2/files');
    assert.equal(x.status, 401);
    assert.equal(x.body.error, 'removed');
    // The 0.9.3 phone got no keys/ file (it has no kex key); the 0.9.4 owner phone upgrades and gets the new key.
    const kex = web3.kex;
    await t.owner.upgrade(kex);
    assert.equal(t.owner.keyv, 2);
    const p = new Phone(t.base, { clock: t.now });
    assert.equal((await p.join('x')).status, 409);
    void ent;
    void item;
  });
});
