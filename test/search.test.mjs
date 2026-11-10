// 0.9.5: "Let the web page search the shops" (src/v3/search.mjs, the core's searchShops), against
// stand-in shops (cfg.shopFetch: nothing real is asked). Off by default; signed-in browsers only;
// the limits; results as the phone's; nothing searched for in the log; Track and Add to list write
// the records as the server, and they reach the phones in its file.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { house, addPhone, rows, PASS, ITER } from './helpers.mjs';

const MILK = [
  { Stockcode: 11, DisplayName: 'Cadbury Dairy Milk Chocolate Block 180g', Price: 6, PackageSize: '180g' },
  { Stockcode: 12, DisplayName: 'Woolworths Full Cream Milk 2L', Price: 3.1, WasPrice: 6.2, IsOnSpecial: true, PackageSize: '2L', CupString: '$1.55 / 1L', LargeImageFile: 'https://cdn0.woolworths.media/content/wowproductimages/large/000012.jpg' },
  { Stockcode: 13, DisplayName: 'Woolworths Lite Milk 2L', Price: 3.1, PackageSize: '2L' },
];

/** Pretend shops: Woolworths answers, Dan Murphy's turns the server away, anything else is refused. */
function shops() {
  const seen = [];
  const fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    seen.push({ url: url.toString(), method: init.method ?? 'GET', body: init.body });
    const j = (v, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } });
    if (url.host === 'www.woolworths.com.au' && url.pathname === '/') return new Response('<html></html>', { headers: { 'set-cookie': 'a=1' } });
    if (url.host === 'www.woolworths.com.au' && url.pathname === '/apis/ui/Search/products') return j({ Products: MILK.map((p) => ({ Products: [p] })) });
    if (url.host.endsWith('danmurphys.com.au')) return new Response('<html>Access denied</html>', { status: 403, headers: { 'content-type': 'text/html' } });
    return new Response('nope', { status: 404 });
  };
  return { fetch, seen };
}

async function searchHouse(over = {}) {
  const s = shops();
  const t = await house({ shopFetch: s.fetch, ...over });
  return { t, s };
}
const turnOn = (t, on = true) => t.web.put('/api/v3/settings', { webSearch: on });

