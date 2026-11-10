// 0.9.5: the Data tab's server side (src/v3/data.mjs, docs/server-protocol.md "Data (0.9.5)"):
// spending from ticked lines, the reads, the export, deleting, Auto delete, Ask phones to resend.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { house, addPhone, start, stop, ent, item, line, rows, core, SHARE_ALL, PASS, ITER } from './helpers.mjs';

const DAY = 24 * 3600 * 1000;
const round2 = (n) => Math.round(n * 100) / 100;
const ago = (d) => Date.now() - d * DAY;
const isoAgo = (d) => new Date(ago(d)).toISOString();
let stampN = Date.now();
const st = () => ++stampN;

const product = (id, chain, name = id) => ent('products', id, st(), 'x', { id, chain, name, created_at: 'x' });
const price = (pid, daysBack, p, more = {}) => ent('prices', `${pid}|${isoAgo(daysBack)}`, st(), 'x', { product_id: pid, date: isoAgo(daysBack), price: p, source: 'check', ...more });

/** A house with one phone that shares everything, and a way to send its whole file. */
async function withPhone() {
  const t = await house();
  const a = await addPhone(t, 'A');
  const send = async (entries) => {
    const r = await a.putOwn(a.file(entries.map((e) => ({ ...e, device: a.device })), { shares: SHARE_ALL }));
    assert.equal(r.status, 200, JSON.stringify(r.body));
    t.settle();
  };
  return { t, a, send };
}

/** Milk (usual p1 at Coles, same p2 at Woolworths): Coles' usual $4, now $3 on special; Woolworths $3.50. */
function milk() {
  return [
    product('p1', 'coles', 'Milk 2L'),
    product('p2', 'woolworths', 'Milk 2L'),
    ent('items', 'i-milk', st(), 'x', { ...item('i-milk', 'pantry', 'Milk'), usual_product_id: 'p1', same_product_ids: '["p2"]' }),
    price('p1', 30, 4),
    price('p1', 20, 4),
    price('p1', 10, 4.2),
    price('p1', 1, 3, { is_special: 1, was_price: 4.2 }),
    price('p2', 2, 3.5),
  ];
}
const spend = (t) => rows(t, 'SELECT * FROM srv_spend ORDER BY entry_id, checked_at');

