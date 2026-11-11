// 0.9.6: Import on the web's Data tab (docs/server-protocol.md "Data: Import (0.9.6)",
// docs/restock-import.md). A file (restock-export v1, or a hand-made one in that shape) is merged ON
// TOP of what the server has: products go into the catalogue and prices into price history, nothing
// else (never the shopping list or the pantry), nothing is replaced and nothing is deleted.
//
// The browser reads the file itself and sends it in chunks (each one a plain JSON request under the
// server's 256 KB cap, MAC'd as every browser request). Each chunk is checked here again, field by
// field, and written in one transaction, so the server answers other requests between chunks and a
// cancelled import keeps exactly the chunks that finished.
// - POST /api/v3/data/import/check   the dry run: what a chunk would add, skip and ignore (any browser
//                                     session, writes nothing).
// - POST /api/v3/data/import/start   { confirm }: a passphrase session, the passphrase again → an
//                                     import id (one import at a time on the server).
// - POST /api/v3/data/import/chunk   { import, n, products }: one chunk, written.
// - POST /api/v3/data/import/finish  { import, cancelled? }: the end (or Cancel): the server's file
//                                     goes out to the phones and the import is logged.
// Rules: a product is the same one when its id (from the file) is one the server has at that shop,
// else the same shop and shop product number, else the same shop and barcode, else the same shop,
// name and size (a file's `ref` is per shop: the same ref at two shops is two products); prices are
// one a day per product (the newest of the day in the file); one the server already has that day at
// the same price is skipped, and so is one older than the reading the server has that day, and (0.9.6
// review) any for a day the product already has an imported price, so one a day holds across chunks
// and imports (the first one in wins); every price added says source "imported". Costco is never taken (Declan's
// rule: Costco prices never go in or out of exports).

import { randomBytes, randomUUID } from 'node:crypto';
import { statfsSync } from 'node:fs';
import { dayIn, partsIn, wallTime } from '../zone.mjs';

const DAY = 24 * 3600 * 1000;
const MIN = 60_000;

/** The caps (docs/restock-import.md "Limits"). The browser checks the file against the same numbers first. */
export const IMPORT_LIMITS = {
  fileMb: 100, // the file the browser reads
  products: 25_000, // products in one import
  prices: 500_000, // prices in one import
  pricesPerProduct: 5_000,
  chunkProducts: 2_000,
  chunkPrices: 5_000,
  serverProducts: 50_000, // products the server holds in all, past which an import adds no new ones
  perMinute: 300, // check and chunk requests a minute, per browser session
  startsPerHour: 10, // imports started on this server in an hour
  idleMs: 10 * MIN, // an import nobody sent a chunk to for this long is over
  maxMs: 2 * 3600 * 1000, // and every import is over after this long
  diskFreeMb: 200, // an import doesn't start with less than this free on the server's disk
  phoneDays: 60, // a product's newest imported price goes to the phones when it's this recent
  name: 200,
  brand: 100,
  size: 40,
  shopId: 100,
  promo: 120,
  imageUrl: 500,
  maxPrice: 10_000,
  qty: 100_000,
};

/** The shop id never imported or exported (Declan, 11 Nov 2026). */
export const NEVER_SHOP = 'costco';
const CHAIN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const REF = /^[A-Za-z0-9_.:-]{1,80}$/;
const PRODUCT_KEYS = new Set(['ref', 'chain', 'store_product_id', 'barcode', 'name', 'brand', 'size', 'image_url', 'qty', 'qty_unit', 'more', 'prices']);
const PRICE_KEYS = new Set(['date', 'price', 'was_price', 'is_special', 'member_only', 'promo']);
const UNITS = new Set(['g', 'ml', 'ea']);
const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATE_LOCAL = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?$/;
const DATE_ZONED = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:?\d{2})$/;
const FLOOR = Date.UTC(2000, 0, 1);

/** Text as kept: NFC, no control characters, spaces collapsed, trimmed; undefined when empty or too long. */
export function cleanText(v, max) {
  if (typeof v !== 'string') return undefined;
  // eslint-disable-next-line no-control-regex
  const s = v.normalize('NFC').replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069\ufeff]/g, ' ').replace(/\s+/g, ' ').trim();
  return s && s.length <= max ? s : undefined;
}

