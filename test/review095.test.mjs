// 0.9.5: the independent security review's findings, as regression tests (each failed before its fix).
// 1 Delete everything and other browsers' copies; 2 the one-time catch-up and old files; 3 Recount;
// 4 Ask phones to resend; 5 the legacy prune; 6 archive months; 7 Delete's dry run; 8 General in
// the statistics.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { house, addPhone, start, stop, ent, item, line, rows, core, SHARE_ALL, PASS, ITER } from './helpers.mjs';

const DAY = 24 * 3600 * 1000;
const ago = (d) => Date.now() - d * DAY;
const isoAgo = (d) => new Date(ago(d)).toISOString();
const tick = () => new Promise((r) => setTimeout(r, 30));

const hashOf = (t, webId) => Object.keys(t.state.sessions3).find((k) => t.state.sessions3[k].webId === webId);
/** A browser's own sync file, sealed with a key it was given. */
function webFile(b, keys, keyv, entries) {
  const msg = { format: 'restock-sync', v: 1, device: 'web-' + b.gift.webId, name: 'Web', keyv, at: new Date().toISOString(), top: entries.length, seen: {}, entries };
  return Buffer.from(core.sealRsf1(Buffer.from(keys[String(keyv)], 'base64url'), msg));
}
const webEnt = (b, tbl, pk, stamp, row) => ({ tbl, pk, stamp, device: 'web-' + b.gift.webId, deleted: !row, created: stamp, ...(row ? { row } : {}) });
/** Turns a passphrase browser session into one signed in with a phone (a member's). */
function asMember(t, b) {
  t.state.sessions3[hashOf(t, b.gift.webId)].kind = 'phone';
}
/** Takes a record out as long ago, its delete tidied away (compact): no row, no sync_log. */
function goneLongAgo(t, tbl, pk) {
  const raw = t.R.merger.raw();
  raw.exec("INSERT OR REPLACE INTO sync_meta (key, value) VALUES ('applying', '1')");
  raw.prepare(`DELETE FROM ${tbl} WHERE id = ?`).run(pk);
  raw.prepare('DELETE FROM sync_log WHERE tbl = ? AND pk = ?').run(tbl, pk);
  raw.exec("DELETE FROM sync_meta WHERE key = 'applying'");
}