describe('spending from ticked lines', () => {
  test('a tick is a purchase: the line’s price × qty, else the newest price at its shop, else no price', async () => {
    const { t, send } = await withPhone();
    const tick = ago(0.5);
    await send([
      ...milk(),
      ent('list_entries', 'l-own', st(), 'x', line('l-own', 'Bread', { checked: 1, checked_at: tick, qty: 2, price: 2.5, chain: 'aldi' })),
      ent('list_entries', 'l-coles', st(), 'x', line('l-coles', 'Milk', { item_id: 'i-milk', chain: 'coles', checked: 1, checked_at: tick, qty: 3 })),
      ent('list_entries', 'l-any', st(), 'x', line('l-any', 'Milk', { item_id: 'i-milk', checked: 1, checked_at: tick + 1 })),
      ent('list_entries', 'l-none', st(), 'x', line('l-none', 'Batteries', { checked: 1, checked_at: tick })),
      ent('list_entries', 'l-open', st(), 'x', line('l-open', 'Eggs', {})),
    ]);
    const s = Object.fromEntries(spend(t).map((r) => [r.entry_id, r]));
    assert.deepEqual(Object.keys(s).sort(), ['l-any', 'l-coles', 'l-none', 'l-own']);
    assert.equal(s['l-own'].price, 2.5);
    assert.equal(s['l-own'].total, 5);
    assert.equal(s['l-own'].chain, 'aldi');
    assert.equal(s['l-own'].src, 'line');
    // At Coles: the newest Coles price ($3, on special), usual $4 (the median of the days not on special).
    assert.equal(s['l-coles'].price, 3);
    assert.equal(s['l-coles'].total, 9);
    assert.equal(s['l-coles'].usual, 4);
    assert.equal(s['l-coles'].special, 1);
    assert.equal(s['l-coles'].src, 'price');
    assert.equal(s['l-coles'].text, 'Milk');
    // No shop: the cheapest of its usual and same products, and that's its shop.
    assert.equal(s['l-any'].chain, 'coles');
    assert.equal(s['l-any'].price, 3);
    assert.equal(s['l-none'].price, null);
    assert.equal(s['l-none'].src, 'none');
    assert.equal(s['l-none'].total, null);
    // Idempotent.
    assert.deepEqual(t.R.data.sweep(), { added: 0, removed: 0 });
  });

  // 0.9.5 (final review): an "Any size" item counts the packs the list said to buy, as the list's total does.
  test('Any size: the packs it takes × the price (two 500 g bags for your usual 1 kg)', async () => {
    const { t, send } = await withPhone();
    const tick = ago(0.5);
    await send([
      product('r1', 'coles', 'Rice 1kg'),
      product('r2', 'woolworths', 'Rice 500g'),
      ent('items', 'i-rice', st(), 'x', { ...item('i-rice', 'pantry', 'Rice'), usual_product_id: 'r1', same_product_ids: '["r2"]', any_size: 1 }),
      ent('items', 'i-same', st(), 'x', { ...item('i-same', 'pantry', 'Rice too'), usual_product_id: 'r1', same_product_ids: '["r2"]', any_size: 0 }),
      price('r1', 2, 4.5),
      price('r2', 2, 2),
      ent('list_entries', 'l-any', st(), 'x', line('l-any', 'Rice', { item_id: 'i-rice', chain: 'woolworths', checked: 1, checked_at: tick, qty: 3 })),
      ent('list_entries', 'l-this', st(), 'x', line('l-this', 'Rice too', { item_id: 'i-same', chain: 'woolworths', checked: 1, checked_at: tick, qty: 3 })),
    ]);
    const s = Object.fromEntries(spend(t).map((r) => [r.entry_id, r]));
    // 3 × 1 kg is six 500 g bags at $2.
    assert.equal(s['l-any'].price, 2);
    assert.equal(s['l-any'].qty, 6);
    assert.equal(s['l-any'].total, 12);
    // "This size": as many as are on the list.
    assert.equal(s['l-this'].qty, 3);
    assert.equal(s['l-this'].total, 6);
    // Recount keeps it.
    const rc = await t.R.data.recount();
    assert.equal(rc.repriced, 0);
    assert.equal(spend(t).find((r) => r.entry_id === 'l-any').total, 12);
  });

  test('untick soon after takes it back; tick again adds it again; cleared lines keep theirs; an old untick keeps it', async () => {
    const { t, send } = await withPhone();
    const t1 = ago(1);
    const base = milk();
    await send([...base, ent('list_entries', 'l1', st(), 'x', line('l1', 'Milk', { item_id: 'i-milk', chain: 'coles', checked: 1, checked_at: t1 }))]);
    assert.equal(spend(t).length, 1);
    await send([...base, ent('list_entries', 'l1', st(), 'x', line('l1', 'Milk', { item_id: 'i-milk', chain: 'coles', checked: 0, checked_at: t1 + 60_000 }))]);
    assert.equal(spend(t).length, 0, 'unticked: not bought');
    const t3 = t1 + 120_000;
    await send([...base, ent('list_entries', 'l1', st(), 'x', line('l1', 'Milk', { item_id: 'i-milk', chain: 'coles', checked: 1, checked_at: t3 }))]);
    assert.deepEqual(spend(t).map((r) => r.checked_at), [t3]);
    // Ticked, unticked and ticked again between two rounds: one purchase, the newest.
    const t4 = t3 + 3_600_000;
    await send([...base, ent('list_entries', 'l1', st(), 'x', line('l1', 'Milk', { item_id: 'i-milk', chain: 'coles', checked: 1, checked_at: t4 }))]);
    assert.deepEqual(spend(t).map((r) => r.checked_at), [t4]);
    // Cleared off the list: the purchase stays.
    await send([...base, ent('list_entries', 'l1', st(), 'x', null)]);
    assert.equal(rows(t, "SELECT COUNT(*) AS n FROM list_entries WHERE id = 'l1'")[0].n, 0);
    assert.deepEqual(spend(t).map((r) => r.checked_at), [t4]);
    // A line ticked a week ago and unticked now (needed again): that purchase happened.
    const old = ago(7);
    await send([...base, ent('list_entries', 'l2', st(), 'x', line('l2', 'Milk', { item_id: 'i-milk', chain: 'coles', checked: 1, checked_at: old }))]);
    await send([...base, ent('list_entries', 'l2', st(), 'x', line('l2', 'Milk', { item_id: 'i-milk', chain: 'coles', checked: 0, checked_at: Date.now() }))]);
    assert.ok(spend(t).some((r) => r.entry_id === 'l2' && r.checked_at === old));
  });

  test('any source counts (a change the server makes itself, as Home Assistant does); backfill; Auto delete; Recount', async () => {
    const { t, send } = await withPhone();
    await send([...milk(), ent('list_entries', 'l1', st(), 'x', line('l1', 'Milk', { item_id: 'i-milk', chain: 'woolworths' }))]);
    assert.equal(spend(t).length, 0);
    // Ticked on the server (Home Assistant's Store writes list_entries through the triggers, then writeOwn).
    t.R.merger.raw().prepare("UPDATE list_entries SET checked = 1, checked_at = ? WHERE id = 'l1'").run(ago(0.1));
    t.R.writeOwn();
    assert.equal(spend(t)[0].price, 3.5);
    assert.equal(spend(t)[0].chain, 'woolworths');
    // Backfill: a server starting with ticked lines and no purchases noted notes them.
    t.R.merger.raw().exec('DELETE FROM srv_spend');
    const dir = t.dir;
    await stop(t);
    const t2 = await start({}, dir);
    assert.equal(rows(t2, 'SELECT COUNT(*) AS n FROM srv_spend')[0].n, 1);
    // Auto delete: ticks older than its cut-off aren't noted, and the nightly run drops old ones.
    t2.state.settings.keepMonths = 1;
    const raw = t2.R.merger.raw();
    raw.prepare("INSERT INTO list_entries (id, text, checked, checked_at, created_at, qty) VALUES ('l-old', 'Tea', 1, ?, 'x', 1)").run(ago(60));
    t2.R.data.sweep();
    assert.equal(rows(t2, "SELECT COUNT(*) AS n FROM srv_spend WHERE entry_id = 'l-old'")[0].n, 0);
    raw.prepare("INSERT INTO srv_spend (entry_id, checked_at, at, text, qty, src) VALUES ('gone', ?, ?, 'Tea', 1, 'none')").run(ago(90), isoAgo(90));
    await t2.R.merger.daily(true);
    assert.equal(rows(t2, "SELECT COUNT(*) AS n FROM srv_spend WHERE entry_id = 'gone'")[0].n, 0);
    assert.equal(rows(t2, "SELECT COUNT(*) AS n FROM srv_spend WHERE entry_id = 'l1'")[0].n, 1);
    // Recount prices a purchase again from what's known now (here: the line got a price of its own).
    raw.prepare("UPDATE list_entries SET price = 2 WHERE id = 'l1'").run();
    const web = t2.web3();
    assert.equal((await web.login('admin', PASS, ITER)).status, 200);
    const rc = await web.post('/api/v3/data/recount');
    assert.equal(rc.status, 200);
    assert.equal(rc.sealed, true);
    assert.equal(rc.body.repriced, 1);
    assert.equal(rows(t2, "SELECT price FROM srv_spend WHERE entry_id = 'l1'")[0].price, 2);
  });
});

