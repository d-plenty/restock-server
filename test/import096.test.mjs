// 0.9.6: Import on the web's Data tab (src/v3/import.mjs, docs/server-protocol.md "Data: Import (0.9.6)"):
// a file merged on top of what the server has: products and prices only, nothing replaced or deleted,
// the dry run, the passphrase again, chunks (each in one go), Cancel, the checks on every field, the
// caps, Costco never in or out, and what the phones get.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { house, addPhone, ent, item, line, rows, SHARE_ALL } from './helpers.mjs';
import { IMPORT_LIMITS } from '../src/v3/import.mjs';

const DAY = 24 * 3600 * 1000;
const isoAgo = (d) => new Date(Date.now() - d * DAY).toISOString();
let stampN = Date.now();
const st = () => ++stampN;

async function withPhone() {
  const t = await house();
  const a = await addPhone(t, 'A');
  const send = async (entries) => {
    const r = await a.putOwn(a.file(entries.map((e) => ({ ...e, device: a.device })), { shares: SHARE_ALL }));
    assert.equal(r.status, 200, JSON.stringify(r.body));
    t.settle();
  };
  // What's there already: milk at Coles (a phone saw it), with a picture from a Coles host.
  await send([
    ent('products', 'p-milk', st(), 'x', { id: 'p-milk', chain: 'coles', name: 'Coles Milk 2L', size: '2L', store_product_id: '111', barcode: '9300633603205', image_url: 'https://img.coles.example/milk.jpg', created_at: 'x' }),
    ent('prices', `p-milk|${isoAgo(3)}`, st(), 'x', { product_id: 'p-milk', date: isoAgo(3), price: 3.1, source: 'auto' }),
    ent('items', 'i-milk', st(), 'x', { ...item('i-milk', 'pantry', 'Milk'), usual_product_id: 'p-milk' }),
    ent('list_entries', 'l1', st(), 'x', line('l1', 'Milk', { item_id: 'i-milk' })),
  ]);
  return { t, a, send };
}

const day = (d) => isoAgo(d).slice(0, 10);
const kept = (t) => ({
  items: rows(t, 'SELECT id FROM items ORDER BY id'),
  list: rows(t, 'SELECT id FROM list_entries ORDER BY id'),
  oldPrices: rows(t, "SELECT product_id, date, price, source FROM prices WHERE source <> 'imported' ORDER BY product_id, date"),
  oldProducts: rows(t, "SELECT * FROM products WHERE id = 'p-milk'"),
});

/** A chunk: milk again (matched by its shop number), and two new products. */
function chunk() {
  return [
    {
      ref: 'f-milk',
      chain: 'coles',
      store_product_id: '111',
      name: 'Coles Milk 2L',
      prices: [
        { date: isoAgo(3), price: 3.1 }, // there already (same day, same price): skipped
        { date: day(40), price: 3.3 },
        { date: day(50), price: 3.2, is_special: true, was_price: 3.6 },
      ],
    },
    {
      ref: 'f-bread',
      chain: 'woolworths',
      store_product_id: '222',
      name: '  Wholemeal   Bread 700g ',
      brand: 'Tip Top',
      size: '700g',
      barcode: '9310055536333',
      qty: 700,
      qty_unit: 'g',
      image_url: 'https://evil.example/pixel.gif',
      prices: [
        { date: day(10), price: 4 },
        { date: `${day(10)}T09:00:00`, price: 4.4 }, // the same day, earlier than noon: skipped
        { date: isoAgo(1), price: 4.5 },
        { date: 'yesterday', price: 4 }, // can't read
        { date: day(2), price: -1 }, // can't read
        { date: new Date(Date.now() + 5 * DAY).toISOString(), price: 4 }, // the future
      ],
    },
    { ref: 'f-tim', chain: 'aldi', name: 'Choc biscuits', prices: [{ date: day(400), price: 2.29 }] },
    { ref: 'f-x', chain: 'not-a-shop', name: 'Mystery', prices: [{ date: day(1), price: 1 }] },
    { ref: 'f-c', chain: 'costco', name: 'Costco nuts 1kg', prices: [{ date: day(1), price: 20 }, { date: day(2), price: 21 }] },
  ];
}

async function startImport(t) {
  const s = await t.web.post('/api/v3/data/import/start', { confirm: await t.web.confirm() });
  assert.equal(s.status, 200, JSON.stringify(s.body));
  assert.equal(s.sealed, true);
  return s.body.import;
}