/** A barcode as the phone keeps it (barcode.ts productCode): 8, 12, 13 or 14 digits; a GTIN-14 with leading zeros as its 13. */
export function cleanBarcode(v) {
  const s = typeof v === 'number' && Number.isSafeInteger(v) ? String(v) : typeof v === 'string' ? v.trim() : '';
  if (!/^\d{8,14}$/.test(s)) return undefined;
  let d = s;
  while (d.length > 13 && d.startsWith('0')) d = d.slice(1);
  return /^\d{8}$|^\d{12,14}$/.test(d) ? d : undefined;
}

const flag = (v) => (v === true || v === 1 ? 1 : v === false || v === 0 || v === undefined || v === null ? 0 : null);
const cents = (n) => Math.round(n * 100) / 100;

export function makeImport(R, { zone, now = R.now } = {}) {
  const { S, HttpError } = R;
  const db = () => R.merger.raw();
  const iso = (t = now()) => new Date(t).toISOString();
  // The day a time is in, in the server's zone: Intl once per quarter hour (every zone changes its
  // offset on a quarter hour), then arithmetic (an import checks hundreds of thousands of these).
  const offsets = new Map();
  const Q = 15 * MIN;
  function day(isoText) {
    const t = Date.parse(isoText);
    const q = Math.floor(t / Q);
    let off = offsets.get(q);
    if (off === undefined) {
      const at = q * Q;
      const p = partsIn(at, zone);
      off = Date.UTC(p.y, p.m - 1, p.d, p.h, p.min, p.s) - at;
      if (offsets.size > 100_000) offsets.clear();
      offsets.set(q, off);
    }
    return new Date(t + off).toISOString().slice(0, 10);
  }

  /** When a price was seen, as the ISO time stored: a day alone is noon that day in the server's zone. */
  function dateOf(v) {
    if (typeof v !== 'string' || v.length > 40) return null;
    let t;
    let m;
    if ((m = DATE_ONLY.exec(v))) {
      const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
      if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
      t = wallTime(zone, y, mo, d, 12);
      if (dayIn(t, zone) !== v) return null; // 31 February
    } else if ((m = DATE_LOCAL.exec(v))) {
      const [y, mo, d, h, mi, s] = [1, 2, 3, 4, 5, 6].map((i) => Number(m[i] ?? 0));
      if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || s > 59) return null;
      t = wallTime(zone, y, mo, d, h) + mi * MIN + s * 1000;
      if (dayIn(t, zone) !== `${m[1]}-${m[2]}-${m[3]}`) return null;
    } else if (DATE_ZONED.test(v)) {
      t = Date.parse(v);
    } else return null;
    if (!Number.isFinite(t) || t < FLOOR || t > now() + DAY) return null;
    return iso(t);
  }

  // ---------- checking a chunk ----------

  /** Hosts the household's own products already show pictures from, per shop (the only ones an import may name). */
  function imageHosts() {
    const out = new Map();
    for (const r of db().prepare("SELECT DISTINCT chain, image_url FROM products WHERE image_url LIKE 'https://%' LIMIT 20000").all()) {
      try {
        const u = new URL(String(r.image_url));
        const set = out.get(r.chain) ?? new Set();
        set.add(u.hostname);
        out.set(r.chain, set);
      } catch {
        // not an address
      }
    }
    return out;
  }
  function imageOf(v, chain, hosts) {
    if (typeof v !== 'string' || v.length > IMPORT_LIMITS.imageUrl) return undefined;
    try {
      const u = new URL(v);
      if (u.protocol !== 'https:' || u.username || u.password || u.port || !hosts.get(chain)?.has(u.hostname)) return undefined;
      return u.href;
    } catch {
      return undefined;
    }
  }

  /**
   * The chunk's products, checked: { products: [{ ref, more, p: { chain, store_product_id, barcode,
   * name, brand, size, image_url, qty, qty_unit } | null, prices: [{ date, price, … }], why? }],
   * costco: { products, prices }, problems: { code: n } }. A request with fields the import doesn't
   * take, or too big, is refused whole (400): the browser sends only what it checked.
   */
  function checkChunk(b) {
    if (!b || typeof b !== 'object' || !Array.isArray(b.products)) throw new HttpError(400, 'products', 'Send the products to import.');
    if (b.products.length > IMPORT_LIMITS.chunkProducts) throw new HttpError(400, 'chunk', `At most ${IMPORT_LIMITS.chunkProducts.toLocaleString('en-AU')} products a request.`);
    let priceCount = 0;
    for (const x of b.products) {
      if (!x || typeof x !== 'object' || Array.isArray(x)) throw new HttpError(400, 'products', 'Each product must be an object.');
      for (const k of Object.keys(x)) if (!PRODUCT_KEYS.has(k)) throw new HttpError(400, 'fields', `An import doesn't take "${String(k).slice(0, 40)}".`);
      if (x.prices !== undefined && !Array.isArray(x.prices)) throw new HttpError(400, 'prices', "A product's prices must be a list.");
      for (const p of x.prices ?? []) {
        if (!p || typeof p !== 'object' || Array.isArray(p)) throw new HttpError(400, 'prices', 'Each price must be an object.');
        for (const k of Object.keys(p)) if (!PRICE_KEYS.has(k)) throw new HttpError(400, 'fields', `An import doesn't take "${String(k).slice(0, 40)}".`);
      }
      priceCount += x.prices?.length ?? 0;
    }
    if (priceCount > IMPORT_LIMITS.chunkPrices) throw new HttpError(400, 'chunk', `At most ${IMPORT_LIMITS.chunkPrices.toLocaleString('en-AU')} prices a request.`);

    const problems = {};
    const bad = (code, n = 1) => (problems[code] = (problems[code] ?? 0) + n);
    const costco = { products: 0, prices: 0 };
    const hosts = imageHosts();
    const out = [];
    for (const x of b.products) {
      const prices = x.prices ?? [];
      const ref = typeof x.ref === 'string' && REF.test(x.ref) ? x.ref : null;
      const chain = typeof x.chain === 'string' ? x.chain.trim().toLowerCase() : '';
      const tab = CHAIN.test(chain) ? R.engine?.chainTab(chain) : null;
      // Costco, and any shop whose records stay on one phone (engine.ts LOCAL_TAB 'local'): never.
      if (chain === NEVER_SHOP || tab === 'local') {
        if (x.more !== true) costco.products++;
        costco.prices += prices.length;
        continue;
      }
      const reject = (why) => {
        bad(why);
        if (prices.length) bad('product-ignored-prices', prices.length);
      };
      if (!tab || chain === 'other') {
        reject('shop');
        continue;
      }
      const name = cleanText(x.name, IMPORT_LIMITS.name);
      if (!name) {
        reject('name');
        continue;
      }
      if (prices.length > IMPORT_LIMITS.pricesPerProduct) {
        reject('too-many-prices');
        continue;
      }
      // 0.9.6 (review L7): a shop product number is text or a number; anything else ("[object Object]") isn't one.
      const sid = x.store_product_id;
      if (sid !== undefined && sid !== null && typeof sid !== 'string' && !(typeof sid === 'number' && Number.isFinite(sid))) {
        reject('shop-number');
        continue;
      }
      const p = {
        chain,
        name,
        store_product_id: cleanText(typeof x.store_product_id === 'number' && Number.isFinite(x.store_product_id) ? String(x.store_product_id) : x.store_product_id, IMPORT_LIMITS.shopId) ?? null,
        barcode: x.barcode === undefined || x.barcode === null || x.barcode === '' ? null : (cleanBarcode(x.barcode) ?? null),
        brand: cleanText(x.brand, IMPORT_LIMITS.brand) ?? null,
        size: cleanText(x.size, IMPORT_LIMITS.size) ?? null,
        image_url: imageOf(x.image_url, chain, hosts) ?? null,
        qty: null,
        qty_unit: null,
      };
      if (x.barcode !== undefined && x.barcode !== null && x.barcode !== '' && !p.barcode) bad('barcode-left-out');
      if (x.image_url && !p.image_url) bad('picture-left-out');
      const q = typeof x.qty === 'number' && Number.isFinite(x.qty) && x.qty > 0 && x.qty <= IMPORT_LIMITS.qty ? x.qty : null;
      if (q !== null && UNITS.has(x.qty_unit)) {
        p.qty = q;
        p.qty_unit = x.qty_unit;
      }
      // One a day: the newest of each day (the older ones of that day are skipped, not added).
      const byDay = new Map();
      let older = 0;
      for (const r of prices) {
        const date = dateOf(r.date);
        if (!date) {
          bad('date');
          continue;
        }
        if (typeof r.price !== 'number' || !Number.isFinite(r.price) || r.price < 0.01 || r.price > IMPORT_LIMITS.maxPrice) {
          bad('price');
          continue;
        }
        const price = cents(r.price);
        const special = flag(r.is_special);
        const member = flag(r.member_only);
        if (special === null || member === null) {
          bad('flag');
          continue;
        }
        const wasN = typeof r.was_price === 'number' && Number.isFinite(r.was_price) ? cents(r.was_price) : null;
        const was = wasN !== null && wasN > price && wasN <= IMPORT_LIMITS.maxPrice ? wasN : null;
        const promo = r.promo === undefined || r.promo === null ? null : (cleanText(r.promo, IMPORT_LIMITS.promo) ?? null);
        const row = { date, price, was_price: was, is_special: special, member_only: member, promo };
        const k = day(date);
        const had = byDay.get(k);
        if (had) older++;
        if (!had || had.date < date) byDay.set(k, row);
      }
      out.push({ ref, more: x.more === true, p, prices: [...byDay.values()].sort((a, c) => (a.date < c.date ? -1 : a.date > c.date ? 1 : 0)), older });
    }
    return { products: out, costco, problems };
  }

  // ---------- matching and deciding ----------

  /** 0.9.6 (review L7): a file's ref is per shop (the same ref at another shop is another product). */
  const refKey = (x) => `${x.p.chain}|${x.ref}`;

  /** The server's product for an incoming one (see the rules at the top), or null. */
  function matchOf(x, refs) {
    const raw = db();
    const known = x.ref && refs?.get(refKey(x));
    if (known) return known;
    const { chain } = x.p;
    if (x.ref) {
      const r = raw.prepare('SELECT id FROM products WHERE id = ? AND chain = ?').get(x.ref, chain);
      if (r) return r.id;
    }
    if (x.p.store_product_id) {
      const r = raw.prepare('SELECT id FROM products WHERE chain = ? AND store_product_id = ? ORDER BY id LIMIT 1').get(chain, x.p.store_product_id);
      if (r) return r.id;
    }
    if (x.p.barcode) {
      const r = raw.prepare('SELECT id FROM products WHERE chain = ? AND barcode = ? ORDER BY id LIMIT 1').get(chain, x.p.barcode);
      if (r) return r.id;
    }
    // By name and size only for a product the file gives no shop number or barcode for (typed in).
    if (x.p.store_product_id || x.p.barcode) return null;
    const r = raw
      .prepare("SELECT id FROM products WHERE chain = ? AND lower(name) = lower(?) AND lower(COALESCE(size, '')) = lower(?) ORDER BY id LIMIT 1")
      .get(chain, x.p.name, x.p.size ?? '');
    return r?.id ?? null;
  }

  /**
   * Which of a product's incoming prices to add: one a day, not one already there that day at that
   * price, not older than the day's reading, and (0.9.6 review L7) not on a day the product already
   * has an imported price: in the database (an earlier chunk or import) or earlier in this chunk
   * (`pending`, product id -> days, filled in here).
   */
  function decide(pid, prices, pending) {
    const days = new Map();
    let newest = '';
    if (pid) {
      for (const r of db().prepare('SELECT date, price, source FROM prices WHERE product_id = ?').all(pid)) {
        const d = String(r.date);
        if (d > newest) newest = d;
        const k = day(d);
        const had = days.get(k) ?? { latest: '', prices: new Set(), imported: false };
        if (d > had.latest) had.latest = d;
        had.prices.add(cents(Number(r.price)));
        if (r.source === 'imported') had.imported = true;
        days.set(k, had);
      }
    }
    const mine = pid && pending ? (pending.get(pid) ?? new Set()) : new Set();
    if (pid && pending) pending.set(pid, mine);
    const add = [];
    let skipped = 0;
    for (const r of prices) {
      const k = day(r.date);
      const had = days.get(k);
      if (mine.has(k) || (had && (had.imported || had.prices.has(r.price) || had.latest >= r.date))) {
        skipped++;
        continue;
      }
      mine.add(k);
      add.push(r);
    }
    return { add, skipped, newest };
  }

  // ---------- the dry run ----------

  function check(b) {
    const c = checkChunk(b);
    const out = { products: { add: 0, matched: 0 }, prices: { add: 0, skipped: 0 }, costco: c.costco, problems: c.problems };
    let room = Math.max(0, IMPORT_LIMITS.serverProducts - productCount());
    const pending = new Map();
    for (const x of c.products) {
      const pid = matchOf(x, null);
      out.prices.skipped += x.older;
      if (!pid) {
        if (x.more) {
          // The rest of a product an earlier chunk counted as new: nothing of it is on the server yet.
          out.prices.add += x.prices.length;
          continue;
        }
        if (room <= 0) {
          out.problems.full = (out.problems.full ?? 0) + 1;
          if (x.prices.length) out.problems['product-ignored-prices'] = (out.problems['product-ignored-prices'] ?? 0) + x.prices.length;
          continue;
        }
        room--;
        out.products.add++;
        out.prices.add += x.prices.length;
        continue;
      }
      if (!x.more) out.products.matched++;
      const d = decide(pid, x.prices, pending);
      out.prices.add += d.add.length;
      out.prices.skipped += d.skipped;
    }
    return out;
  }

  const productCount = () => Number(db().prepare('SELECT COUNT(*) AS n FROM products').get().n);

  // ---------- the import itself ----------

  /** The import going on (one at a time), or null. */
  let job = null;
  const starts = [];
  const hits = new Map(); // session hash -> request times (the last minute)
  let timer = null;

  function rate(hash) {
    const t = now();
    const list = (hits.get(hash) ?? []).filter((x) => t - x < MIN);
    if (list.length >= IMPORT_LIMITS.perMinute) throw new HttpError(429, 'rate', 'That was a lot at once. Wait a minute, then go on.', { retryAfter: 60 });
    list.push(t);
    hits.set(hash, list);
    if (hits.size > 200) for (const k of [...hits.keys()].slice(0, 100)) hits.delete(k);
  }

  /** Ends an import (finished, cancelled, or left): the phones get what it added, and it's logged. */
  function end(how) {
    const j = job;
    if (!j) return null;
    job = null;
    if (timer) clearTimeout(timer);
    timer = null;
    if (j.wrote) R.writeOwn();
    const out = { products: j.products, prices: j.prices, costco: j.costco, problems: j.problems, chunks: j.chunks, how };
    R.note(how === 'finished' ? 'data-imported' : 'data-import-stopped', {
      by: j.by,
      how,
      products: j.products.added,
      prices: j.prices.added,
      skipped: j.prices.skipped,
      ignored: Object.values(j.problems).reduce((s, n) => s + n, 0),
      costco: j.costco.products + j.costco.prices,
    });
    return out;
  }
  function expireSoon() {
    if (timer) clearTimeout(timer);
    if (!job) return;
    const t = Math.max(1000, Math.min(job.last + IMPORT_LIMITS.idleMs, job.at + IMPORT_LIMITS.maxMs) - now());
    timer = setTimeout(() => {
      timer = null;
      if (job && (now() - job.last >= IMPORT_LIMITS.idleMs || now() - job.at >= IMPORT_LIMITS.maxMs)) end('left');
      else expireSoon();
    }, t);
    timer.unref?.();
  }
  function current() {
    if (job && (now() - job.last >= IMPORT_LIMITS.idleMs || now() - job.at >= IMPORT_LIMITS.maxMs)) end('left');
    return job;
  }
  function jobFor(actor, id) {
    const j = current();
    if (!j || typeof id !== 'string' || id !== j.id || j.hash !== actor.hash) throw new HttpError(410, 'import-gone', 'That import is over. Start it again: what it added already is skipped.');
    return j;
  }

  function start(actor, b) {
    const j = current();
    if (j) throw new HttpError(409, 'busy', j.hash === actor.hash ? 'An import from this browser is still going.' : 'Another browser is importing. Try again when it has finished.', { retryAfter: 60 });
    const t = now();
    while (starts.length && t - starts[0] > 3600 * 1000) starts.shift();
    if (starts.length >= IMPORT_LIMITS.startsPerHour) throw new HttpError(429, 'rate', 'That is a lot of imports in an hour. Try again later.', { retryAfter: Math.ceil((starts[0] + 3600 * 1000 - t) / 1000) });
    try {
      const s = statfsSync(R.DATA);
      if (Number(s.bavail) * Number(s.bsize) < IMPORT_LIMITS.diskFreeMb * 1024 * 1024) throw new HttpError(507, 'full', 'The server is nearly out of space. Free some up before importing.');
    } catch (e) {
      if (e instanceof HttpError) throw e;
      // disk free not known here: go on
    }
    starts.push(t);
    job = {
      id: randomBytes(16).toString('base64url'),
      hash: actor.hash,
      by: actor.by,
      at: t,
      last: t,
      chunks: 0,
      next: 0,
      refs: new Map(),
      products: { added: 0, matched: 0 },
      prices: { added: 0, skipped: 0, toPhones: 0 },
      costco: { products: 0, prices: 0 },
      problems: {},
      wrote: false,
    };
    expireSoon();
    return { import: job.id, until: iso(Math.min(t + IMPORT_LIMITS.maxMs)), idleMs: IMPORT_LIMITS.idleMs, limits: IMPORT_LIMITS };
  }

  const priceSql = 'INSERT INTO prices (product_id, date, price, was_price, is_special, member_only, promo, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?)';
  const productSql = 'INSERT INTO products (id, chain, name, brand, size, barcode, store_product_id, image_url, qty, qty_unit, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)';

  function chunk(actor, b) {
    const j = jobFor(actor, b?.import);
    if (b.n !== j.next) throw new HttpError(409, 'order', `Send chunk ${j.next} next.`, { next: j.next });
    const c = checkChunk(b);
    let seen = 0;
    for (const x of c.products) seen += x.prices.length;
    const newProducts = c.products.filter((x) => !x.more).length;
    if (j.products.added + j.products.matched + newProducts > IMPORT_LIMITS.products || j.prices.added + j.prices.skipped + seen > IMPORT_LIMITS.prices) {
      throw new HttpError(413, 'too-many', `One import takes at most ${IMPORT_LIMITS.products.toLocaleString('en-AU')} products and ${IMPORT_LIMITS.prices.toLocaleString('en-AU')} prices.`);
    }
    const raw = db();
    const at = iso();
    const phoneFrom = iso(now() - IMPORT_LIMITS.phoneDays * DAY);
    const out = { products: { added: 0, matched: 0 }, prices: { added: 0, skipped: 0, toPhones: 0 }, costco: c.costco, problems: { ...c.problems } };
    const made = [];
    const loud = [];
    const quiet = [];
    const refs = new Map();
    let room = Math.max(0, IMPORT_LIMITS.serverProducts - productCount());
    const pending = new Map();
    raw.exec('BEGIN');
    try {
      for (const x of c.products) {
        out.prices.skipped += x.older;
        let pid = matchOf(x, j.refs);
        if (pid) {
          if (!x.more) out.products.matched++;
        } else {
          if (room <= 0) {
            out.problems.full = (out.problems.full ?? 0) + 1;
            if (x.prices.length) out.problems['product-ignored-prices'] = (out.problems['product-ignored-prices'] ?? 0) + x.prices.length;
            continue;
          }
          room--;
          pid = x.ref && !x.ref.startsWith('demo-') && !raw.prepare('SELECT 1 FROM products WHERE id = ?').get(x.ref) ? x.ref : randomUUID();
          const p = x.p;
          raw.prepare(productSql).run(pid, p.chain, p.name, p.brand, p.size, p.barcode, p.store_product_id, p.image_url, p.qty, p.qty_unit, at);
          made.push(['products', pid]);
          out.products.added++;
        }
        if (x.ref) refs.set(refKey(x), pid);
        const d = decide(pid, x.prices, pending);
        out.prices.skipped += d.skipped;
        // The phones get the product's newest price when it's newer than any the server had and
        // recent (as a phone's file carries its recent prices); the rest stays on the server.
        const last = d.add[d.add.length - 1];
        for (const r of d.add) {
          const toPhones = r === last && r.date > d.newest && r.date >= phoneFrom;
          (toPhones ? loud : quiet).push([pid, r]);
        }
      }
      const put = raw.prepare(priceSql);
      const write = ([pid, r]) => put.run(pid, r.date, r.price, r.was_price, r.is_special, r.member_only, r.promo, 'imported');
      // Older history quietly (no sync record: kept on the server, as offloaded months are).
      if (quiet.length) {
        raw.exec("INSERT OR REPLACE INTO sync_meta (key, value) VALUES ('applying', '1')");
        for (const q of quiet) write(q);
        raw.exec("DELETE FROM sync_meta WHERE key = 'applying'");
      }
      for (const l of loud) {
        write(l);
        made.push(['prices', `${l[0]}|${l[1].date}`]);
      }
      out.prices.added = quiet.length + loud.length;
      out.prices.toPhones = loud.length;
      // Made by the server (so it goes out in its file), at this browser's asking (as search/add).
      const me = 'srv-' + S.sid;
      const mark = raw.prepare('UPDATE sync_log SET origin = ? WHERE tbl = ? AND pk = ? AND origin = ?');
      for (const [tbl, pk] of made) mark.run(j.by, tbl, pk, me);
      raw.exec('COMMIT');
    } catch (e) {
      raw.exec('ROLLBACK');
      throw e;
    }
    for (const [k, v] of refs) if (j.refs.size < IMPORT_LIMITS.products * 2) j.refs.set(k, v);
    j.next++;
    j.chunks++;
    j.last = now();
    if (made.length) j.wrote = true;
    j.products.added += out.products.added;
    j.products.matched += out.products.matched;
    j.prices.added += out.prices.added;
    j.prices.skipped += out.prices.skipped;
    j.prices.toPhones += out.prices.toPhones;
    j.costco.products += out.costco.products;
    j.costco.prices += out.costco.prices;
    for (const [k, n] of Object.entries(out.problems)) j.problems[k] = (j.problems[k] ?? 0) + n;
    expireSoon();
    return { ...out, n: b.n, next: j.next };
  }

  function finish(actor, b) {
    jobFor(actor, b?.import);
    return end(b.cancelled === true ? 'cancelled' : 'finished');
  }

  // ---------- the endpoints ----------

  async function api(c) {
    const { path, method, actor } = c;
    const answer = (obj) => c.sealedAnswer(actor, 200, obj, c.req, c.res);
    if (method !== 'POST') throw new HttpError(404, 'not-found', 'Not found.');
    if (path === '/api/v3/data/import/check') {
      c.needWeb(actor);
      rate(actor.hash);
      return answer(check(c.input()));
    }
    if (path === '/api/v3/data/import/start') {
      c.needWeb(actor, 'passphrase');
      const b = c.input();
      if (current()) start(actor, b); // busy: said before the passphrase is checked (and used)
      c.needConfirm(actor, b, c.ip, 'import');
      return answer(start(actor, b));
    }
    if (path === '/api/v3/data/import/chunk') {
      c.needWeb(actor, 'passphrase');
      rate(actor.hash);
      return answer(chunk(actor, c.input()));
    }
    if (path === '/api/v3/data/import/finish') {
      c.needWeb(actor, 'passphrase');
      return answer(finish(actor, c.input()));
    }
    throw new HttpError(404, 'not-found', 'Not found.');
  }

  /** Delete everything on this server: an import going on just stops. */
  function forget() {
    job = null;
    if (timer) clearTimeout(timer);
    timer = null;
  }

  return { api, check, dateOf, forget, current: () => current(), end };
}