describe('reads: storage, statistics, top items, price series', () => {
  test('shapes and periods', async () => {
    const { t, send } = await withPhone();
    await send([
      ...milk(),
      ent('list_entries', 'l-now', st(), 'x', line('l-now', 'Milk', { item_id: 'i-milk', chain: 'coles', checked: 1, checked_at: ago(0.2), qty: 2 })),
      ent('list_entries', 'l-own', st(), 'x', line('l-own', 'Bread', { checked: 1, checked_at: ago(0.3), price: 4, chain: 'aldi' })),
      ent('list_entries', 'l-none', st(), 'x', line('l-none', 'Batteries', { checked: 1, checked_at: ago(0.3) })),
      ent('receipts', 'r1', st(), 'x', { id: 'r1', scanned_at: isoAgo(3), section: 'pantry', total: 20 }),
    ]);
    // A purchase from 8 months ago (made directly: a phone's old tick).
    t.R.merger.raw().prepare("INSERT INTO srv_spend (entry_id, checked_at, at, chain, section, item_id, text, qty, price, total, src) VALUES ('l-old', ?, ?, 'coles', 'pantry', 'i-milk', 'Milk', 1, 4, 4, 'price')").run(ago(240), isoAgo(240));
    const w = t.web;
    const s3 = await w.get('/api/v3/data/stats?period=3');
    assert.equal(s3.status, 200);
    assert.equal(s3.sealed, true);
    const b = s3.body;
    assert.equal(b.period, 3);
    assert.equal(b.spending.months.length, 3);
    assert.equal(b.spending.count, 3);
    assert.equal(b.spending.total, 10); // 2 × $3 + $4
    assert.equal(b.spending.unpriced, 1);
    assert.equal(round2(b.spending.months.reduce((x, m) => x + m.total, 0)), 10);
    assert.deepEqual(
      b.shops.map((x) => [x.chain, x.total, x.count]),
      [
        ['coles', 6, 1],
        ['aldi', 4, 1],
        [null, 0, 1],
      ],
    );
    assert.deepEqual(b.saved, { total: 2, count: 1 }); // ($4 usual − $3) × 2
    assert.equal(b.itemsTracked, 1);
    assert.equal(b.prices.count, 5);
    assert.equal(b.prices.first.slice(0, 10), isoAgo(30).slice(0, 10));
    assert.equal(b.top.total, 3);
    const top = b.top.items[0];
    assert.equal(top.itemId, 'i-milk');
    assert.equal(top.name, 'Milk');
    assert.equal(top.times, 1);
    assert.equal(top.usual, 4);
    assert.deepEqual(top.lastPaid.price, 3);
    assert.equal(top.cheapest.chain, 'coles');
    assert.equal(top.cheapest.price, 3);
    // 12 months and all take the old one in.
    const s12 = (await w.get('/api/v3/data/stats?period=12')).body;
    assert.equal(s12.spending.months.length, 12);
    assert.equal(s12.spending.count, 4);
    assert.equal(s12.top.items[0].times, 2);
    assert.equal((await w.get('/api/v3/data/stats?period=all')).body.spending.count, 4);
    for (const bad of ['0', '121', 'x', '2.5']) assert.equal((await w.get('/api/v3/data/stats?period=' + bad)).status, 400, bad);
    // Top items, paged.
    const p2 = (await w.get('/api/v3/data/top?period=12&offset=1&limit=1')).body;
    assert.equal(p2.items.length, 1);
    assert.equal(p2.offset, 1);
    assert.equal(p2.total, 3);
    assert.equal((await w.get('/api/v3/data/top?limit=1000')).body.limit, 50);
    // One item's price over time.
    const se = (await w.get('/api/v3/data/series?item=i-milk&period=3')).body;
    assert.equal(se.item.name, 'Milk');
    assert.equal(se.usual, 4);
    assert.deepEqual(se.chains.map((c) => c.chain).sort(), ['coles', 'woolworths']);
    assert.ok(se.weeks.length >= 3);
    assert.ok(se.weeks.every((x) => /^\d{4}-\d{2}-\d{2}$/.test(x.week) && typeof x.price === 'number' && typeof x.special === 'boolean'));
    assert.ok(se.weeks.some((x) => x.chain === 'coles' && x.price === 3 && x.special));
    assert.equal(se.paid.length, 1);
    assert.equal((await w.get('/api/v3/data/series?item=nope')).status, 404);
    // Storage.
    const sum = (await w.get('/api/v3/data/summary')).body;
    for (const k of ['prices', 'receipts', 'stats', 'logs', 'backups']) {
      assert.equal(typeof sum.kinds[k].count, 'number', k);
      assert.equal(typeof sum.kinds[k].bytes, 'number', k);
    }
    assert.equal(sum.kinds.prices.count, 5);
    assert.equal(sum.kinds.receipts.count, 1);
    assert.equal(sum.kinds.stats.count, 4);
    assert.equal(sum.kinds.backups.nightly, false);
    assert.ok(sum.total > 0 && sum.database > 0);
    assert.ok(sum.disk === null || (sum.disk.free > 0 && sum.disk.size >= sum.disk.free));
    assert.deepEqual(sum.autoDelete, { months: null, cutoff: null });
  });
});

