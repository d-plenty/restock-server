// 0.9.5: "Let the web page search the shops" (docs/server-protocol.md "Web search of the shops").
// The one time the server contacts a shop: a server setting (S.settings.webSearch, off unless someone
// signed in with the passphrase turns it on), and then only when a signed-in browser presses Search.
// The search itself is the phone's, run by the Restock core (src/server-core/search.ts and
// src/stores/node.ts in the Restock repo): the household's shops on that tab, its Coles branch, the
// same ranking; only the shops' own hosts, 10 s a shop, 3 MB an answer, no redirects elsewhere,
// cookies for that one search only, never a shop sign-in. No timer here: nothing in the background.
//
// What's found is kept (in memory, 15 minutes, for that browser only) so "Track" and "Add to list"
// can save one of those products, at the price the shop gave, without the browser sending a price:
// the server writes the product, its price, the pantry item and/or the list line itself (as the
// server, so they go out in its file to every phone; the record's origin is the browser).
//
// Logged in srv_log (activity): that a search happened, by whom, on which tab, which shops and how
// each answered. Never what was searched for.

import { randomBytes, randomUUID } from 'node:crypto';

const MIN = 60_000;
const HOUR = 60 * MIN;
export const SEARCH_LIMITS = {
  perSessionPerMinute: 10,
  perServerPerHour: 60,
  maxQuery: 100,
  keepMs: 15 * MIN,
  keptMax: 200,
  maxPicks: 6,
};
export const OFF_MESSAGE = 'Turn on Let the web page search the shops in Settings.';
// 0.10.3: and Baby and Pets (beta).
// 0.10.7: and the custom sections c1–c6 (the app's shops.ts SECTIONS)
const SECTIONS = ['pantry', 'keg', 'pharmacy', 'baby', 'pets', 'c1', 'c2', 'c3', 'c4', 'c5', 'c6'];
const TARGETS = ['pantry', 'list', 'both'];
const CHAIN = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function makeSearch(R) {
  const { S, HttpError, now } = R;
  const core = R.core;
  /** search id -> { hash (the browser's session), at, section, barcode, products: Map "chain:id" -> found } */
  const kept = new Map();
  const perSession = new Map(); // session hash -> [times in the last minute]
  let perServer = []; // times in the last hour
  const db = () => R.merger.raw();
  const iso = (t = now()) => new Date(t).toISOString();

  const enabled = () => S.settings?.webSearch === true;
  function needOn() {
    if (!enabled()) throw new HttpError(403, 'web-search-off', OFF_MESSAGE);
  }

  /** Counts this search, or says to wait (checked and counted at once, before anything is awaited). */
  function count(actor) {
    const t = now();
    perServer = perServer.filter((x) => t - x < HOUR);
    const mine = (perSession.get(actor.hash) ?? []).filter((x) => t - x < MIN);
    if (mine.length >= SEARCH_LIMITS.perSessionPerMinute) {
      throw new HttpError(429, 'rate', "That's a lot of searches in a minute. Wait a moment, then try again.", { retryAfter: Math.max(1, Math.ceil((mine[0] + MIN - t) / 1000)) });
    }
    if (perServer.length >= SEARCH_LIMITS.perServerPerHour) {
      throw new HttpError(429, 'rate-server', `Your server has searched the shops ${SEARCH_LIMITS.perServerPerHour} times this hour. Try again later, or search on a phone.`, {
        retryAfter: Math.max(1, Math.ceil((perServer[0] + HOUR - t) / 1000)),
      });
    }
    mine.push(t);
    perSession.set(actor.hash, mine);
    perServer.push(t);
  }

  function prune() {
    const t = now();
    for (const [k, v] of kept) if (t - v.at > SEARCH_LIMITS.keepMs) kept.delete(k);
    while (kept.size > SEARCH_LIMITS.keptMax) kept.delete(kept.keys().next().value);
    for (const [k, v] of perSession) if (!v.some((x) => t - x < MIN)) perSession.delete(k);
  }

  function settings() {
    try {
      const r = db().prepare("SELECT value FROM kv WHERE key = 'settings'").get();
      return r ? JSON.parse(r.value) : {};
    } catch {
      return {};
    }
  }

  /** Found products already in one of the household's pantry items: "chain:id" -> { itemId, itemName }. */
  function tracked(keys) {
    const out = new Map();
    if (!keys.size) return out;
    const byId = new Map();
    for (const p of db().prepare('SELECT id, chain, store_product_id FROM products WHERE store_product_id IS NOT NULL').all()) {
      const k = `${p.chain}:${p.store_product_id}`;
      if (keys.has(k)) byId.set(p.id, k);
    }
    if (!byId.size) return out;
    const list = (v) => {
      try {
        const a = JSON.parse(v ?? '[]');
        return Array.isArray(a) ? a : [];
      } catch {
        return [];
      }
    };
    for (const g of db().prepare('SELECT id, name, usual_product_id, same_product_ids, alt_product_ids FROM items').all()) {
      for (const pid of [g.usual_product_id, ...list(g.same_product_ids), ...list(g.alt_product_ids)]) {
        const k = byId.get(pid);
        if (k && !out.has(k)) out.set(k, { itemId: g.id, itemName: g.name });
      }
    }
    return out;
  }

  // ---------- POST /api/v3/search ----------

  async function search(actor, b) {
    needOn();
    prune();
    const q = typeof b.q === 'string' ? b.q.normalize('NFKC').replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').replace(/\s+/g, ' ').trim() : '';
    if (!q) throw new HttpError(400, 'q', 'Type what to search for.');
    if (q.length > SEARCH_LIMITS.maxQuery) throw new HttpError(400, 'q', `Search for ${SEARCH_LIMITS.maxQuery} letters or fewer.`);
    const barcode = b.barcode === undefined || b.barcode === null || b.barcode === '' ? undefined : String(b.barcode);
    if (barcode !== undefined && !/^\d{8,14}$/.test(barcode)) throw new HttpError(400, 'barcode', 'A barcode is 8 to 14 numbers.');
    const section = b.section === undefined ? 'pantry' : b.section;
    if (!SECTIONS.includes(section)) throw new HttpError(400, 'section', 'Search the Pantry, Keg, Health, Baby or Pets shops.');
    const only = b.chain === undefined || b.chain === null ? undefined : String(b.chain);
    if (only !== undefined && !CHAIN.test(only)) throw new HttpError(400, 'chain', "That isn't one of your shops.");
    const rows = db().prepare("SELECT k, v FROM household_settings WHERE k LIKE 'branch:%'").all();
    const plan = core.searchPlan(settings(), section, rows, only);
    if (plan.error === 'shop') throw new HttpError(400, 'chain', "That isn't one of your shops.");
    if (!plan.asks.length) throw new HttpError(400, 'shops', 'Pick your shops for that tab in Settings first.');
    count(actor);

    const config = {};
    if (R.cfg.shopFetch) config.fetch = R.cfg.shopFetch;
    if (R.cfg.shopTimeoutMs) config.timeoutMs = R.cfg.shopTimeoutMs;
    let r;
    try {
      r = await core.searchShops({ q, barcode, asks: plan.asks, config });
    } catch (e) {
      R.log('search:', e?.message ?? e);
      throw new HttpError(502, 'search', "The server couldn't search the shops just now. Try again, or search on a phone.");
    }
    const products = new Map();
    for (const s of r.shops) if (s.status === 'ok') for (const p of s.items) products.set(`${p.chain}:${p.storeProductId}`, p);
    const have = tracked(new Set(products.keys()));
    const shops = r.shops.map((s) =>
      s.status !== 'ok' ? s : { ...s, items: s.items.map((p) => ({ ...p, ...(have.get(`${p.chain}:${p.storeProductId}`) ?? {}) })) },
    );
    const id = randomBytes(12).toString('base64url');
    kept.set(id, { hash: actor.hash, at: now(), section, barcode, products });
    // That it happened and how each shop answered: never what was searched for.
    R.note('shops-searched', { by: actor.by, tab: section, shops: Object.fromEntries(r.shops.map((s) => [s.chain, s.status])) });
    return { search: id, at: iso(), expires: iso(now() + SEARCH_LIMITS.keepMs), text: r.text, section, shops };
  }

  // ---------- POST /api/v3/search/add ----------

  function add(actor, b) {
    needOn();
    prune();
    const k = typeof b.search === 'string' ? kept.get(b.search) : undefined;
    if (!k || k.hash !== actor.hash) throw new HttpError(410, 'search-gone', 'Search again first: that search is over.');
    const target = b.target === undefined ? 'pantry' : b.target;
    if (!TARGETS.includes(target)) throw new HttpError(400, 'target', 'Track it, add it to the list, or both.');
    if (!Array.isArray(b.picks) || !b.picks.length || b.picks.length > SEARCH_LIMITS.maxPicks) throw new HttpError(400, 'picks', `Pick 1 to ${SEARCH_LIMITS.maxPicks} products from the search.`);
    const picks = [];
    for (const x of b.picks) {
      const key = x && typeof x === 'object' ? `${String(x.chain ?? '')}:${String(x.storeProductId ?? '')}` : '';
      const p = k.products.get(key);
      if (!p) throw new HttpError(400, 'picks', "That product isn't in this search. Search again.");
      if (!picks.includes(p)) picks.push(p);
    }
    const section = k.section;
    const typed = b.name === undefined || b.name === null ? '' : R.cleanName(b.name);
    const name = (typed || core.genericName(picks[0].name, picks[0].brand) || picks[0].name).slice(0, 80);
    let categoryId = null;
    if (b.categoryId !== undefined && b.categoryId !== null && b.categoryId !== '') {
      const c = typeof b.categoryId === 'string' && b.categoryId.length <= 80 ? db().prepare('SELECT id, section FROM categories WHERE id = ?').get(b.categoryId) : undefined;
      if (!c || (c.section ?? 'pantry') !== section) throw new HttpError(400, 'categoryId', "That category isn't on this tab.");
      categoryId = c.id;
    }
    const qty = b.qty === undefined ? 1 : b.qty;
    if (!Number.isInteger(qty) || qty < 1 || qty > 99) throw new HttpError(400, 'qty', 'Add 1 to 99.');
    // 0.9.5 (web search): `list: "general"` puts the line on General (a list only: no pantry item, no
    // category), so only with Add to list. Otherwise (or `list` the search's own tab) as before.
    const list = b.list === undefined || b.list === null || b.list === section ? section : b.list;
    if (list !== section && list !== 'general') throw new HttpError(400, 'list', 'Put it on this tab\'s list or on General.');
    if (list === 'general' && target !== 'list') throw new HttpError(400, 'list', 'General is a list only: use Add to list for it.');

    const raw = db();
    const at = iso();
    const t = now();
    const made = []; // [tbl, pk] the browser made
    const productIds = [];
    let itemId = null;
    let lineId = null;
    raw.exec('BEGIN');
    try {
      if (target !== 'list') {
        for (const p of picks) {
          const had = raw.prepare('SELECT id FROM products WHERE chain = ? AND store_product_id = ? LIMIT 1').get(p.chain, p.storeProductId);
          let id = had?.id;
          if (!id) {
            id = randomUUID();
            raw
              .prepare('INSERT INTO products (id, chain, name, brand, size, barcode, store_product_id, image_url, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
              .run(id, p.chain, p.name, p.brand ?? null, p.size ?? null, p.barcode ?? k.barcode ?? null, p.storeProductId, p.imageUrl ?? null, at);
            made.push(['products', id]);
          }
          if (p.price !== undefined) {
            raw
              .prepare('INSERT INTO prices (product_id, date, price, was_price, is_special, member_only, promo, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
              .run(id, at, p.price, p.wasPrice ?? null, p.isSpecial ? 1 : 0, p.memberOnly ? 1 : 0, p.promo ?? null, 'auto');
            made.push(['prices', `${id}|${at}`]);
          }
          if (!productIds.includes(id)) productIds.push(id);
        }
        // As the phone's Add: the first pick is the usual one, the rest the same thing at other shops.
        itemId = randomUUID();
        raw
          .prepare(
            'INSERT INTO items (id, name, category_id, usual_product_id, same_product_ids, alt_product_ids, threshold_pct, alert_level, allow_bulk, allow_multi, section, target_price, any_size, not_at, created_at) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, 0, 1, ?, NULL, 0, NULL, ?)',
          )
          .run(itemId, name, categoryId, productIds[0], JSON.stringify(productIds.slice(1)), '[]', 'good', section, at);
        made.push(['items', itemId]);
      }
      if (target !== 'pantry') {
        lineId = randomUUID();
        const one = itemId ? undefined : [...picks].filter((p) => p.price !== undefined).sort((a, c) => a.price - c.price)[0];
        const chain = itemId ? null : (one ?? picks[0]).chain;
        const product = one
          ? JSON.stringify({ chain: one.chain, name: one.name, brand: one.brand, size: one.size, imageUrl: one.imageUrl, storeProductId: one.storeProductId, unitText: one.unitText || undefined })
          : null;
        raw
          .prepare('INSERT INTO list_entries (id, text, item_id, chain, category_id, qty, price, section, product, checked, created_at, checked_at, qty_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)')
          .run(lineId, name, itemId, chain, list === 'general' ? null : categoryId, qty, one?.price ?? null, list, product, at, t, t);
        made.push(['list_entries', lineId]);
      }
      // Made by the server (so it goes out in its file), at this browser's asking.
      const me = 'srv-' + S.sid;
      const mark = raw.prepare('UPDATE sync_log SET origin = ? WHERE tbl = ? AND pk = ? AND origin = ?');
      for (const [tbl, pk] of made) mark.run(actor.by, tbl, pk, me);
      raw.exec('COMMIT');
    } catch (e) {
      raw.exec('ROLLBACK');
      throw e;
    }
    R.writeOwn();
    if (lineId) R.ha?.soon();
    R.note('added-from-search', { by: actor.by, tab: section, tracked: !!itemId, listed: !!lineId, ...(list === 'general' ? { list } : {}), shops: [...new Set(picks.map((p) => p.chain))] });
    return { item: itemId ? { id: itemId, name, section } : null, products: productIds, line: lineId ? { id: lineId, list } : null };
  }

  /** The setting, for GET/PUT /api/v3/settings. */
  function setEnabled(on) {
    if (!S.settings || typeof S.settings !== 'object') S.settings = {};
    S.settings.webSearch = on === true;
    if (!on) kept.clear();
  }

  return { search, add, enabled, setEnabled };
}