describe('security review (0.9.5)', () => {
  test('1. Delete everything ends every other browser session; a copy of the old household can’t go into the new one', async () => {
    const t = await house();
    const b = t.web3();
    assert.equal((await b.login('admin', PASS, ITER)).status, 200);
    const c = t.web3();
    assert.equal((await c.login('admin', PASS, ITER)).status, 200);
    const oldKeys = b.gift.keys;
    const oldKeyv = b.gift.keyv;
    // c's session as it was (as if it had survived: a server that didn't end it).
    const cHash = hashOf(t, c.gift.webId);
    const cSaved = { ...t.state.sessions3[cHash] };
    const del = await t.web.post('/api/v3/data/delete-everything', { typed: 'DELETE EVERYTHING', confirm: await t.web.confirm() });
    assert.equal(del.status, 200, JSON.stringify(del.body));
    // Every other browser is signed out; the one that asked carries on.
    assert.equal((await b.get('/api/v3/session')).status, 401);
    assert.equal((await c.get('/api/v3/session')).status, 401);
    assert.equal((await t.web.get('/api/v3/session')).status, 200);
    const s = await t.web.post('/api/v3/setup', { name: 'Fresh start' });
    assert.equal(s.status, 200, JSON.stringify(s.body));
    // b can't put its copy in.
    const now = Date.now();
    const old = [webEnt(b, 'items', 'i-old', now - 1000, { id: 'i-old', name: 'Old household item', created_at: 'x', section: 'pantry' })];
    assert.equal((await b.req('PUT', `/api/v3/files/restock-sync-web-${b.gift.webId}.bin`, { body: webFile(b, oldKeys, oldKeyv, old) })).status, 401);
    // A session from before the new household (put back as it was) gets the new keys but can't write its file.
    t.state.sessions3[cHash] = cSaved;
    const g = await c.get('/api/v3/session');
    assert.equal(g.status, 200);
    const cOld = [webEnt(c, 'list_entries', 'l-old', now - 1000, line('l-old', 'Old list line'))];
    const put = await c.req('PUT', `/api/v3/files/restock-sync-web-${c.gift.webId}.bin`, { body: webFile(c, g.body.keys, g.body.keyv, cOld) });
    assert.equal(put.status, 409, JSON.stringify(put.body));
    assert.equal(put.body.error, 'household');
    t.settle();
    assert.deepEqual(rows(t, "SELECT id FROM items WHERE id = 'i-old'"), []);
    assert.deepEqual(rows(t, "SELECT id FROM list_entries WHERE id = 'l-old'"), []);
    // The browser that set it up writes its file as always, and so does one signed in since.
    const d = t.web3();
    assert.equal((await d.login('admin', PASS, ITER)).status, 200);
    const mine = [webEnt(d, 'list_entries', 'l-new', now, line('l-new', 'New list line'))];
    assert.equal((await d.req('PUT', `/api/v3/files/restock-sync-web-${d.gift.webId}.bin`, { body: webFile(d, d.gift.keys, d.gift.keyv, mine) })).status, 200);
    t.settle();
    assert.deepEqual(rows(t, "SELECT id FROM list_entries WHERE id = 'l-new'"), [{ id: 'l-new' }]);
    const w = t.web;
    w.gift = (await w.get('/api/v3/session')).body;
    const own = [webEnt(w, 'list_entries', 'l-own', now, line('l-own', 'Set up line'))];
    assert.equal((await w.req('PUT', `/api/v3/files/restock-sync-web-${w.gift.webId}.bin`, { body: webFile(w, w.gift.keys, w.gift.keyv, own) })).status, 200);
  });

  test('1. a session from before 0.9.5 (no household noted) is of the household there is', async () => {
    const t = await house();
    const w = t.web;
    w.gift = (await w.get('/api/v3/session')).body;
    delete t.state.sessions3[hashOf(t, w.gift.webId)].house;
    const put = await w.req('PUT', `/api/v3/files/restock-sync-web-${w.gift.webId}.bin`, { body: webFile(w, w.gift.keys, w.gift.keyv, [webEnt(w, 'list_entries', 'l1', Date.now(), line('l1', 'Tea'))]) });
    assert.equal(put.status, 200, JSON.stringify(put.body));
  });

  test('2. the one-time catch-up reads an unchanged file only for General lines never had: nothing deleted long ago comes back', async () => {
    const t = await house();
    const a = await addPhone(t, 'A');
    const b = t.web3();
    assert.equal((await b.login('admin', PASS, ITER)).status, 200);
    const old = ago(200);
    const r = await a.putOwn(
      a.file(
        [
          ent('items', 'i-x', old, a.device, item('i-x', 'pantry', 'Deleted long ago')),
          ent('list_entries', 'l-x', old, a.device, line('l-x', 'Old line')),
          ent('list_entries', 'g-new', old, a.device, line('g-new', 'Batteries', { section: 'general' })),
        ],
        { shares: SHARE_ALL },
      ),
    );
    assert.equal(r.status, 200);
    const pw = await b.req('PUT', `/api/v3/files/restock-sync-web-${b.gift.webId}.bin`, {
      body: webFile(b, b.gift.keys, b.gift.keyv, [webEnt(b, 'items', 'i-w', old, item('i-w', 'pantry', 'Web, deleted long ago'))]),
    });
    assert.equal(pw.status, 200);
    t.settle();
    assert.equal(rows(t, "SELECT COUNT(*) AS n FROM items WHERE id IN ('i-x', 'i-w')")[0].n, 2);
    // Long ago: i-x, l-x and i-w deleted and the deletes tidied away; g-new passed over (a 0.9.4 server).
    for (const [tbl, pk] of [['items', 'i-x'], ['list_entries', 'l-x'], ['items', 'i-w'], ['list_entries', 'g-new']]) goneLongAgo(t, tbl, pk);
    t.R.merger.raw().exec("DELETE FROM sync_meta WHERE key = 'lists_v'");
    const dir = t.dir;
    await stop(t);
    const t2 = await start({}, dir);
    t2.settle();
    assert.deepEqual(rows(t2, "SELECT id FROM items WHERE id IN ('i-x', 'i-w')"), []);
    assert.deepEqual(rows(t2, "SELECT id FROM list_entries WHERE id = 'l-x'"), []);
    assert.deepEqual(rows(t2, "SELECT id, section FROM list_entries WHERE id = 'g-new'"), [{ id: 'g-new', section: 'general' }]);
    assert.equal(rows(t2, "SELECT value FROM sync_meta WHERE key = 'lists_v'")[0].value, '95');
    // A file that changed since is read as always.
    a.base = t2.base;
    const a2 =await a.putOwn(a.file([ent('items', 'i-y', Date.now(), a.device, item('i-y', 'pantry', 'New'))], { shares: SHARE_ALL }));
    assert.equal(a2.status, 200);
    t2.settle();
    assert.equal(rows(t2, "SELECT COUNT(*) AS n FROM items WHERE id = 'i-y'")[0].n, 1);
    await stop(t2);
  });

  test('2. a browser’s file whose session is gone is never read again, and goes to the trash', async () => {
    const t = await house();
    const b = t.web3();
    assert.equal((await b.login('admin', PASS, ITER)).status, 200);
    const name = `restock-sync-web-${b.gift.webId}.bin`;
    const pw = await b.req('PUT', `/api/v3/files/${name}`, { body: webFile(b, b.gift.keys, b.gift.keyv, [webEnt(b, 'items', 'i-w', ago(1), item('i-w', 'pantry', 'Tea'))]) });
    assert.equal(pw.status, 200);
    t.settle();
    assert.equal(rows(t, "SELECT COUNT(*) AS n FROM items WHERE id = 'i-w'")[0].n, 1);
    assert.equal((await b.post('/api/v3/logout', {})).status, 200);
    goneLongAgo(t, 'items', 'i-w');
    t.R.engine.db.exec("DELETE FROM sync_meta WHERE key LIKE 'folder_seen:%'");
    t.R.merger.mergeEverything({});
    await tick();
    assert.deepEqual(rows(t, "SELECT id FROM items WHERE id = 'i-w'"), []);
    assert.equal(t.R.hasFile(name), false);
  });

  test('3. Recount: the passphrase’s, one at a time, once a minute, and the server keeps answering meanwhile', async () => {
    const t = await house();
    const raw = t.R.merger.raw();
    raw.exec('BEGIN');
    const P = 400;
    for (let i = 0; i < P; i++) {
      raw.prepare("INSERT INTO products (id, chain, name, created_at) VALUES (?, 'coles', 'x', 'x')").run('p' + i);
      raw.prepare("INSERT INTO items (id, name, created_at, section, usual_product_id) VALUES (?, 'x', 'x', 'pantry', ?)").run('i' + i, 'p' + i);
      for (let d = 0; d < 30; d++) raw.prepare("INSERT INTO prices (product_id, date, price, source) VALUES (?, ?, 3, 'check')").run('p' + i, new Date(Date.now() - d * 6 * DAY).toISOString());
    }
    const N = 20000;
    for (let k = 0; k < N; k++) {
      const at = Date.now() - (k % 300) * DAY - k;
      raw.prepare("INSERT INTO srv_spend (entry_id, checked_at, at, chain, item_id, text, qty, price, src) VALUES (?, ?, ?, 'coles', ?, 'x', 1, NULL, 'none')").run('e' + k, at, new Date(at).toISOString(), 'i' + (k % P));
    }
    raw.exec('COMMIT');
    // A member's browser (signed in with a phone) can't.
    const m = t.web3();
    assert.equal((await m.login('admin', PASS, ITER)).status, 200);
    asMember(t, m);
    assert.equal((await m.post('/api/v3/data/recount')).status, 403);
    const h = monitorEventLoopDelay({ resolution: 10 });
    h.enable();
    const first = t.web.post('/api/v3/data/recount');
    await tick();
    const second = await t.web.post('/api/v3/data/recount');
    const r = await first;
    h.disable();
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.checked, N);
    assert.equal(r.body.repriced, N);
    assert.equal(second.status, 429);
    assert.ok(second.body.retryAfter > 0);
    // Never blocked for long (it took over two seconds in one go).
    assert.ok(h.max / 1e6 < 400, `blocked ${Math.round(h.max / 1e6)} ms`);
    const soon = await t.web.post('/api/v3/data/recount');
    assert.equal(soon.status, 429);
    assert.ok(soon.body.retryAfter > 0 && soon.body.retryAfter <= 60, JSON.stringify(soon.body));
    assert.equal(soon.headers.get('retry-after'), String(soon.body.retryAfter));
    assert.equal(rows(t, 'SELECT COUNT(*) AS n FROM srv_spend WHERE price IS NOT NULL')[0].n, N);
  });

  test('4. Ask phones to resend: the passphrase’s; asked again too soon says when (next)', async () => {
    const t = await house();
    const m = t.web3();
    assert.equal((await m.login('admin', PASS, ITER)).status, 200);
    asMember(t, m);
    const no = await m.post('/api/v3/data/resend');
    assert.equal(no.status, 403);
    assert.equal(no.body.error, 'passphrase');
    assert.equal(t.state.house.resendAt, undefined);
    const ok = await t.web.post('/api/v3/data/resend');
    assert.equal(ok.status, 200);
    const again = await t.web.post('/api/v3/data/resend');
    assert.equal(again.status, 429);
    assert.equal(again.body.next, ok.body.next);
    assert.ok(again.body.retryAfter > 0);
  });

  test('5. the 0.9.4 prune deletes prices, receipts and logs only: never the statistics', async () => {
    const t = await house();
    t.R.merger.raw().prepare("INSERT INTO srv_spend (entry_id, checked_at, at, text, qty, src) VALUES ('old', ?, ?, 'Tea', 1, 'none')").run(ago(100), isoAgo(100));
    const r = await t.web.post('/api/v3/prune', { before: isoAgo(30), confirm: await t.web.confirm() });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.stats, 0);
    assert.equal(rows(t, 'SELECT COUNT(*) AS n FROM srv_spend')[0].n, 1);
  });

  test('6. deleting only prices keeps archive months that hold receipts; none holding a pinned receipt goes; what went stays out', async () => {
    const t = await house();
    const a = await addPhone(t, 'A');
    const month = (d) => isoAgo(d).slice(0, 7);
    const arch = async (m, body) => {
      const r = await a.req('PUT', `/api/v3/files/${encodeURIComponent(`archive/${a.device}/${m}.bin`)}`, { body: a.sealFor(body) });
      assert.equal(r.status, 200, JSON.stringify(r.body));
    };
    const pr = (pid, d) => ({ product_id: pid, date: isoAgo(d), price: 2, source: 'check' });
    const rc = (id, d, pinned = 0) => ({ id, scanned_at: isoAgo(d), section: 'pantry', total: 9, pinned });
    // Three old months: prices only; prices and a receipt; prices and a pinned receipt.
    await arch(month(400), { prices: [pr('p1', 400)], receipts: [] });
    await arch(month(340), { prices: [pr('p1', 340)], receipts: [rc('r1', 340)] });
    await arch(month(280), { prices: [pr('p1', 280)], receipts: [rc('r-pin', 280, 1)] });
    const ok = await a.putOwn(a.file([ent('products', 'p1', Date.now(), a.device, { id: 'p1', chain: 'coles', name: 'Beans', created_at: 'x' }), ent('prices', 'p1|now', Date.now(), a.device, pr('p1', 1))], { shares: SHARE_ALL }));
    assert.equal(ok.status, 200);
    t.settle();
    const names = () => t.R.listFileNames().filter((n) => n.startsWith('archive/')).sort();
    assert.equal(names().length, 3);
    const del = async (kinds) => {
      const r = await t.web.post('/api/v3/data/delete', { kinds, before: isoAgo(200), typed: 'DELETE', confirm: await t.web.confirm() });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      return r.body.deleted;
    };
    const d1 = await del(['prices']);
    assert.equal(d1.archives, 1);
    assert.deepEqual(names(), [`archive/${a.device}/${month(340)}.bin`, `archive/${a.device}/${month(280)}.bin`].sort());
    // Read again (as after the phone writes the month again), the prices deleted stay deleted.
    t.R.engine.db.exec("DELETE FROM sync_meta WHERE key LIKE 'folder_seen:archive/%'");
    t.R.merger.mergeEverything({});
    assert.equal(rows(t, "SELECT COUNT(*) AS n FROM prices WHERE product_id = 'p1'")[0].n, 1);
    // Prices and receipts: the month with the pinned receipt stays.
    const d2 = await del(['prices', 'receipts']);
    assert.equal(d2.archives, 1);
    assert.deepEqual(names(), [`archive/${a.device}/${month(280)}.bin`]);
    assert.deepEqual(rows(t, 'SELECT id FROM receipts ORDER BY id').map((r) => r.id), ['r-pin']);
  });

  test('7. Delete’s dry run: the exact counts, nothing deleted, any browser session, no passphrase', async () => {
    const t = await house();
    const a = await addPhone(t, 'A');
    const now = Date.now();
    const ok = await a.putOwn(
      a.file(
        [
          ent('products', 'p1', now, a.device, { id: 'p1', chain: 'coles', name: 'Beans', created_at: 'x' }),
          ...[100, 50, 40, 1].map((d) => ent('prices', `p1|${isoAgo(d)}`, now + d, a.device, { product_id: 'p1', date: isoAgo(d), price: 2, source: 'check' })),
          ent('receipts', 'r1', now, a.device, { id: 'r1', scanned_at: isoAgo(60), section: 'pantry', total: 5 }),
          ent('receipts', 'r2', now, a.device, { id: 'r2', scanned_at: isoAgo(70), section: 'pantry', total: 5, pinned: 1 }),
        ],
        { shares: SHARE_ALL },
      ),
    );
    assert.equal(ok.status, 200);
    t.settle();
    t.R.merger.raw().prepare("INSERT INTO srv_spend (entry_id, checked_at, at, text, qty, src) VALUES ('old', ?, ?, 'Tea', 1, 'none'), ('new', ?, ?, 'Tea', 1, 'none')").run(ago(90), isoAgo(90), ago(2), isoAgo(2));
    const m = t.web3();
    assert.equal((await m.login('admin', PASS, ITER)).status, 200);
    asMember(t, m);
    const kinds = ['prices', 'receipts', 'stats', 'logs', 'backups'];
    const dry = await m.post('/api/v3/data/delete', { kinds, before: isoAgo(30), dryRun: true });
    assert.equal(dry.status, 200, JSON.stringify(dry.body));
    assert.equal(dry.sealed, true);
    const c = dry.body.counts;
    assert.equal(c.prices, 3);
    assert.equal(c.receipts, 1);
    assert.equal(c.stats, 1);
    assert.equal(c.backups, 0);
    // Nothing went.
    assert.equal(rows(t, 'SELECT COUNT(*) AS n FROM prices')[0].n, 4);
    assert.equal(rows(t, 'SELECT COUNT(*) AS n FROM srv_spend')[0].n, 2);
    // Without dryRun, a member still can't; the real delete matches the counts.
    assert.equal((await m.post('/api/v3/data/delete', { kinds, before: isoAgo(30) })).status, 403);
    const real = await t.web.post('/api/v3/data/delete', { kinds, before: isoAgo(30), typed: 'DELETE', confirm: await t.web.confirm() });
    assert.equal(real.status, 200, JSON.stringify(real.body));
    for (const k of ['prices', 'receipts', 'photos', 'archives', 'stats', 'backups']) assert.equal(real.body.deleted[k], c[k], k);
    // Bad input is refused as for a delete.
    assert.equal((await m.post('/api/v3/data/delete', { kinds: ['list'], dryRun: true })).status, 400);
  });

  test('8. the statistics by list: General on its own, each list named', async () => {
    const t = await house();
    const raw = t.R.merger.raw();
    const ins = raw.prepare("INSERT INTO srv_spend (entry_id, checked_at, at, text, qty, price, total, section, src) VALUES (?, ?, ?, 'x', 1, ?, ?, ?, 'line')");
    ins.run('a', ago(1), isoAgo(1), 5, 5, 'pantry');
    ins.run('b', ago(1), isoAgo(1), 7, 7, 'general');
    ins.run('c', ago(1), isoAgo(1), 1, 1, null);
    const s = await t.web.get('/api/v3/data/stats?period=1');
    assert.equal(s.status, 200);
    assert.deepEqual(s.body.sections, [
      { section: 'general', name: 'General', total: 7, count: 1 },
      { section: 'pantry', name: 'Groceries', total: 6, count: 2 },
    ]);
    assert.equal(s.body.spending.total, 13);
  });
});