describe('Let the web page search the shops', () => {
  test('off by default: 403 with the words the web shows, and nothing asked', async () => {
    const { t, s } = await searchHouse();
    const g = await t.web.get('/api/v3/settings');
    assert.equal(g.status, 200);
    assert.equal(g.body.webSearch, false);
    const r = await t.web.post('/api/v3/search', { q: 'milk' });
    assert.equal(r.status, 403);
    assert.deepEqual([r.body.error, r.body.message], ['web-search-off', 'Turn on Let the web page search the shops in Settings.']);
    assert.equal((await t.web.post('/api/v3/search/add', { search: 'x', picks: [] })).status, 403);
    assert.equal(s.seen.length, 0);
    // Only on or off.
    assert.equal((await t.web.put('/api/v3/settings', { webSearch: 'yes' })).status, 400);
    const on = await turnOn(t);
    assert.equal(on.status, 200, JSON.stringify(on.body));
    assert.equal(on.body.webSearch, true);
    assert.equal(t.state.settings.webSearch, true);
    assert.ok(rows(t, "SELECT what FROM srv_log WHERE what = 'web-search-on'").length === 1);
    assert.equal((await turnOn(t, false)).body.webSearch, false);
    assert.equal((await t.web.post('/api/v3/search', { q: 'milk' })).status, 403);
  });

  test('signed-in browsers only', async () => {
    const { t, s } = await searchHouse();
    await turnOn(t);
    const anon = await fetch(t.base + '/api/v3/search', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"q":"milk"}' });
    assert.equal(anon.status, 401);
    const p = await addPhone(t, 'Phone');
    const ph = await p.post('/api/v3/search', { q: 'milk' });
    assert.equal(ph.status, 403);
    assert.equal(s.seen.length, 0);
    // The signed-in browser can.
    assert.equal((await t.web.post('/api/v3/search', { q: 'milk', chain: 'woolworths' })).status, 200);
  });

  test("the phone's results, ranked, at the household's shops; a blocked shop says so; checks what's sent", async () => {
    const { t, s } = await searchHouse();
    await turnOn(t);
    const r = await t.web.post('/api/v3/search', { q: 'Milk', chain: 'woolworths' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.sealed, true);
    assert.equal(r.body.text, 'milk');
    assert.equal(r.body.section, 'pantry');
    assert.match(r.body.search, /^[A-Za-z0-9_-]{16}$/);
    const w = r.body.shops[0];
    assert.equal(w.status, 'ok');
    assert.notEqual(w.items[0].storeProductId, '11'); // the chocolate isn't the milk
    const full = w.items.find((p) => p.storeProductId === '12');
    assert.deepEqual(
      { chain: full.chain, name: full.name, size: full.size, price: full.price, wasPrice: full.wasPrice, isSpecial: full.isSpecial, halfPrice: full.halfPrice, memberOnly: full.memberOnly, unitPriceText: full.unitPriceText },
      { chain: 'woolworths', name: 'Woolworths Full Cream Milk 2L', size: '2L', price: 3.1, wasPrice: 6.2, isSpecial: true, halfPrice: true, memberOnly: false, unitPriceText: '$1.55 / 1L' },
    );
    assert.match(full.imageUrl, /^https:\/\/cdn0\.woolworths\.media\//);
    assert.ok(Array.isArray(w.top));
    // Only the shop's own hosts were asked.
    assert.ok(s.seen.every((x) => new URL(x.url).host === 'www.woolworths.com.au'));

    // The Keg tab with Dan Murphy's: it turns the server away.
    t.R.merger.raw().prepare("UPDATE kv SET value = ? WHERE key = 'settings'").run(JSON.stringify({ enabledChains: ['woolworths', 'danmurphys'], sections: { keg: true } }));
    const k = await t.web.post('/api/v3/search', { q: 'great northern', section: 'keg' });
    assert.equal(k.status, 200, JSON.stringify(k.body));
    assert.deepEqual(k.body.shops, [{ chain: 'danmurphys', name: "Dan Murphy's", status: 'blocked', blocked: true, message: "Dan Murphy's blocked the search from your server. Search it on a phone instead." }]);
    // Not one of the household's shops, a tab without shops, and what can't be searched for.
    assert.equal((await t.web.post('/api/v3/search', { q: 'milk', chain: 'aldi' })).status, 400);
    assert.equal((await t.web.post('/api/v3/search', { q: 'panadol', section: 'pharmacy' })).status, 400);
    assert.equal((await t.web.post('/api/v3/search', { q: '' })).status, 400);
    assert.equal((await t.web.post('/api/v3/search', { q: 'x'.repeat(101) })).status, 400);
    assert.equal((await t.web.post('/api/v3/search', { q: 'milk', barcode: '12ab' })).status, 400);
    assert.equal((await t.web.post('/api/v3/search', { q: 'milk', section: 'garage' })).status, 400);
  });

  test('rate limits: 10 a minute for a browser, 60 an hour for the server', async () => {
    const { t } = await searchHouse();
    await turnOn(t);
    for (let i = 0; i < 10; i++) assert.equal((await t.web.post('/api/v3/search', { q: 'milk', chain: 'woolworths' })).status, 200);
    const no = await t.web.post('/api/v3/search', { q: 'milk', chain: 'woolworths' });
    assert.equal(no.status, 429);
    assert.equal(no.body.error, 'rate');
    assert.ok(Number(no.headers.get('retry-after')) > 0);
    // Other browsers, up to the server's 60 this hour.
    let n = 10;
    while (n < 60) {
      const b = t.web3();
      assert.equal((await b.login('admin', PASS, ITER)).status, 200);
      for (let i = 0; i < 10 && n < 60; i++, n++) assert.equal((await b.post('/api/v3/search', { q: 'milk', chain: 'woolworths' })).status, 200);
    }
    const b = t.web3();
    await b.login('admin', PASS, ITER);
    const full = await b.post('/api/v3/search', { q: 'milk', chain: 'woolworths' });
    assert.equal(full.status, 429);
    assert.equal(full.body.error, 'rate-server');
  });

  test('the log says a search happened and which shops, never what was searched for', async () => {
    const { t } = await searchHouse();
    await turnOn(t);
    assert.equal((await t.web.post('/api/v3/search', { q: 'zebrafruit yoghurt', chain: 'woolworths', barcode: '93000000001' })).status, 200);
    const log = rows(t, 'SELECT * FROM srv_log');
    const row = log.find((r) => r.what === 'shops-searched');
    assert.ok(row);
    assert.match(row.device, /^web-/);
    assert.deepEqual(JSON.parse(row.detail), { tab: 'pantry', shops: { woolworths: 'ok' } });
    const all = JSON.stringify(log);
    assert.ok(!/zebrafruit|yoghurt|93000000001/i.test(all));
    // The activity the web reads says the same.
    const a = await t.web.get('/api/v3/activity');
    assert.ok(!/zebrafruit/i.test(JSON.stringify(a.body)));
  });

  test('Track and Add to list save what was found, as the server, and the phones get it', async () => {
    const { t } = await searchHouse();
    await turnOn(t);
    const p = await addPhone(t, 'Phone');
    const r = await t.web.post('/api/v3/search', { q: 'milk', chain: 'woolworths' });
    const id = r.body.search;
    // Only products from this search, from this browser.
    assert.equal((await t.web.post('/api/v3/search/add', { search: id, picks: [{ chain: 'woolworths', storeProductId: '999' }] })).status, 400);
    assert.equal((await t.web.post('/api/v3/search/add', { search: 'not-a-search', picks: [{ chain: 'woolworths', storeProductId: '12' }] })).status, 410);
    const other = t.web3();
    await other.login('admin', PASS, ITER);
    assert.equal((await other.post('/api/v3/search/add', { search: id, picks: [{ chain: 'woolworths', storeProductId: '12' }] })).status, 410);
    assert.equal((await t.web.post('/api/v3/search/add', { search: id, target: 'garage', picks: [{ chain: 'woolworths', storeProductId: '12' }] })).status, 400);

    const add = await t.web.post('/api/v3/search/add', { search: id, target: 'both', picks: [{ chain: 'woolworths', storeProductId: '12' }] });
    assert.equal(add.status, 200, JSON.stringify(add.body));
    assert.equal(add.body.item.section, 'pantry');
    assert.equal(add.body.products.length, 1);
    const [prod] = rows(t, 'SELECT * FROM products WHERE id = ?', add.body.products[0]);
    assert.deepEqual([prod.chain, prod.store_product_id, prod.name, prod.size], ['woolworths', '12', 'Woolworths Full Cream Milk 2L', '2L']);
    const [price] = rows(t, 'SELECT * FROM prices WHERE product_id = ?', prod.id);
    assert.deepEqual([price.price, price.was_price, price.is_special, price.source], [3.1, 6.2, 1, 'auto']);
    const [it] = rows(t, 'SELECT * FROM items WHERE id = ?', add.body.item.id);
    assert.deepEqual([it.usual_product_id, it.section, it.alert_level], [prod.id, 'pantry', 'good']);
    assert.ok(it.name.length > 0);
    const [ln] = rows(t, 'SELECT * FROM list_entries WHERE id = ?', add.body.line.id);
    assert.deepEqual([ln.item_id, ln.text, ln.qty, ln.checked], [it.id, it.name, 1, 0]);
    // Made as the server (it goes out in its file), at the browser's asking.
    const log = rows(t, "SELECT tbl, device, origin FROM sync_log WHERE tbl IN ('products', 'prices', 'items', 'list_entries')");
    assert.equal(log.length, 4);
    assert.ok(log.every((x) => x.device === 'srv-' + t.sid && /^web-/.test(x.origin)));
    // The phone reads them in the server's file.
    const own = await p.serverFile(t.sid);
    for (const [tbl, pk] of [
      ['products', prod.id],
      ['items', it.id],
      ['list_entries', ln.id],
    ])
      assert.ok(own.entries.find((x) => x.tbl === tbl && x.pk === pk && !x.deleted), tbl);
    assert.ok(own.entries.find((x) => x.tbl === 'prices' && x.pk.startsWith(prod.id + '|')));

    // Found again: it says which pantry item has it, and Add to list alone links the shop's product.
    const again = await t.web.post('/api/v3/search', { q: 'milk', chain: 'woolworths' });
    const hit = again.body.shops[0].items.find((x) => x.storeProductId === '12');
    assert.deepEqual([hit.itemId, hit.itemName], [it.id, it.name]);
    const list = await t.web.post('/api/v3/search/add', { search: again.body.search, target: 'list', qty: 2, picks: [{ chain: 'woolworths', storeProductId: '13' }] });
    assert.equal(list.status, 200, JSON.stringify(list.body));
    assert.equal(list.body.item, null);
    const [l2] = rows(t, 'SELECT * FROM list_entries WHERE id = ?', list.body.line.id);
    assert.deepEqual([l2.item_id, l2.chain, l2.price, l2.qty, JSON.parse(l2.product).storeProductId], [null, 'woolworths', 3.1, 2, '13']);
    // A product already in the household isn't made twice.
    const tr = await t.web.post('/api/v3/search/add', { search: again.body.search, picks: [{ chain: 'woolworths', storeProductId: '12' }] });
    assert.deepEqual(tr.body.products, [prod.id]);
    assert.equal(rows(t, "SELECT COUNT(*) AS n FROM products WHERE store_product_id = '12'")[0].n, 1);
    // Turned off: what was found is gone too.
    await turnOn(t, false);
    await turnOn(t, true);
    assert.equal((await t.web.post('/api/v3/search/add', { search: again.body.search, picks: [{ chain: 'woolworths', storeProductId: '12' }] })).status, 410);
  });
  // 0.9.5 (web search): Add to list on General, from the web's search.
  test('Add to list can put the line on General: a list only, so not with Track', async () => {
    const { t } = await searchHouse();
    await turnOn(t);
    const p = await addPhone(t, 'Phone');
    const r = await t.web.post('/api/v3/search', { q: 'milk', chain: 'woolworths' });
    const id = r.body.search;
    const pick = [{ chain: 'woolworths', storeProductId: '12' }];
    assert.equal((await t.web.post('/api/v3/search/add', { search: id, target: 'both', list: 'general', picks: pick })).status, 400);
    assert.equal((await t.web.post('/api/v3/search/add', { search: id, target: 'pantry', list: 'general', picks: pick })).status, 400);
    assert.equal((await t.web.post('/api/v3/search/add', { search: id, target: 'list', list: 'garage', picks: pick })).status, 400);
    assert.equal((await t.web.post('/api/v3/search/add', { search: id, target: 'list', list: 'keg', picks: pick })).status, 400);
    const g = await t.web.post('/api/v3/search/add', { search: id, target: 'list', list: 'general', qty: 3, picks: pick });
    assert.equal(g.status, 200, JSON.stringify(g.body));
    assert.equal(g.body.item, null);
    assert.equal(g.body.line.list, 'general');
    const [ln] = rows(t, 'SELECT * FROM list_entries WHERE id = ?', g.body.line.id);
    assert.deepEqual([ln.section, ln.item_id, ln.category_id, ln.chain, ln.price, ln.qty], ['general', null, null, 'woolworths', 3.1, 3]);
    assert.equal(JSON.parse(ln.product).storeProductId, '12');
    // Nothing tracked, no products made.
    assert.equal(rows(t, 'SELECT COUNT(*) AS n FROM products')[0].n, 0);
    // The phone (sharing groceries) gets it in the server's file, on General.
    const own = await p.serverFile(t.sid);
    assert.equal(own.entries.find((x) => x.tbl === 'list_entries' && x.pk === ln.id)?.row?.section, 'general');
    // The search's own tab named outright is the same as leaving it out.
    const same = await t.web.post('/api/v3/search/add', { search: id, target: 'list', list: 'pantry', picks: pick });
    assert.equal(rows(t, 'SELECT section FROM list_entries WHERE id = ?', same.body.line.id)[0].section, 'pantry');
  });
});