describe('import: the dry run, then the import', () => {
  test('the dry run counts exactly what the import then does, writing nothing; products and prices only', async () => {
    const { t } = await withPhone();
    const before = kept(t);
    const n0 = rows(t, 'SELECT COUNT(*) AS n FROM prices')[0].n;
    const dry = await t.web.post('/api/v3/data/import/check', { products: chunk() });
    assert.equal(dry.status, 200, JSON.stringify(dry.body));
    assert.equal(dry.sealed, true);
    assert.deepEqual(dry.body.products, { add: 2, matched: 1 });
    // Milk: 2 added, 1 skipped. Bread: the day-10 pair is one (the noon one is newer), plus yesterday's: 2
    // added, 1 skipped. Biscuits: 1.
    assert.deepEqual(dry.body.prices, { add: 5, skipped: 2 });
    assert.deepEqual(dry.body.costco, { products: 1, prices: 2 });
    assert.equal(dry.body.problems.shop, 1);
    assert.equal(dry.body.problems.date, 2);
    assert.equal(dry.body.problems.price, 1);
    assert.equal(dry.body.problems['picture-left-out'], 1);
    assert.equal(rows(t, 'SELECT COUNT(*) AS n FROM prices')[0].n, n0, 'the dry run wrote nothing');
    assert.deepEqual(kept(t), before);

    const id = await startImport(t);
    const c = await t.web.post('/api/v3/data/import/chunk', { import: id, n: 0, products: chunk() });
    assert.equal(c.status, 200, JSON.stringify(c.body));
    assert.deepEqual(c.body.products, { added: 2, matched: 1 });
    assert.equal(c.body.prices.added, 5);
    assert.equal(c.body.prices.skipped, 2);
    const done = await t.web.post('/api/v3/data/import/finish', { import: id });
    assert.equal(done.status, 200);
    assert.equal(done.body.how, 'finished');
    assert.equal(done.body.prices.added, 5);

    // Never the list or the pantry; what was there stays as it was.
    assert.deepEqual(kept(t), before);
    const bread = rows(t, "SELECT * FROM products WHERE store_product_id = '222'")[0];
    assert.equal(bread.id, 'f-bread', "the file's id when the server has none like it");
    assert.deepEqual([bread.chain, bread.name, bread.brand, bread.size, bread.barcode, bread.qty, bread.qty_unit, bread.image_url], ['woolworths', 'Wholemeal Bread 700g', 'Tip Top', '700g', '9310055536333', 700, 'g', null]);
    const imported = rows(t, "SELECT product_id, date, price, is_special, was_price FROM prices WHERE source = 'imported' ORDER BY product_id, date");
    assert.equal(imported.length, 5);
    assert.equal(rows(t, "SELECT COUNT(*) AS n FROM prices WHERE source <> 'imported' AND source <> 'auto'")[0].n, 0);
    const milkSpecial = imported.find((r) => r.product_id === 'p-milk' && r.price === 3.2);
    assert.deepEqual([milkSpecial.is_special, milkSpecial.was_price], [1, 3.6]);
    // The day-10 pair: the newer one (noon in the server's zone, a day alone) is the one kept.
    assert.deepEqual(imported.filter((r) => r.product_id === 'f-bread').map((r) => r.price), [4, 4.5]);
    // Costco never.
    assert.equal(rows(t, "SELECT COUNT(*) AS n FROM products WHERE chain = 'costco'")[0].n, 0);
    // The activity says who.
    const act = rows(t, "SELECT device, detail FROM srv_log WHERE kind = 'activity' AND what = 'data-imported'");
    assert.equal(act.length, 1);
    assert.match(String(act[0].device), /^web-/);
    assert.match(String(act[0].detail), /"costco":3/);

    // The same file again: nothing more.
    const id2 = await startImport(t);
    const again = await t.web.post('/api/v3/data/import/chunk', { import: id2, n: 0, products: chunk() });
    assert.deepEqual(again.body.products, { added: 0, matched: 3 });
    assert.equal(again.body.prices.added, 0);
    assert.equal(again.body.prices.skipped, 7);
    await t.web.post('/api/v3/data/import/finish', { import: id2 });
    assert.equal(rows(t, "SELECT COUNT(*) AS n FROM prices WHERE source = 'imported'")[0].n, 5);
  });

  test('a price difference on a day the server has: the newest wins (an older one is skipped, a newer one added)', async () => {
    const { t } = await withPhone();
    const seen = Date.parse(rows(t, "SELECT date FROM prices WHERE product_id = 'p-milk'")[0].date);
    const id = await startImport(t);
    const body = (prices) => ({ import: id, products: [{ chain: 'coles', store_product_id: '111', name: 'Coles Milk 2L', prices }] });
    const a = await t.web.post('/api/v3/data/import/chunk', { ...body([{ date: new Date(seen - 60_000).toISOString(), price: 2.5 }]), n: 0 });
    assert.equal(a.body.prices.added, 0, 'older than the phone saw that day');
    const b = await t.web.post('/api/v3/data/import/chunk', { ...body([{ date: new Date(seen + 60_000).toISOString(), price: 2.75 }]), n: 1 });
    assert.equal(b.body.prices.added, 1, 'newer than the phone saw that day');
    await t.web.post('/api/v3/data/import/finish', { import: id });
    const day3 = rows(t, "SELECT price, source FROM prices WHERE product_id = 'p-milk' ORDER BY date");
    assert.deepEqual(day3, [
      { price: 3.1, source: 'auto' },
      { price: 2.75, source: 'imported' },
    ]);
  });

  test('the phones get the products and each one’s newest recent price; the older history stays on the server', async () => {
    const { t, a } = await withPhone();
    const id = await startImport(t);
    await t.web.post('/api/v3/data/import/chunk', { import: id, n: 0, products: chunk() });
    await t.web.post('/api/v3/data/import/finish', { import: id });
    t.settle();
    const own = await a.serverFile(t.sid);
    const bread = own.entries.find((x) => x.tbl === 'products' && x.pk === 'f-bread');
    assert.ok(bread && !bread.deleted);
    assert.equal(bread.row.name, 'Wholemeal Bread 700g');
    assert.ok(own.entries.find((x) => x.tbl === 'products' && x.pk === 'f-tim'));
    const prices = own.entries.filter((x) => x.tbl === 'prices' && x.row?.source === 'imported');
    // Bread's newest (a day ago) goes; milk's imported ones are older than what the phone saw; the
    // biscuits' only price is over a year old: neither goes.
    assert.deepEqual(
      prices.map((x) => [x.row.product_id, x.row.price]),
      [['f-bread', 4.5]],
    );
    assert.ok(prices.every((x) => x.device === 'srv-' + t.sid && /^web-/.test(x.origin ?? '')));
    // Nothing the phones don't know: products and prices as any server's, with source "imported".
    assert.equal(rows(t, "SELECT COUNT(*) AS n FROM sync_log WHERE tbl NOT IN ('products', 'prices', 'items', 'list_entries', 'household', 'household_settings', '_seq')")[0].n, 0);
  });

  test('Cancel keeps the chunks that finished; an import is one at a time, in order, and over when finished', async () => {
    const { t } = await withPhone();
    const id = await startImport(t);
    // Another browser can't start one meanwhile (and its passphrase isn't used up asking).
    const busy = await t.web.post('/api/v3/data/import/start', { confirm: await t.web.confirm() });
    assert.equal(busy.status, 409);
    assert.equal(busy.body.error, 'busy');
    assert.equal((await t.web.post('/api/v3/data/import/chunk', { import: id, n: 1, products: [] })).body.error, 'order');
    const one = await t.web.post('/api/v3/data/import/chunk', { import: id, n: 0, products: [chunk()[1]] });
    assert.equal(one.body.products.added, 1);
    const stop = await t.web.post('/api/v3/data/import/finish', { import: id, cancelled: true });
    assert.equal(stop.body.how, 'cancelled');
    assert.equal(stop.body.products.added, 1);
    assert.equal(rows(t, "SELECT COUNT(*) AS n FROM products WHERE id = 'f-bread'")[0].n, 1);
    assert.equal(rows(t, "SELECT COUNT(*) AS n FROM srv_log WHERE what = 'data-import-stopped'")[0].n, 1);
    const gone = await t.web.post('/api/v3/data/import/chunk', { import: id, n: 1, products: [] });
    assert.equal(gone.status, 410);
    assert.equal(gone.body.error, 'import-gone');
  });

  test('a chunk is all or nothing', async () => {
    const { t } = await withPhone();
    const id = await startImport(t);
    const n0 = rows(t, 'SELECT COUNT(*) AS n FROM products')[0].n;
    // Unknown fields refuse the whole request, before anything is written.
    const bad = await t.web.post('/api/v3/data/import/chunk', { import: id, n: 0, products: [chunk()[1], { chain: 'coles', name: 'x', number: '6008943212345678' }] });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.error, 'fields');
    assert.equal(rows(t, 'SELECT COUNT(*) AS n FROM products')[0].n, n0);
    const ok = await t.web.post('/api/v3/data/import/chunk', { import: id, n: 0, products: [chunk()[1]] });
    assert.equal(ok.status, 200);
  });
});