describe('the export', () => {
  test('clean tables, paged prices and ticks; never a card number, key, token or password', async () => {
    const { t, a, send } = await withPhone();
    const CARD = '6008943212345678';
    await send([
      ...milk(),
      ent('categories', 'c1', st(), 'x', { id: 'c1', name: 'Dairy', ord: 1, section: 'pantry' }),
      ent('cards', 'card1', st(), 'x', { id: 'card1', program: 'flybuys', label: 'Flybuys', number: CARD, created_at: 'x' }),
      ent('list_entries', 'l1', st(), 'x', line('l1', 'Milk', { item_id: 'i-milk', chain: 'coles', checked: 1, checked_at: ago(0.1) })),
      ent('receipts', 'r1', st(), 'x', { id: 'r1', scanned_at: isoAgo(3), section: 'pantry', total: 20, text: 'FLYBUYS ' + CARD, photo: 'receipts/a.jpg' }),
      ent('household_settings', 'shop:coles', st(), 'x', { k: 'shop:coles', v: JSON.stringify({ on: true }) }),
      ent('household_settings', 'branch:coles', st(), 'x', { k: 'branch:coles', v: JSON.stringify({ name: 'Townsville' }) }),
    ]);
    // Home Assistant's token, as the server keeps it.
    t.R.keys.data.ha = { address: 'http://ha.local:8123', entity: 'todo.shopping_list', enabled: false, token: 'eyJ-secret-token-123' };
    t.R.keys.save();
    const x = await t.web.get('/api/v3/data/export');
    assert.equal(x.status, 200);
    assert.equal(x.sealed, true);
    const e = x.body;
    assert.equal(e.format, 'restock-export');
    assert.equal(e.v, 1);
    assert.deepEqual(Object.keys(e.tables).sort(), ['aliases', 'categories', 'items', 'list', 'products', 'receipts', 'settings', 'shops', 'spending']);
    assert.deepEqual(e.tables.items[0].same_product_ids, ['p2']);
    assert.equal(e.tables.receipts[0].photos, 1);
    assert.equal(e.tables.receipts[0].text, undefined);
    assert.deepEqual(e.tables.shops, [{ id: 'coles', on: true, branch: { name: 'Townsville' } }]);
    assert.equal(e.paged.prices.count, 5);
    const pages = [];
    let after = 0;
    for (;;) {
      const p = (await t.web.get(`/api/v3/data/export/prices?after=${after}&limit=2`)).body;
      pages.push(...p.rows);
      if (p.next === null) break;
      after = p.next;
    }
    assert.equal(pages.length, 5);
    const ticked = (await t.web.get('/api/v3/data/export/ticked')).body;
    assert.equal(ticked.rows.length, 1);
    assert.equal(ticked.next, null);
    // Nothing secret anywhere in what the Data tab answers.
    const K = t.R.keys.data;
    const all = JSON.stringify([e, pages, ticked, (await t.web.get('/api/v3/data/summary')).body, (await t.web.get('/api/v3/data/stats?period=all')).body]);
    const secrets = [
      CARD,
      'eyJ-secret-token-123',
      K.owner.priv,
      K.kex.priv,
      ...Object.values(K.keys),
      ...Object.values(K.serverKeys),
      ...Object.values(K.secrets ?? {}),
      K.recovery,
      t.state.account.loginKey,
      t.state.account.scrypt.hash,
      t.web.session,
      a.keys.pub.slice(30, 70),
      ...Object.values(t.state.sessions3).map((s) => s.key),
    ];
    for (const s of secrets) assert.ok(s && !all.includes(s), 'leaked: ' + String(s).slice(0, 8));
    assert.ok(!/"number"/.test(all));
    assert.equal(rows(t, 'SELECT number FROM cards').filter((r) => r.number === CARD).length, 0);
  });
});

