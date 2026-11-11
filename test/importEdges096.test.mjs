// 0.9.6 (review L7): Import's edge cases (src/v3/import.mjs): one a day holds across chunks, a shop
// product number must be text or a number, and a file's ref is per shop.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { house, rows } from './helpers.mjs';

const DAY = 24 * 3600 * 1000;
const day = (d) => new Date(Date.now() - d * DAY).toISOString().slice(0, 10);

async function startImport(t) {
  const s = await t.web.post('/api/v3/data/import/start', { confirm: await t.web.confirm() });
  assert.equal(s.status, 200, JSON.stringify(s.body));
  return s.body.import;
}

describe('import edge cases (review L7)', () => {
  test('one a day holds across chunks: a later chunk with the same product and day adds nothing', async () => {
    const t = await house();
    const id = await startImport(t);
    const milk = (prices, more) => ({ ref: 'f-milk', chain: 'coles', store_product_id: '111', name: 'Coles Milk 2L', ...(more ? { more: true } : {}), prices });
    const a = await t.web.post('/api/v3/data/import/chunk', { import: id, n: 0, products: [milk([{ date: `${day(5)}T09:00:00`, price: 3.1 }, { date: day(6), price: 3 }])] });
    assert.equal(a.status, 200, JSON.stringify(a.body));
    assert.equal(a.body.prices.added, 2);
    // The rest of the product in the next chunk, with the same day again (later, another price), and a new day.
    const b = await t.web.post('/api/v3/data/import/chunk', { import: id, n: 1, products: [milk([{ date: `${day(5)}T15:00:00`, price: 3.4 }, { date: day(7), price: 2.9 }], true)] });
    assert.equal(b.status, 200, JSON.stringify(b.body));
    assert.equal(b.body.prices.added, 1);
    assert.equal(b.body.prices.skipped, 1);
    // The dry run of that chunk now says the same.
    const dry = await t.web.post('/api/v3/data/import/check', { products: [milk([{ date: `${day(5)}T18:00:00`, price: 3.5 }], true)] });
    assert.deepEqual(dry.body.prices, { add: 0, skipped: 1 });
    await t.web.post('/api/v3/data/import/finish', { import: id });
    // Days 5, 6 and 7 (the server's zone), one each: day 5 is the first chunk's.
    assert.deepEqual(rows(t, "SELECT price FROM prices WHERE source = 'imported' ORDER BY date").map((r) => r.price), [2.9, 3, 3.1]);

    // A second import of the same day: still one.
    const id2 = await startImport(t);
    const c = await t.web.post('/api/v3/data/import/chunk', { import: id2, n: 0, products: [milk([{ date: `${day(5)}T20:00:00`, price: 3.6 }])] });
    assert.equal(c.body.prices.added, 0);
    await t.web.post('/api/v3/data/import/finish', { import: id2 });
  });

  test('two rows of one product in the same chunk: one price a day', async () => {
    const t = await house();
    const id = await startImport(t);
    const row = (price, time) => ({ chain: 'coles', store_product_id: '555', name: 'Coles Butter 250g', prices: [{ date: `${day(3)}T${time}`, price }] });
    const r = await t.web.post('/api/v3/data/import/chunk', { import: id, n: 0, products: [row(4, '08:00:00'), row(4.2, '12:00:00')] });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    await t.web.post('/api/v3/data/import/finish', { import: id });
    assert.equal(rows(t, "SELECT COUNT(*) AS n FROM prices p JOIN products x ON x.id = p.product_id WHERE x.store_product_id = '555'")[0].n, 1);
  });

  test('a shop product number that is an object (or true) is turned away, never "[object Object]"; a number is kept as text', async () => {
    const t = await house();
    const products = [
      { chain: 'coles', store_product_id: { id: 1 }, name: 'Odd one', prices: [{ date: day(1), price: 1 }] },
      { chain: 'coles', store_product_id: true, name: 'Odd two', prices: [] },
      { chain: 'coles', store_product_id: 98765, name: 'Coles Eggs 12', prices: [{ date: day(1), price: 6 }] },
    ];
    const dry = await t.web.post('/api/v3/data/import/check', { products });
    assert.equal(dry.status, 200, JSON.stringify(dry.body));
    assert.equal(dry.body.problems['shop-number'], 2);
    assert.equal(dry.body.problems['product-ignored-prices'], 1);
    assert.deepEqual(dry.body.products, { add: 1, matched: 0 });
    const id = await startImport(t);
    const r = await t.web.post('/api/v3/data/import/chunk', { import: id, n: 0, products });
    assert.equal(r.body.products.added, 1);
    await t.web.post('/api/v3/data/import/finish', { import: id });
    assert.equal(rows(t, "SELECT COUNT(*) AS n FROM products WHERE store_product_id = '[object Object]' OR name LIKE 'Odd%'")[0].n, 0);
    assert.equal(rows(t, "SELECT store_product_id FROM products WHERE name = 'Coles Eggs 12'")[0].store_product_id, '98765');
  });

  test('a ref reused at two shops is two products, across chunks too', async () => {
    const t = await house();
    const id = await startImport(t);
    const at = (chain, price, more) => ({ ref: 'same-ref', chain, name: `Tea bags 100 (${chain})`, ...(more ? { more: true } : {}), prices: [{ date: day(more ? 9 : 2), price }] });
    const a = await t.web.post('/api/v3/data/import/chunk', { import: id, n: 0, products: [at('coles', 5)] });
    assert.equal(a.body.products.added, 1);
    // The next chunk: the same ref at Woolworths is its own product, and Coles' rest goes to Coles'.
    const b = await t.web.post('/api/v3/data/import/chunk', { import: id, n: 1, products: [at('woolworths', 6), at('coles', 5.5, true)] });
    assert.equal(b.status, 200, JSON.stringify(b.body));
    assert.equal(b.body.products.added, 1);
    await t.web.post('/api/v3/data/import/finish', { import: id });
    const got = rows(t, "SELECT x.chain AS chain, p.price AS price FROM prices p JOIN products x ON x.id = p.product_id WHERE p.source = 'imported' ORDER BY x.chain, p.price");
    assert.deepEqual(got, [
      { chain: 'coles', price: 5 },
      { chain: 'coles', price: 5.5 },
      { chain: 'woolworths', price: 6 },
    ]);
  });
});