describe('import: who may, and the checks', () => {
  test('a browser session for the dry run; the passphrase session and the passphrase again to import', async () => {
    const { t, a } = await withPhone();
    for (const path of ['/api/v3/data/import/check', '/api/v3/data/import/start', '/api/v3/data/import/chunk', '/api/v3/data/import/finish']) {
      const none = await fetch(t.base + path, { method: 'POST', body: '{}', headers: { 'Content-Type': 'application/json' } });
      assert.equal(none.status, 401, path);
      assert.equal((await a.req('POST', path, { json: {} })).status, 403, path);
      const bad = await t.web.req('POST', path, { json: {}, auth: `RestockWeb3 s=${t.web.session}, t=${Date.now()}, n=${'A'.repeat(22)}, m=${'0'.repeat(64)}` });
      assert.equal(bad.status, 401, path);
    }
    const no = await t.web.post('/api/v3/data/import/start', {});
    assert.equal(no.status, 403);
    assert.equal(no.body.error, 'confirm');
    const wrong = await t.web.post('/api/v3/data/import/start', { confirm: await t.web.confirm(Buffer.alloc(32, 9)) });
    assert.equal(wrong.status, 403);
    assert.equal(wrong.body.error, 'current');
    assert.equal((await t.web.post('/api/v3/data/import/chunk', { import: 'nope', n: 0, products: [] })).status, 410);
    assert.equal((await t.web.get('/api/v3/data/import/check')).status, 404);
  });

  test('every field: shops, names, barcodes, dates, prices, flags, caps', async () => {
    const { t } = await withPhone();
    const check = async (products) => {
      const r = await t.web.post('/api/v3/data/import/check', { products });
      return r;
    };
    const p = (more) => ({ chain: 'woolworths', name: 'Thing', ...more });
    const r = await check([
      p({ chain: 'other' }),
      p({ chain: 'Coles ' }), // tidied to coles
      p({ name: '' }),
      p({ name: 'x'.repeat(201) }),
      p({ barcode: '12345' }), // left out, product kept
      p({ store_product_id: 'A1', prices: [{ date: '2026-02-31', price: 1 }, { date: '1999-12-31', price: 1 }, { date: day(1), price: 10_001 }, { date: day(1), price: '3.50' }, { date: day(2), price: 1, is_special: 'yes' }, { date: day(3), price: 1.999 }] }),
    ]);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.problems.shop, 1);
    assert.equal(r.body.problems.name, 2);
    assert.equal(r.body.problems['barcode-left-out'], 1);
    assert.equal(r.body.problems.date, 2);
    assert.equal(r.body.problems.price, 2);
    assert.equal(r.body.problems.flag, 1);
    assert.equal(r.body.prices.add, 1);
    for (const bad of [{ products: 'x' }, { products: [1] }, { products: [p({ prices: {} })] }, { products: [p({ prices: [{ date: day(1), price: 1, pin: '1234' }] })] }, { products: [p({ password: 'x' })] }]) {
      const x = await t.web.post('/api/v3/data/import/check', bad);
      assert.equal(x.status, 400, JSON.stringify(bad));
    }
    const many = await check(Array.from({ length: IMPORT_LIMITS.chunkProducts + 1 }, (_, i) => p({ store_product_id: String(i) })));
    assert.equal(many.status, 400);
    assert.equal(many.body.error, 'chunk');
    // A picture only from a host the household's products already use for that shop.
    const id = await startImport(t);
    await t.web.post('/api/v3/data/import/chunk', { import: id, n: 0, products: [{ chain: 'coles', store_product_id: '9', name: 'Eggs', image_url: 'https://img.coles.example/eggs.jpg' }, { chain: 'coles', store_product_id: '8', name: 'Ham', image_url: 'http://img.coles.example/ham.jpg' }] });
    await t.web.post('/api/v3/data/import/finish', { import: id });
    assert.deepEqual(rows(t, "SELECT name, image_url FROM products WHERE store_product_id IN ('8', '9') ORDER BY name"), [
      { name: 'Eggs', image_url: 'https://img.coles.example/eggs.jpg' },
      { name: 'Ham', image_url: null },
    ]);
  });

  test('rate limited per browser; the server-wide product cap', async () => {
    const { t } = await withPhone();
    const was = { perMinute: IMPORT_LIMITS.perMinute, serverProducts: IMPORT_LIMITS.serverProducts };
    try {
      IMPORT_LIMITS.perMinute = 3;
      for (let i = 0; i < 3; i++) assert.equal((await t.web.post('/api/v3/data/import/check', { products: [] })).status, 200);
      const r = await t.web.post('/api/v3/data/import/check', { products: [] });
      assert.equal(r.status, 429);
      assert.equal(r.body.error, 'rate');
      IMPORT_LIMITS.perMinute = 1000;
      IMPORT_LIMITS.serverProducts = rows(t, 'SELECT COUNT(*) AS n FROM products')[0].n + 1;
      const full = await t.web.post('/api/v3/data/import/check', { products: [{ chain: 'aldi', name: 'A' }, { chain: 'aldi', name: 'B', prices: [{ date: day(1), price: 1 }] }] });
      assert.equal(full.body.products.add, 1);
      assert.equal(full.body.problems.full, 1);
      assert.equal(full.body.problems['product-ignored-prices'], 1);
    } finally {
      Object.assign(IMPORT_LIMITS, was);
    }
  });
});