describe('deleting', () => {
  async function full() {
    const w = await withPhone();
    await w.send([
      ...milk(),
      ent('categories', 'c1', st(), 'x', { id: 'c1', name: 'Dairy', ord: 1, section: 'pantry' }),
      ent('list_entries', 'l1', st(), 'x', line('l1', 'Milk', { item_id: 'i-milk', chain: 'coles', checked: 1, checked_at: ago(0.1) })),
      ent('list_entries', 'l2', st(), 'x', line('l2', 'Bread', {})),
      ent('receipts', 'r1', st(), 'x', { id: 'r1', scanned_at: isoAgo(40), section: 'pantry', total: 20 }),
      ent('receipts', 'r2', st(), 'x', { id: 'r2', scanned_at: isoAgo(2), section: 'pantry', total: 10 }),
      ent('receipts', 'r-pin', st(), 'x', { id: 'r-pin', scanned_at: isoAgo(400), section: 'pantry', total: 10, pinned: 1 }),
    ]);
    w.t.R.merger.raw().prepare("INSERT INTO srv_spend (entry_id, checked_at, at, text, qty, src) VALUES ('old', ?, ?, 'Tea', 1, 'none')").run(ago(100), isoAgo(100));
    return w;
  }
  const kept = (t) => ({
    list: rows(t, 'SELECT COUNT(*) AS n FROM list_entries')[0].n,
    items: rows(t, 'SELECT COUNT(*) AS n FROM items')[0].n,
    categories: rows(t, 'SELECT COUNT(*) AS n FROM categories')[0].n,
    newest: rows(t, 'SELECT product_id, MAX(date) AS d FROM prices GROUP BY product_id ORDER BY product_id'),
  });

  test('every delete needs the passphrase again and the typed word, in that order', async () => {
    const { t } = await full();
    const w = t.web;
    const paths = [
      ['POST', '/api/v3/data/delete', { kinds: ['prices'] }, 'DELETE'],
      ['POST', '/api/v3/data/delete-everything', {}, 'DELETE EVERYTHING'],
      ['PUT', '/api/v3/data/autodelete', { months: 3 }, 'DELETE'],
      ['PUT', '/api/v3/settings', { keepMonths: 3 }, 'DELETE'],
    ];
    const before = kept(t);
    const prices = rows(t, 'SELECT COUNT(*) AS n FROM prices')[0].n;
    for (const [method, path, b, word] of paths) {
      const no = await w.req(method, path, { json: b });
      assert.equal(no.status, 403, path);
      assert.equal(no.body.error, 'confirm', path);
      const untyped = await w.req(method, path, { json: { ...b, confirm: await w.confirm() } });
      assert.equal(untyped.status, 400, path);
      assert.equal(untyped.body.error, 'typed', path);
      for (const typo of [word.toLowerCase(), word + ' ', 'DELETE EVERYTHING'.replace(word, '') || 'X']) {
        const r = await w.req(method, path, { json: { ...b, typed: typo, confirm: await w.confirm() } });
        assert.equal(r.status, 400, path + ' ' + typo);
      }
      const wrong = await w.req(method, path, { json: { ...b, typed: word, confirm: await w.confirm(Buffer.alloc(32, 9)) } });
      assert.equal(wrong.status, 403, path);
      assert.equal(wrong.body.error, 'current', path);
    }
    assert.deepEqual(kept(t), before);
    assert.equal(rows(t, 'SELECT COUNT(*) AS n FROM prices')[0].n, prices);
    assert.equal(t.state.mode, 'v3');
    assert.equal(t.state.settings.keepMonths, null);
    // Bad input is refused before anything else.
    assert.equal((await w.post('/api/v3/data/delete', { kinds: ['list'], typed: 'DELETE', confirm: await w.confirm() })).status, 400);
    assert.equal((await w.post('/api/v3/data/delete', { kinds: [], typed: 'DELETE', confirm: await w.confirm() })).status, 400);
    assert.equal((await w.post('/api/v3/data/delete', { kinds: ['prices'], before: new Date(Date.now() + DAY).toISOString(), typed: 'DELETE', confirm: await w.confirm() })).status, 400);
  });

  test('by kind, older than a date or all: never the list, the pantry, categories or the newest prices; logged with who', async () => {
    const { t } = await full();
    const w = t.web;
    const before = kept(t);
    const del = async (kinds, extra = {}) => {
      const r = await w.post('/api/v3/data/delete', { kinds, ...extra, typed: 'DELETE', confirm: await w.confirm() });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(r.sealed, true);
      return r.body;
    };
    // Prices older than 15 days: only p1's three older ones (p1's newest and p2's only one stay).
    const cut = isoAgo(15);
    const a = await del(['prices'], { before: cut });
    assert.equal(a.deleted.prices, 2);
    assert.equal(a.before, cut);
    assert.deepEqual(a.kinds, ['prices']);
    assert.equal(rows(t, 'SELECT COUNT(*) AS n FROM prices')[0].n, 3);
    // All price history: each product's newest stays.
    assert.equal((await del(['prices'])).deleted.prices, 1);
    assert.equal(rows(t, 'SELECT COUNT(*) AS n FROM prices')[0].n, 2);
    // Receipts older than 30 days (a pinned one stays), then statistics and logs, and the trash.
    assert.equal((await del(['receipts'], { before: isoAgo(30) })).deleted.receipts, 1);
    assert.deepEqual(rows(t, 'SELECT id FROM receipts ORDER BY id').map((r) => r.id), ['r-pin', 'r2']);
    const all = await del(['stats', 'logs', 'backups', 'receipts']);
    assert.equal(all.deleted.stats, 2);
    assert.ok(all.deleted.logs > 0);
    assert.deepEqual(rows(t, 'SELECT id FROM receipts').map((r) => r.id), ['r-pin']);
    assert.equal(rows(t, 'SELECT COUNT(*) AS n FROM srv_spend')[0].n, 0);
    assert.deepEqual(kept(t), before);
    // No deletes go out to phones for any of it.
    assert.equal(rows(t, "SELECT COUNT(*) AS n FROM sync_log WHERE deleted = 1 AND tbl IN ('prices', 'receipts')")[0].n, 0);
    // Who did it is in the activity (after the logs went).
    const act = rows(t, "SELECT what, device, detail FROM srv_log WHERE kind = 'activity' AND what = 'data-deleted'");
    assert.ok(act.length >= 1);
    assert.ok(act.every((r) => r.device === t.web.gift.webId || String(r.device).startsWith('web-')));
    // A deleted receipt doesn't come back with the phone's unchanged copy.
    t.R.engine.db.exec("DELETE FROM sync_meta WHERE key LIKE 'folder_seen:%'");
    t.R.merger.mergeEverything({});
    assert.deepEqual(rows(t, 'SELECT id FROM receipts').map((r) => r.id), ['r-pin']);
  });

  test('Delete everything on this server: the household goes, phones are unlinked (keeping theirs), the sign-in and settings stay', async () => {
    const { t, a } = await full();
    t.state.settings.keepMonths = 9;
    const r = await t.web.post('/api/v3/data/delete-everything', { typed: 'DELETE EVERYTHING', confirm: await t.web.confirm() });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body, { ok: true, mode: 'new', phones: 1 });
    assert.equal(t.state.mode, 'new');
    assert.equal(t.state.house, null);
    assert.equal(t.state.settings.keepMonths, 9);
    assert.equal(Object.keys(t.state.devices).length, 0);
    assert.equal(t.R.engine, null);
    assert.ok(!t.R.keys.hasHouse());
    // The phone is told it was removed (it forgets the household and keeps its own things, as after Remove).
    const p = await a.get('/api/v3/files');
    assert.equal(p.status, 401);
    assert.equal(p.body.error, 'removed');
    // The admin is still signed in, and can sign in again; the server can be set up afresh.
    assert.equal((await t.web.get('/api/v3/session')).status, 200);
    const again = t.web3();
    assert.equal((await again.login('admin', PASS, ITER)).status, 200);
    const s = await t.web.post('/api/v3/setup', { name: 'Fresh start' });
    assert.equal(s.status, 200, JSON.stringify(s.body));
    assert.equal(rows(t, 'SELECT COUNT(*) AS n FROM list_entries')[0].n, 0);
    assert.equal(rows(t, "SELECT COUNT(*) AS n FROM srv_log WHERE what = 'deleted-everything'")[0].n, 1);
    // And the phone can be added again (it's a member once more).
    const c = await t.web.post('/api/v3/phones', { label: 'A again' });
    const j = await a.join(c.body.code);
    assert.equal(j.status, 200, JSON.stringify(j.body));
  });
});

describe('Auto delete, Ask phones to resend, and who may call', () => {
  test('Auto delete: off by default on new servers, any whole number of months, both checks to turn on or shorten', async () => {
    const { t } = await withPhone();
    const w = t.web;
    assert.deepEqual((await w.get('/api/v3/data/autodelete')).body, { months: null, cutoff: null });
    for (const bad of [0, 121, 2.5, '6', true]) assert.equal((await w.put('/api/v3/data/autodelete', { months: bad, typed: 'DELETE', confirm: await w.confirm() })).status, 400, String(bad));
    assert.equal((await w.put('/api/v3/data/autodelete', { months: 7 })).status, 403);
    const on = await w.put('/api/v3/data/autodelete', { months: 7, typed: 'DELETE', confirm: await w.confirm() });
    assert.equal(on.status, 200, JSON.stringify(on.body));
    assert.equal(on.body.months, 7);
    assert.equal(on.body.was, null);
    assert.ok(on.body.deleted);
    assert.equal(Date.parse(on.body.cutoff), Math.round(Date.parse(on.body.cutoff)));
    // The signed server row carries it. 0.9.5 phones and the web read 7 (final review); a 0.9.4 phone
    // reads a value other than 3, 6, 9 or 12 as off (README "Updating from 0.9.4").
    assert.equal(JSON.parse(t.R.engine.householdValue('server')).keepMonths, 7);
    assert.equal(core.parseServerRow(t.R.engine.householdValue('server')).keepMonths, 7);
    // Longer, or off: nothing is deleted, so no checks.
    assert.equal((await w.put('/api/v3/data/autodelete', { months: 24 })).status, 200);
    assert.equal((await w.put('/api/v3/data/autodelete', { months: null })).body.months, null);
    assert.equal((await w.put('/api/v3/data/autodelete', { months: 12 })).status, 403);
    // Settings says the same.
    assert.equal((await w.get('/api/v3/settings')).body.keepMonths, null);
  });

  test('Auto delete: a server from 0.9.4 keeps its value; a damaged one is 12; a 0.9.3 state is off', async () => {
    const t = await start();
    const dir = t.dir;
    t.state.settings.keepMonths = 6;
    await t.R.st.save();
    await stop(t);
    const t2 = await start({}, dir);
    assert.equal(t2.R.house.keepMonths(), 6);
    t2.state.settings.keepMonths = 'x';
    assert.equal(t2.R.house.keepMonths(), 12);
    // A fresh state.json starts off.
    const t3 = await start();
    assert.equal(t3.state.settings.keepMonths, null);
    assert.equal(t3.R.house.keepMonths(), null);
  });

  test('Ask phones to resend: in the signed server row, once a day', async () => {
    const { t } = await withPhone();
    const r = await t.web.post('/api/v3/data/resend');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.ok(r.body.at && r.body.next);
    const row = JSON.parse(t.R.engine.householdValue('server'));
    assert.equal(row.resend, Date.parse(r.body.at));
    // Owner-signed, so a phone takes it; a 0.9.4 phone's parse passes over it.
    assert.ok(core.parseServerRow(t.R.engine.householdValue('server')));
    assert.equal(core.parseServerRow(t.R.engine.householdValue('server')).resend, undefined);
    const again = await t.web.post('/api/v3/data/resend');
    assert.equal(again.status, 429);
    assert.equal(again.body.error, 'rate');
    assert.equal(again.body.next, r.body.next);
    assert.equal(JSON.parse(t.R.engine.householdValue('server')).resend, row.resend);
    t.state.house.resendAt -= DAY + 1000; // a day on (the browser's MACs carry the real time)
    const later = await t.web.post('/api/v3/data/resend');
    assert.equal(later.status, 200);
    assert.ok(JSON.parse(t.R.engine.householdValue('server')).resend > row.resend);
    assert.deepEqual((await t.web.get('/api/v3/data/summary')).body.resend, later.body);
  });

  test('every Data endpoint needs a browser session: none 401, a phone 403, a bad MAC 401', async () => {
    const { t, a } = await withPhone();
    const eps = [
      ['GET', '/api/v3/data/summary'],
      ['GET', '/api/v3/data/stats?period=3'],
      ['GET', '/api/v3/data/top'],
      ['GET', '/api/v3/data/series?item=i'],
      ['GET', '/api/v3/data/export'],
      ['GET', '/api/v3/data/export/prices'],
      ['GET', '/api/v3/data/export/ticked'],
      ['POST', '/api/v3/data/delete'],
      ['POST', '/api/v3/data/delete-everything'],
      ['GET', '/api/v3/data/autodelete'],
      ['PUT', '/api/v3/data/autodelete'],
      ['POST', '/api/v3/data/resend'],
      ['POST', '/api/v3/data/recount'],
    ];
    for (const [method, path] of eps) {
      const body = method === 'GET' ? undefined : JSON.stringify({});
      const none = await fetch(t.base + path, { method, body, headers: { 'Content-Type': 'application/json' } });
      assert.equal(none.status, 401, path);
      const ph = await a.req(method, path, method === 'GET' ? {} : { json: {} });
      assert.equal(ph.status, 403, path);
      const bad = await t.web.req(method, path, { ...(method === 'GET' ? {} : { json: {} }), auth: `RestockWeb3 s=${t.web.session}, t=${Date.now()}, n=${'A'.repeat(22)}, m=${'0'.repeat(64)}` });
      assert.equal(bad.status, 401, path);
    }
    assert.equal(t.state.mode, 'v3');
  });
});