describe('Costco never goes out in an export; the Data tab counts imported prices', () => {
  test('the export leaves Costco products and prices out, and the price of what was bought there', async () => {
    const { t } = await withPhone();
    const tick = Date.now() - 3600_000;
    // 0.9.6 phones never send Costco's records (engine LOCAL_TAB), but a server could hold some from
    // before: put in directly.
    const raw = t.R.merger.raw();
    raw.prepare("INSERT INTO products (id, chain, name, created_at) VALUES ('p-cc', 'costco', 'Nuts 1kg', 'x')").run();
    raw.prepare("INSERT INTO prices (product_id, date, price, source) VALUES ('p-cc', ?, 19.99, 'auto')").run(isoAgo(1));
    raw
      .prepare("INSERT INTO list_entries (id, text, chain, qty, price, section, product, checked, created_at, checked_at) VALUES ('l-cc', 'Nuts', 'costco', 1, 19.99, 'pantry', ?, 1, 'x', ?)")
      .run(JSON.stringify({ chain: 'costco', name: 'Nuts', unitText: '$2.00 per 100 g' }), tick);
    t.R.data.sweep();
    const e = (await t.web.get('/api/v3/data/export')).body;
    assert.ok(!e.tables.products.some((p) => p.chain === 'costco'));
    assert.deepEqual(e.withheld, { costco: { products: 1, prices: 1 } });
    const l = e.tables.list.find((x) => x.id === 'l-cc');
    assert.equal(l.price, null);
    assert.equal(l.product.unitText, undefined);
    const prices = (await t.web.get('/api/v3/data/export/prices?limit=10000')).body.rows;
    assert.ok(!prices.some((r) => r.product_id === 'p-cc'));
    assert.equal(e.paged.prices.count, prices.length);
    const ticked = (await t.web.get('/api/v3/data/export/ticked')).body.rows.find((r) => r.entry_id === 'l-cc');
    assert.deepEqual([ticked.price, ticked.total, ticked.usual], [null, null, null]);
    assert.ok(!JSON.stringify([e.tables.products, e.tables.list, prices]).includes('19.99'));
  });

  test('summary and stats count imported prices; the price chart says which weeks were imported', async () => {
    const { t } = await withPhone();
    const id = await startImport(t);
    await t.web.post('/api/v3/data/import/chunk', { import: id, n: 0, products: chunk() });
    await t.web.post('/api/v3/data/import/finish', { import: id });
    const s = (await t.web.get('/api/v3/data/summary')).body;
    assert.equal(s.kinds.prices.imported, 5);
    const stats = (await t.web.get('/api/v3/data/stats?period=all')).body;
    assert.equal(stats.prices.imported, 5);
    const series = (await t.web.get('/api/v3/data/series?item=i-milk&period=all')).body;
    assert.ok(series.weeks.some((w) => w.imported === true));
    assert.ok(series.weeks.some((w) => !w.imported));
  });

  test('Delete everything stops an import going on', async () => {
    const { t } = await withPhone();
    const id = await startImport(t);
    const r = await t.web.post('/api/v3/data/delete-everything', { typed: 'DELETE EVERYTHING', confirm: await t.web.confirm() });
    assert.equal(r.status, 200);
    assert.equal(t.R.data.importing(), null);
    assert.ok(id);
  });
});
