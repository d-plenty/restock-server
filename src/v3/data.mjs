// 0.9.5: the web's Data tab, server side (docs/server-protocol.md "Data (0.9.5)").
// - Spending from ticked list lines (srv_spend): every tick the server sees, whoever made it (a phone,
//   the web, Home Assistant), is one purchase at the line's shop on the day it was ticked. Not receipts.
// - Reads: storage per kind, statistics for a period, top items, one item's price over time.
// - The export (restock-export v1): the household's data as clean tables, never a card number, a
//   key, a token or a password.
// - Manage: delete by kind (optionally older than a date), Delete everything on this server, Auto
//   delete (0.9.4's Keep data for), Ask phones to resend, Recount.
// Every endpoint is a browser session's (RestockWeb3), answers sealed; deleting needs the passphrase
// again (needConfirm) and the typed word.

import { promises as fs, statfsSync } from 'node:fs';
import { join } from 'node:path';
import { AUTO_KINDS, FOREVER } from './merge.mjs';
import { autoDeleteOk } from './house.mjs';
import { dayIn, monthIn, serverZone, wallTime } from '../zone.mjs';
import { makeImport, NEVER_SHOP } from './import.mjs';

const DAY = 24 * 3600 * 1000;
/** An untick within this long of the tick takes the purchase back (it was a mis-tap or not bought). */
export const UNDO_MS = 2 * DAY;
/** computeStats' window (verdict.ts HISTORY_DAYS): the usual price looks back this far. */
const HISTORY_DAYS = 183;
export const KINDS = ['prices', 'receipts', 'stats', 'logs', 'backups'];
export const WORD = 'DELETE';
export const WORD_ALL = 'DELETE EVERYTHING';
const LIMITS = { tableRows: 50000, pageRows: 10000, pageDefault: 5000, topMax: 50, topDefault: 10, recountRows: 100000, recountChunk: 500, recountGapS: 60, seriesWeeks: 530, paid: 200, removedKept: 1000 };
const CHAIN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
/** The shopping lists' names (shops.ts LIST_NAMES): internal ids stay (pharmacy is Health). */
const LIST_NAMES = { pantry: 'Groceries', keg: 'Keg', pharmacy: 'Health', general: 'General' };

const round2 = (n) => Math.round(n * 100) / 100;
const pad = (n) => String(n).padStart(2, '0');
const num = (v) => (v === null || v === undefined ? null : Number(v));
function median(values) {
  if (!values.length) return undefined;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}
/**
 * verdict.ts localDay: the calendar day in the server's time zone (zone.mjs: TZ). 0.9.5 (final
 * review): worked out with Intl in that one zone, as months and the night's Auto delete are.
 */
function localDay(iso, zone) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return String(iso).slice(0, 10);
  return dayIn(t, zone);
}
/** The specials week a day is in (verdict.ts specialsWeekStart: weeks start on Wednesday), as yyyy-mm-dd. */
function weekOf(date, zone) {
  const day = localDay(date, zone);
  const [y, m, d] = day.split('-').map(Number);
  // Calendar arithmetic only (no zone): the day's weekday, back to its Wednesday.
  const from = new Date(Date.UTC(y, m - 1, d));
  from.setUTCDate(from.getUTCDate() - ((from.getUTCDay() + 7 - 3) % 7));
  return `${from.getUTCFullYear()}-${pad(from.getUTCMonth() + 1)}-${pad(from.getUTCDate())}`;
}
function jsonOr(v, fallback) {
  if (typeof v !== 'string') return fallback;
  try {
    return JSON.parse(v);
  } catch {
    return fallback;
  }
}
const ids = (v) => (Array.isArray(jsonOr(v, null)) ? jsonOr(v, []).filter((x) => typeof x === 'string') : []);

export function makeData(R) {
  const { S, now, HttpError } = R;
  /** 0.9.5 (final review): one time zone for every day and month here (zone.mjs). */
  const ZONE = R.cfg?.timeZone || serverZone();
  const localMonth = (ms) => monthIn(ms, ZONE);
  const db = () => R.merger.raw();
  const iso = (t = now()) => new Date(t).toISOString();
  /** 0.9.6: Import (import.mjs). */
  const importer = makeImport(R, { zone: ZONE, now });

  // ---------- prices and the usual price ----------

  /** The newest price of a product on or before `at` (ms), else its newest at all. */
  function priceAt(pid, at) {
    const q = 'SELECT date, price, was_price, is_special, member_only FROM prices WHERE product_id = ?';
    return db().prepare(q + ' AND date <= ? ORDER BY date DESC LIMIT 1').get(pid, iso(at)) ?? db().prepare(q + ' ORDER BY date DESC LIMIT 1').get(pid) ?? null;
  }

  /**
   * The usual price of a product at `at` (ms): verdict.ts computeStats' `typical` (hasCard: the server
   * can't know), ported: the last reading of each day in the 183 days to `at`, the median of the ones
   * not on special, else the median of the shops' "was" prices; with no readings, the shared history's
   * usual price (market.normal). Null when nothing says.
   */
  function usualOf(pid, at, memo) {
    if (!pid) return null;
    const key = pid + '|' + localDay(iso(at), ZONE);
    if (memo?.has(key)) return memo.get(key);
    const rows = db()
      .prepare('SELECT date, price, was_price, is_special FROM prices WHERE product_id = ? AND date >= ? AND date <= ? ORDER BY date')
      .all(pid, iso(at - HISTORY_DAYS * DAY), iso(at));
    const byDay = new Map();
    for (const r of rows) byDay.set(localDay(r.date, ZONE), r);
    const readings = [...byDay.values()];
    let u = median(readings.filter((r) => !Number(r.is_special)).map((r) => Number(r.price)));
    if (u === undefined) u = median(readings.map((r) => num(r.was_price)).filter((v) => v !== null && v > 0));
    if (u === undefined) {
      const m = db().prepare('SELECT m.normal FROM market m JOIN products p ON p.chain = m.chain AND p.store_product_id = m.store_product_id WHERE p.id = ? LIMIT 1').get(pid);
      u = m && Number(m.normal) > 0 ? Number(m.normal) : undefined;
    }
    const out = u === undefined ? null : round2(u);
    memo?.set(key, out);
    return out;
  }

  /** An item's products: its usual one, the same ones, then the ones it would also take (role main/alt). */
  function productsOf(itemId) {
    const it = db().prepare('SELECT usual_product_id, same_product_ids, alt_product_ids FROM items WHERE id = ?').get(itemId);
    if (!it) return [];
    const order = [];
    const seen = new Set();
    const add = (id, role) => {
      if (typeof id === 'string' && id && !seen.has(id)) {
        seen.add(id);
        order.push({ id, role });
      }
    };
    add(it.usual_product_id, 'main');
    for (const id of ids(it.same_product_ids)) add(id, 'main');
    for (const id of ids(it.alt_product_ids)) add(id, 'alt');
    const chains = new Map();
    if (order.length) {
      const q = db().prepare(`SELECT id, chain FROM products WHERE id IN (${order.map(() => '?').join(',')})`);
      for (const r of q.all(...order.map((o) => o.id))) chains.set(r.id, r.chain);
    }
    return order.filter((o) => chains.has(o.id)).map((o) => ({ ...o, chain: chains.get(o.id) }));
  }

  /** The line's own product (a one-off buy found at a shop: its storeProductId), if the server has it. */
  function lineProduct(lp, chain) {
    if (!lp || typeof lp.storeProductId !== 'string' || !chain) return null;
    return db().prepare('SELECT id FROM products WHERE chain = ? AND store_product_id = ? LIMIT 1').get(chain, lp.storeProductId)?.id ?? null;
  }

  /**
   * What a ticked line cost: { chain, price (per pack), usual, special, product_id, src }.
   * - The line's own price (list_entries.price is per pack: the list totals price × qty), else
   * - the newest known price of the item at the line's shop (its usual product first, then the same
   *   ones, then the ones it would also take), or, when the line has no shop, the cheapest newest price
   *   of its usual and same products (the list's own pick, roughly), whose shop it then is; else
   * - no price (counted as "ticked without a price").
   */
  function priceFor(l, at, memo) {
    const item = l.item_id ? db().prepare('SELECT name, section FROM items WHERE id = ?').get(l.item_id) : null;
    const lp = jsonOr(l.product, null);
    let chain = typeof l.chain === 'string' && CHAIN.test(l.chain) ? l.chain : lp && typeof lp.chain === 'string' && CHAIN.test(lp.chain) ? lp.chain : null;
    const shop = chain && chain !== 'other' ? chain : null;
    const base = { section: l.section ?? item?.section ?? 'pantry', text: String(item?.name ?? l.text ?? '').slice(0, 200) };
    const own = num(l.price);
    if (own !== null && Number.isFinite(own) && own >= 0 && own < 100000) {
      let pid = lineProduct(lp, shop);
      if (!pid && l.item_id && shop) pid = productsOf(l.item_id).find((p) => p.chain === shop)?.id ?? null;
      const usual = usualOf(pid, at, memo);
      return { ...base, chain, price: round2(own), usual, special: usual !== null && own < usual - 0.005 ? 1 : 0, product_id: pid, src: 'line' };
    }
    let pick = null;
    if (l.item_id) {
      const cands = productsOf(l.item_id);
      if (shop) {
        for (const c of cands.filter((x) => x.chain === shop)) {
          const p = priceAt(c.id, at);
          if (p) {
            pick = { c, p };
            break;
          }
        }
      } else {
        const mains = cands.filter((x) => x.role === 'main');
        for (const c of mains.length ? mains : cands) {
          const p = priceAt(c.id, at);
          if (p && (!pick || Number(p.price) < Number(pick.p.price))) pick = { c, p };
        }
        if (pick) chain = pick.c.chain;
      }
    } else {
      const pid = lineProduct(lp, shop);
      const p = pid ? priceAt(pid, at) : null;
      if (p) pick = { c: { id: pid, chain: shop }, p };
    }
    if (pick) {
      return { ...base, chain, price: round2(Number(pick.p.price)), usual: usualOf(pick.c.id, at, memo), special: Number(pick.p.is_special) ? 1 : 0, product_id: pick.c.id, src: 'price' };
    }
    return { ...base, chain, price: null, usual: null, special: 0, product_id: null, src: 'none' };
  }

  // ---------- spending from ticks (srv_spend) ----------

  /**
   * 0.9.5 (final review): how many were bought, as the list counts them: `qty`, or for an "Any size"
   * item priced from one of its products, the packs of it the list said to buy (shopTotals packsFor:
   * three 500 g bags for 1.5 kg). The total is that × the price, the same total the list showed.
   */
  function boughtOf(l, p, qty) {
    if (!l.item_id || !p.product_id || p.src !== 'price' || typeof R.core?.packsFor !== 'function') return qty;
    const it = db().prepare('SELECT any_size, usual_product_id FROM items WHERE id = ?').get(l.item_id);
    if (!it || !Number(it.any_size) || !it.usual_product_id) return qty;
    const get = db().prepare('SELECT name, size, qty, qty_unit FROM products WHERE id = ?');
    const asProduct = (r) => r && { name: String(r.name ?? ''), size: r.size ?? undefined, qty: num(r.qty) ?? undefined, qtyUnit: r.qty_unit ?? undefined };
    const pick = asProduct(get.get(p.product_id));
    const usual = asProduct(get.get(it.usual_product_id));
    if (!pick || !usual) return qty;
    const n = R.core.packsFor(pick, usual, qty);
    return Number.isInteger(n) && n >= 1 ? Math.min(10000, n) : qty;
  }

  const insertSql =
    'INSERT OR REPLACE INTO srv_spend (entry_id, checked_at, at, chain, section, item_id, product_id, text, qty, price, total, usual, special, src) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)';
  function writeSpend(l, at, memo) {
    const p = priceFor(l, at, memo);
    const qty = boughtOf(l, p, Math.max(1, Math.min(10000, Math.trunc(Number(l.qty) || 1))));
    db()
      .prepare(insertSql)
      .run(l.id, at, iso(at), p.chain, p.section, l.item_id ?? null, p.product_id, p.text, qty, p.price, p.price === null ? null : round2(p.price * qty), p.usual, p.special, p.src);
    return p;
  }

  /**
   * Notes the ticks: each line ticked (checked = 1, checked_at set) is a purchase keyed by the line and
   * its checked_at; a line unticked within UNDO_MS of its tick takes that purchase back, and so does a
   * new tick within UNDO_MS of an earlier one (there was an untick between). A line cleared off the list
   * keeps its purchase. Idempotent: it looks at the list as it is, so running it again changes nothing.
   * Ticks older than Auto delete's cut-off aren't noted. Lines made by the demo aren't either.
   */
  function sweep() {
    const raw = db();
    if (!raw || !R.engine) return null;
    const cut = R.house.cutoff(now());
    // Not before Auto delete's cut-off, nor before the last time statistics were deleted.
    const cutMs = Math.max(cut ? Date.parse(cut) : -Infinity, Number(R.engine.meta('srv_spend_floor') ?? 0) || -Infinity);
    const t = now();
    const memo = new Map();
    const out = { added: 0, removed: 0 };
    const has = raw.prepare('SELECT 1 FROM srv_spend WHERE entry_id = ? AND checked_at = ?');
    const undo = raw.prepare('DELETE FROM srv_spend WHERE entry_id = ? AND checked_at < ? AND checked_at > ?');
    raw.exec('SAVEPOINT spend');
    try {
      const ticked = raw
        .prepare("SELECT id, text, item_id, chain, section, qty, price, product, checked_at FROM list_entries WHERE checked = 1 AND checked_at IS NOT NULL AND id NOT LIKE 'demo-%' AND COALESCE(item_id, '') NOT LIKE 'demo-%'")
        .all();
      for (const l of ticked) {
        const at = Number(l.checked_at);
        if (!Number.isFinite(at) || at <= 0 || at > t + DAY || has.get(l.id, at)) continue;
        out.removed += Number(undo.run(l.id, at, at - UNDO_MS).changes);
        if (at < cutMs) continue;
        writeSpend(l, at, memo);
        out.added++;
      }
      for (const l of raw.prepare('SELECT id, checked_at FROM list_entries WHERE checked = 0 AND checked_at IS NOT NULL').all()) {
        const at = Number(l.checked_at);
        if (Number.isFinite(at)) out.removed += Number(undo.run(l.id, at, at - UNDO_MS).changes);
      }
      raw.exec('RELEASE spend');
    } catch (e) {
      raw.exec('ROLLBACK TO spend');
      raw.exec('RELEASE spend');
      throw e;
    }
    return out;
  }

  /**
   * Recount: the ticks noted again (sweep), then each purchase priced again from what the server knows
   * now: the line's own price if the line is still there with that tick, else the price it had from
   * its line, else the newest known price then; and its usual price. The statistics are computed from
   * srv_spend and the prices when asked, so nothing else is cached.
   */
  async function recount() {
    const swept = sweep() ?? { added: 0, removed: 0 };
    const raw = db();
    const memo = new Map();
    let checked = 0;
    let repriced = 0;
    const rowsIn = raw.prepare('SELECT * FROM srv_spend ORDER BY checked_at DESC LIMIT ?').all(LIMITS.recountRows);
    // 0.9.5 (review): a chunk at a time, each its own savepoint, the server free to answer in between
    // (100,000 rows took 11 seconds in one go). An UPDATE, so a row deleted meanwhile stays deleted.
    const update = raw.prepare('UPDATE srv_spend SET chain = ?, section = ?, product_id = ?, text = ?, qty = ?, price = ?, total = ?, usual = ?, special = ?, src = ? WHERE entry_id = ? AND checked_at = ?');
    for (let i = 0; i < rowsIn.length; i += LIMITS.recountChunk) {
      if (i > 0) await new Promise((r) => setImmediate(r));
      if (db() !== raw) break; // the household went meanwhile (Delete everything)
      const lineOf = raw.prepare('SELECT id, text, item_id, chain, section, qty, price, product, checked_at, checked FROM list_entries WHERE id = ?');
      raw.exec('SAVEPOINT recount');
      try {
        for (const r of rowsIn.slice(i, i + LIMITS.recountChunk)) {
          checked++;
          const l = lineOf.get(r.entry_id);
          const at = Number(r.checked_at);
          let p;
          let qty = Number(r.qty);
          if (l && Number(l.checked) === 1 && Number(l.checked_at) === at) {
            p = priceFor(l, at, memo);
            qty = boughtOf(l, p, Math.max(1, Math.min(10000, Math.trunc(Number(l.qty) || 1))));
          } else if (r.src === 'line') {
            const usual = r.product_id ? usualOf(r.product_id, at, memo) : num(r.usual);
            p = { chain: r.chain, section: r.section, text: r.text, price: num(r.price), usual, special: usual !== null && Number(r.price) < usual - 0.005 ? 1 : 0, product_id: r.product_id, src: 'line' };
          } else {
            p = priceFor({ id: r.entry_id, text: r.text, item_id: r.item_id, chain: r.chain, section: r.section, qty, price: null, product: null }, at, memo);
          }
          const total = p.price === null ? null : round2(p.price * qty);
          if (p.price !== num(r.price) || p.usual !== num(r.usual) || p.chain !== r.chain || qty !== Number(r.qty) || p.special !== Number(r.special) || p.src !== r.src || total !== num(r.total)) {
            if (Number(update.run(p.chain, p.section, p.product_id, p.text, qty, p.price, total, p.usual, p.special, p.src, r.entry_id, at).changes)) repriced++;
          }
        }
        raw.exec('RELEASE recount');
      } catch (e) {
        raw.exec('ROLLBACK TO recount');
        raw.exec('RELEASE recount');
        throw e;
      }
    }
    return { ...swept, checked, repriced };
  }

  /**
   * 0.9.5 (review): Recount from the Data page: a passphrase session's, one at a time, and not again
   * within a minute of the last one (429 with retryAfter, in seconds).
   */
  let recounting = false;
  let recountedAt = -Infinity;
  async function recountOnce() {
    if (recounting) throw new HttpError(429, 'busy', 'A recount is already going. Try again in a minute.', { retryAfter: LIMITS.recountGapS });
    const wait = Math.ceil((recountedAt + LIMITS.recountGapS * 1000 - now()) / 1000);
    if (wait > 0) throw new HttpError(429, 'rate', `It was just recounted. Try again in ${wait} seconds.`, { retryAfter: wait });
    recounting = true;
    try {
      return await recount();
    } finally {
      recounting = false;
      recountedAt = now();
    }
  }

  // ---------- reads ----------

  /** A period: 1–120 months back from the start of this month (in the server's zone), or "all". */
  function periodOf(v) {
    const s = v === null || v === undefined || v === '' ? '12' : String(v);
    if (s === 'all') return { period: 'all', fromMs: 0, from: null };
    const n = Number(s);
    if (!Number.isInteger(n) || n < 1 || n > 120) throw new HttpError(400, 'period', 'Pick 1 to 120 months, or all.');
    const [y, m] = localMonth(now()).split('-').map(Number);
    const from = wallTime(ZONE, y, m - (n - 1), 1);
    return { period: n, fromMs: from, from: iso(from) };
  }

  function monthsBetween(fromMs, toMs) {
    const out = [];
    let [y, m] = localMonth(fromMs).split('-').map(Number);
    for (let i = 0; wallTime(ZONE, y, m, 1) <= toMs && i < 1300; i++) {
      out.push(`${y}-${pad(m)}`);
      if (++m > 12) {
        m = 1;
        y++;
      }
    }
    return out;
  }

  function spendingMonths(fromMs) {
    // 0.9.5 (final review): months in the server's zone, in JavaScript (SQLite's local time needs
    // the system's tzdata, and could disagree with the rest).
    const by = new Map();
    let first = Infinity;
    for (const r of db().prepare('SELECT checked_at, total, price FROM srv_spend WHERE checked_at >= ?').all(fromMs)) {
      const at = Number(r.checked_at);
      if (!Number.isFinite(at)) continue;
      first = Math.min(first, at);
      const k = localMonth(at);
      const b = by.get(k) ?? { n: 0, total: 0, unpriced: 0 };
      b.n++;
      b.total += Number(r.total ?? 0) || 0;
      if (r.price === null || r.price === undefined) b.unpriced++;
      by.set(k, b);
    }
    const start = fromMs || (Number.isFinite(first) ? first : now());
    return monthsBetween(start, now()).map((m) => {
      const r = by.get(m);
      return { month: m, total: r ? round2(Number(r.total)) : 0, count: r ? Number(r.n) : 0, unpriced: r ? Number(r.unpriced) : 0 };
    });
  }

  /** Where an item is cheapest now: the newest price of each of its products, the lowest. */
  function cheapestOf(itemId) {
    let best = null;
    for (const c of productsOf(itemId)) {
      const p = priceAt(c.id, now());
      if (p && (!best || Number(p.price) < best.price)) best = { chain: c.chain, price: round2(Number(p.price)), productId: c.id, date: p.date };
    }
    return best;
  }

  function top(periodV, offsetV, limitV) {
    const { fromMs } = periodOf(periodV);
    const limit = Math.min(LIMITS.topMax, Math.max(1, Math.trunc(Number(limitV)) || LIMITS.topDefault));
    const offset = Math.min(100000, Math.max(0, Math.trunc(Number(offsetV)) || 0));
    const raw = db();
    const keyExpr = "COALESCE(item_id, 'text:' || lower(trim(text)))";
    const total = Number(raw.prepare(`SELECT COUNT(DISTINCT ${keyExpr}) AS n FROM srv_spend WHERE checked_at >= ?`).get(fromMs).n);
    const rows = raw
      .prepare(
        `SELECT ${keyExpr} AS k, MAX(item_id) AS item_id, MAX(text) AS text, COUNT(*) AS times, SUM(qty) AS qty, COALESCE(SUM(total), 0) AS total, MAX(checked_at) AS last
         FROM srv_spend WHERE checked_at >= ? GROUP BY k ORDER BY times DESC, last DESC, k LIMIT ? OFFSET ?`,
      )
      .all(fromMs, limit, offset);
    const memo = new Map();
    const items = rows.map((r) => {
      const where = r.item_id ? 'item_id = ?' : "item_id IS NULL AND 'text:' || lower(trim(text)) = ?";
      const lp = raw.prepare(`SELECT price, chain, checked_at, product_id FROM srv_spend WHERE ${where} AND price IS NOT NULL ORDER BY checked_at DESC LIMIT 1`).get(r.item_id ?? r.k);
      const item = r.item_id ? raw.prepare('SELECT name FROM items WHERE id = ?').get(r.item_id) : null;
      const usualPid = r.item_id ? (productsOf(r.item_id).find((p) => p.role === 'main')?.id ?? lp?.product_id) : lp?.product_id;
      return {
        key: r.k,
        itemId: r.item_id ?? null,
        name: item?.name ?? r.text,
        times: Number(r.times),
        qty: Number(r.qty),
        total: round2(Number(r.total)),
        lastAt: iso(Number(r.last)),
        lastPaid: lp ? { price: Number(lp.price), chain: lp.chain, at: iso(Number(lp.checked_at)) } : null,
        usual: usualOf(usualPid, now(), memo),
        cheapest: r.item_id ? cheapestOf(r.item_id) : null,
      };
    });
    return { items, offset, limit, total };
  }

  function stats(periodV) {
    const p = periodOf(periodV);
    const raw = db();
    const sum = raw.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(total), 0) AS total, SUM(CASE WHEN price IS NULL THEN 1 ELSE 0 END) AS unpriced FROM srv_spend WHERE checked_at >= ?').get(p.fromMs);
    const shops = raw
      .prepare('SELECT chain, COUNT(*) AS n, COALESCE(SUM(total), 0) AS total, SUM(CASE WHEN price IS NULL THEN 1 ELSE 0 END) AS unpriced FROM srv_spend WHERE checked_at >= ? GROUP BY chain ORDER BY total DESC, n DESC')
      .all(p.fromMs)
      .map((r) => ({ chain: r.chain ?? null, total: round2(Number(r.total)), count: Number(r.n), unpriced: Number(r.unpriced) }));
    // 0.9.5 (review): by shopping list, General its own (its lines are the things that aren't food:
    // tape, batteries), each with the list's name; a line with no list is the groceries'.
    const bySection = new Map();
    for (const r of raw.prepare('SELECT section, COUNT(*) AS n, COALESCE(SUM(total), 0) AS total FROM srv_spend WHERE checked_at >= ? GROUP BY section').all(p.fromMs)) {
      const id = LIST_NAMES[r.section] ? r.section : 'pantry';
      const had = bySection.get(id) ?? { section: id, name: LIST_NAMES[id], total: 0, count: 0 };
      had.total = round2(had.total + Number(r.total));
      had.count += Number(r.n);
      bySection.set(id, had);
    }
    const sections = [...bySection.values()].sort((a, b) => b.total - a.total || b.count - a.count);
    const saved = raw
      .prepare('SELECT COUNT(*) AS n, COALESCE(SUM((usual - price) * qty), 0) AS s FROM srv_spend WHERE checked_at >= ? AND price IS NOT NULL AND usual IS NOT NULL AND usual > price')
      .get(p.fromMs);
    const prices = raw.prepare("SELECT COUNT(*) AS n, MIN(date) AS first, SUM(CASE WHEN source = 'imported' THEN 1 ELSE 0 END) AS imported FROM prices WHERE source <> 'demo'").get();
    const inPeriod = raw.prepare("SELECT COUNT(*) AS n, COUNT(DISTINCT product_id) AS products FROM prices WHERE source <> 'demo' AND date >= ?").get(p.fromMs ? iso(p.fromMs) : '');
    return {
      period: p.period,
      from: p.from,
      to: iso(),
      spending: { total: round2(Number(sum.total)), count: Number(sum.n), unpriced: Number(sum.unpriced ?? 0), months: spendingMonths(p.fromMs) },
      shops,
      sections,
      saved: { total: round2(Number(saved.s)), count: Number(saved.n) },
      itemsTracked: Number(raw.prepare("SELECT COUNT(*) AS n FROM items WHERE id NOT LIKE 'demo-%'").get().n),
      productsTracked: Number(inPeriod.products),
      prices: { count: Number(prices.n), first: prices.first ?? null, inPeriod: Number(inPeriod.n), imported: Number(prices.imported ?? 0) },
      top: top(periodV, 0, LIMITS.topDefault),
    };
  }

  /**
   * One item's price over time: per specials week (from Wednesday) and shop, the cheapest price of its
   * usual and same products (or, with none, the ones it would also take), and whether that was on
   * special; its usual price now, overall (its usual product) and per shop; and what was paid when.
   */
  function series(itemId, periodV) {
    const p = periodOf(periodV);
    const raw = db();
    const item = raw.prepare('SELECT id, name FROM items WHERE id = ?').get(itemId);
    if (!item) throw new HttpError(404, 'not-found', "That item isn't on the server.");
    const all = productsOf(itemId);
    const mains = all.filter((x) => x.role === 'main');
    const use = mains.length ? mains : all;
    const memo = new Map();
    const cells = new Map();
    const fromIso = p.fromMs ? iso(p.fromMs) : '';
    for (const c of use) {
      for (const r of raw.prepare("SELECT date, price, is_special, source FROM prices WHERE product_id = ? AND date >= ? AND source <> 'demo' ORDER BY date").all(c.id, fromIso)) {
        const k = weekOf(r.date, ZONE) + '|' + c.chain;
        const had = cells.get(k);
        // 0.9.6: `imported` when that week's price came from an import (the Data tab tags it).
        if (!had || Number(r.price) < had.price)
          cells.set(k, { week: weekOf(r.date, ZONE), chain: c.chain, price: round2(Number(r.price)), special: !!Number(r.is_special), ...(r.source === 'imported' ? { imported: true } : {}) });
      }
    }
    const weeks = [...cells.values()].sort((a, b) => a.week.localeCompare(b.week) || a.chain.localeCompare(b.chain)).slice(-LIMITS.seriesWeeks * 8);
    const chains = [];
    for (const chain of [...new Set(use.map((c) => c.chain))]) {
      const pid = use.find((c) => c.chain === chain).id;
      chains.push({ chain, productId: pid, usual: usualOf(pid, now(), memo) });
    }
    const paid = raw
      .prepare('SELECT checked_at, chain, price, qty FROM srv_spend WHERE item_id = ? AND checked_at >= ? AND price IS NOT NULL ORDER BY checked_at DESC LIMIT ?')
      .all(itemId, p.fromMs, LIMITS.paid)
      .map((r) => ({ at: iso(Number(r.checked_at)), chain: r.chain, price: Number(r.price), qty: Number(r.qty) }))
      .reverse();
    return { item: { id: item.id, name: item.name }, period: p.period, from: p.from, usual: usualOf(mains[0]?.id ?? use[0]?.id, now(), memo), chains, weeks, paid };
  }

  // ---------- storage ----------

  async function summary() {
    const raw = db();
    const pages = new Map();
    let measured = 'dbstat';
    try {
      for (const r of raw.prepare('SELECT name, SUM(pgsize) AS b FROM dbstat GROUP BY name').all()) pages.set(r.name, Number(r.b));
    } catch {
      measured = 'estimate';
    }
    const bytesOf = (names, estimate) => (measured === 'dbstat' ? names.reduce((s, n) => s + (pages.get(n) ?? 0), 0) : Math.round(Number(raw.prepare(estimate).get().b ?? 0)));
    const files = await R.walk();
    const archives = files.filter((f) => f.name.startsWith('archive/'));
    const photos = files.filter((f) => f.name.startsWith('photos/'));
    const sumOf = (l) => l.reduce((s, f) => s + f.size, 0);
    const pr = raw.prepare("SELECT COUNT(*) AS n, MIN(date) AS oldest, COUNT(DISTINCT product_id) AS products, SUM(CASE WHEN source = 'imported' THEN 1 ELSE 0 END) AS imported FROM prices WHERE source <> 'demo'").get();
    const rc = raw.prepare("SELECT COUNT(*) AS n, MIN(scanned_at) AS oldest, SUM(pinned) AS pinned FROM receipts WHERE id NOT LIKE 'demo-%'").get();
    const sp = raw.prepare('SELECT COUNT(*) AS n, MIN(checked_at) AS oldest FROM srv_spend').get();
    const lg = raw.prepare("SELECT COUNT(*) AS n, MIN(at) AS oldest, SUM(CASE WHEN kind = 'activity' THEN 1 ELSE 0 END) AS activity FROM srv_log").get();
    const trash = await R.trashInfo();
    const kinds = {
      prices: {
        count: Number(pr.n),
        products: Number(pr.products),
        imported: Number(pr.imported ?? 0),
        archives: archives.length,
        oldest: pr.oldest ?? null,
        bytes: bytesOf(['prices', 'prices_product_date'], "SELECT SUM(60 + length(product_id) + length(date) + COALESCE(length(promo), 0)) AS b FROM prices") + sumOf(archives),
      },
      receipts: {
        count: Number(rc.n),
        pinned: Number(rc.pinned ?? 0),
        photos: photos.length,
        oldest: rc.oldest ?? null,
        bytes: bytesOf(['receipts'], "SELECT SUM(80 + COALESCE(length(text), 0) + COALESCE(length(note), 0) + COALESCE(length(pages), 0)) AS b FROM receipts") + sumOf(photos),
      },
      stats: {
        count: Number(sp.n),
        oldest: sp.oldest === null ? null : iso(Number(sp.oldest)),
        bytes: bytesOf(['srv_spend', 'srv_spend_at', 'sqlite_autoindex_srv_spend_1'], 'SELECT SUM(90 + length(entry_id) + length(text) + COALESCE(length(chain), 0)) AS b FROM srv_spend'),
      },
      logs: {
        count: Number(lg.n),
        activity: Number(lg.activity ?? 0),
        oldest: lg.oldest ?? null,
        bytes: bytesOf(['srv_log', 'srv_log_at'], 'SELECT SUM(40 + length(at) + length(kind) + length(what) + COALESCE(length(device), 0) + COALESCE(length(detail), 0)) AS b FROM srv_log'),
      },
      // The server keeps no nightly copies of its own (the encrypted backup is a download); what it
      // does keep is the trash: archive/ and photos/ files deleted or replaced, for 30 days.
      backups: { count: trash.files, folders: trash.folders, oldest: trash.oldest, bytes: trash.bytes, nightly: false, keptDays: R.LIMITS.trashDays },
    };
    let dbBytes = 0;
    for (const f of ['household.db', 'household.db-wal']) dbBytes += (await fs.stat(join(R.DATA, f)).catch(() => null))?.size ?? 0;
    const total = dbBytes + sumOf(files) + trash.bytes;
    const counted = Object.values(kinds).reduce((s, k) => s + k.bytes, 0);
    let disk = null;
    try {
      const s = statfsSync(R.DATA);
      disk = { free: Number(s.bavail) * Number(s.bsize), size: Number(s.blocks) * Number(s.bsize) };
    } catch {
      disk = null;
    }
    return { kinds, total, other: Math.max(0, total - counted), database: dbBytes, files: sumOf(files), measured, disk, autoDelete: autoDelete(), resend: resendState(), at: iso() };
  }

  // ---------- the export (restock-export v1) ----------

  /** 0.9.6: prices whose product isn't Costco's (bind NEVER_SHOP). */
  const NOT_COSTCO = 'NOT EXISTS (SELECT 1 FROM products q WHERE q.id = prices.product_id AND q.chain = ?)';
  /** A list line at Costco without its price (and without the shop's unit price text). */
  function noCostcoLine(r) {
    const p = r.product && typeof r.product === 'object' ? r.product : null;
    if (r.chain !== NEVER_SHOP && p?.chain !== NEVER_SHOP) return r;
    const product = p ? Object.fromEntries(Object.entries(p).filter(([k]) => !/price|unit/i.test(k))) : p;
    return { ...r, price: null, product };
  }

  function capped(sql, args, out, name) {
    const rows = db().prepare(sql + ' LIMIT ?').all(...args, LIMITS.tableRows + 1).map((r) => ({ ...r }));
    if (rows.length > LIMITS.tableRows) {
      rows.length = LIMITS.tableRows;
      out.truncated.push(name);
    }
    return rows;
  }

  function exportAll() {
    const out = { truncated: [] };
    const raw = db();
    const items = capped("SELECT * FROM items WHERE id NOT LIKE 'demo-%' ORDER BY created_at, id", [], out, 'items').map((r) => ({
      ...r,
      same_product_ids: ids(r.same_product_ids),
      alt_product_ids: ids(r.alt_product_ids),
      not_at: jsonOr(r.not_at, r.not_at ?? null),
    }));
    // 0.9.6: never Costco's products or prices (Declan, 11 Nov 2026): left out, and counted in `withheld`.
    const products = capped("SELECT id, chain, name, brand, size, barcode, store_product_id, image_url, qty, qty_unit, created_at FROM products WHERE id NOT LIKE 'demo-%' AND chain <> ? ORDER BY id", [NEVER_SHOP], out, 'products');
    const categories = capped('SELECT * FROM categories ORDER BY section, ord, id', [], out, 'categories');
    const list = capped("SELECT * FROM list_entries WHERE id NOT LIKE 'demo-%' ORDER BY created_at, id", [], out, 'list').map((r) => noCostcoLine({ ...r, product: jsonOr(r.product, null) }));
    const receipts = capped("SELECT id, scanned_at, shop, chain, receipt_date, total, section, note, pinned, photo, pages FROM receipts WHERE id NOT LIKE 'demo-%' ORDER BY scanned_at, id", [], out, 'receipts').map((r) => {
      const pages = jsonOr(r.pages, null);
      const n = (r.photo ? 1 : 0) + (Array.isArray(pages) ? pages.length : pages && typeof pages === 'object' ? Object.keys(pages).length : 0);
      return { id: r.id, scanned_at: r.scanned_at, shop: r.shop, chain: r.chain, receipt_date: r.receipt_date, total: r.total, section: r.section, note: r.note, pinned: r.pinned, photos: n };
    });
    // Shops followed (household_settings shop:<id> = { on, shop? }) with the household's default branch.
    const shops = new Map();
    const settings = {};
    const aliases = [];
    for (const r of raw.prepare('SELECT k, v FROM household_settings ORDER BY k').all()) {
      const v = jsonOr(r.v, r.v);
      if (r.k.startsWith('shop:')) {
        const id = r.k.slice(5);
        const s = shops.get(id) ?? { id };
        s.on = !!(v && typeof v === 'object' && v.on);
        if (v && typeof v === 'object' && v.shop && typeof v.shop === 'object') {
          for (const f of ['name', 'website', 'section', 'tab']) if (typeof v.shop[f] === 'string') s[f] = v.shop[f];
          if (v.removed) s.removed = true;
        }
        shops.set(id, s);
      } else if (r.k.startsWith('branch:')) {
        const id = r.k.slice(7);
        const s = shops.get(id) ?? { id, on: null };
        if (v && typeof v === 'object') s.branch = { name: typeof v.name === 'string' ? v.name : null, ...(typeof v.storeNo === 'string' ? { storeNo: v.storeNo } : {}) };
        shops.set(id, s);
      } else if (r.k.startsWith('alias:')) {
        if (typeof v === 'string') aliases.push({ words: r.k.slice(6), item_id: v });
      } else if (r.k.startsWith('keep:') || r.k.startsWith('ha:')) {
        // The list's own rows (and which phone runs Home Assistant): not the household's data.
      } else settings[r.k] = v;
    }
    const counts = {
      prices: Number(raw.prepare(`SELECT COUNT(*) AS n FROM prices WHERE source <> 'demo' AND ${NOT_COSTCO}`).get(NEVER_SHOP).n),
      ticked: Number(raw.prepare('SELECT COUNT(*) AS n FROM srv_spend').get().n),
    };
    const costco = {
      products: Number(raw.prepare('SELECT COUNT(*) AS n FROM products WHERE chain = ?').get(NEVER_SHOP).n),
      prices: Number(raw.prepare("SELECT COUNT(*) AS n FROM prices p JOIN products q ON q.id = p.product_id WHERE q.chain = ? AND p.source <> 'demo'").get(NEVER_SHOP).n),
    };
    return {
      format: 'restock-export',
      v: 1,
      app: 'restock-server',
      version: R.VERSION,
      at: iso(),
      house: { name: S.house?.name ?? null },
      autoDelete: autoDelete(),
      tables: { items, products, categories, list, receipts, shops: [...shops.values()], settings, aliases, spending: spendingMonths(0) },
      paged: {
        prices: { count: counts.prices, path: '/api/v3/data/export/prices', limit: LIMITS.pageDefault },
        ticked: { count: counts.ticked, path: '/api/v3/data/export/ticked', limit: LIMITS.pageDefault },
      },
      truncated: out.truncated,
      ...(costco.products || costco.prices ? { withheld: { costco } } : {}),
    };
  }

  function exportPage(table, afterV, limitV) {
    const after = Math.max(0, Math.trunc(Number(afterV)) || 0);
    const limit = Math.min(LIMITS.pageRows, Math.max(1, Math.trunc(Number(limitV)) || LIMITS.pageDefault));
    let rows;
    if (table === 'prices') {
      rows = db()
        .prepare(`SELECT id, product_id, date, price, was_price, is_special, member_only, promo, source FROM prices WHERE id > ? AND source <> 'demo' AND ${NOT_COSTCO} ORDER BY id LIMIT ?`)
        .all(after, NEVER_SHOP, limit);
    } else {
      rows = db()
        .prepare('SELECT rowid AS id, entry_id, checked_at, at, chain, section, item_id, product_id, text, qty, price, total, usual, special, src FROM srv_spend WHERE rowid > ? ORDER BY rowid LIMIT ?')
        .all(after, limit)
        // 0.9.6: what was paid at Costco is a Costco price: the purchase stays, its prices don't.
        .map((r) => (r.chain === NEVER_SHOP ? { ...r, price: null, total: null, usual: null, special: 0 } : r));
    }
    rows = rows.map((r) => ({ ...r }));
    return { table, rows, next: rows.length === limit ? rows[rows.length - 1].id : null };
  }

  // ---------- manage ----------

  const autoDelete = () => {
    const m = R.house.keepMonths();
    return { months: m, cutoff: R.house.cutoff(now()) };
  };
  const resendState = () => {
    const at = S.house?.resendAt;
    return Number.isFinite(at) ? { at: iso(at), next: iso(at + DAY) } : { at: null, next: null };
  };

  /** The second step of a delete: the typed word and the passphrase again (in that order, the proof is used last). */
  function needDelete(c, b, word, what) {
    c.needWeb(c.actor, 'passphrase');
    if (!b || typeof b !== 'object' || !b.confirm || typeof b.confirm !== 'object') throw new HttpError(403, 'confirm', 'Type your passphrase again to do that.');
    if (b.typed !== word) throw new HttpError(400, 'typed', `Type ${word} to confirm.`);
    c.needConfirm(c.actor, b, c.ip, what);
  }

  /** Auto delete's new value, checked (null: off). Turning it on or shortening it deletes: both checks. */
  function autoDeleteGate(c, b, months) {
    if (months !== null && !autoDeleteOk(months)) throw new HttpError(400, 'months', 'Auto delete after 1 to 120 months, or off.');
    const was = R.house.keepMonths();
    const deletes = months !== null && (was === null || months < was);
    if (deletes) needDelete(c, b, WORD, 'auto-delete');
    return { was, deletes };
  }
  async function setAutoDelete(months, by, deletes) {
    const was = R.house.keepMonths();
    S.settings.keepMonths = months;
    R.house.refreshServerRow();
    await R.st.save();
    R.writeOwn();
    R.note('auto-delete-changed', { by, months, was });
    let deleted = null;
    if (deletes || months !== was) {
      const cut = R.house.cutoff(now());
      if (cut) deleted = await R.merger.pruneTo(cut);
    }
    return { ...autoDelete(), was, deleted };
  }

  async function deleteKinds(kinds, before, by) {
    const out = await R.merger.pruneTo(before ?? FOREVER, 'deleted', kinds);
    R.note('data-deleted', { by, kinds, before: before ?? null, prices: out.prices, receipts: out.receipts, photos: out.photos, archives: out.archives, stats: out.stats, logs: out.logs, backups: out.backups });
    return out;
  }

  /**
   * Delete everything on this server: the household goes (household.db, every file, the trash, the
   * household's keys and Home Assistant), every phone is unlinked as by Remove (it gets 401 removed,
   * forgets the household and keeps all its own things), and the server is new again (Set up this
   * server). The admin's sign-in and server settings stay, and so does the browser session that asked
   * (its copy is wiped by the page itself). 0.9.5 (review): every other browser session ends, whoever
   * signed it in: each one's copy of the household would otherwise go into the next one.
   */
  async function deleteEverything(by, keep = null) {
    const phones = Object.keys(S.devices);
    R.ha?.stop();
    importer.forget();
    R.closeDb();
    for (const name of R.listFileNames()) await R.trashFile(name, by, 'deleted everything');
    await R.emptyTrash(null);
    for (const f of ['household.db', 'household.db-wal', 'household.db-shm', 'activity.jsonl']) await fs.rm(join(R.DATA, f), { force: true });
    R.keys.clearHouse();
    R.web.endAllBut(keep);
    if (keep && S.sessions3[keep]) S.sessions3[keep].house = null;
    R.endV2Sessions?.();
    for (const d of phones) {
      R.web.endPhoneSessions(d);
      R.endV2PhoneSessions(d);
      R.forgetNonces(d);
    }
    S.removedDevices = [...new Set([...(S.removedDevices ?? []), ...phones])].slice(-LIMITS.removedKept);
    S.devices = Object.create(null);
    delete S.releasedBy;
    delete S.handoverFrom;
    S.house = null;
    S.mode = 'new';
    R.v3?.invites.clear();
    R.v3?.handovers.clear();
    await R.st.save();
    R.note('deleted-everything', { by, phones: phones.length });
    return { ok: true, mode: S.mode, phones: phones.length };
  }

  /** Ask phones to resend: a new `resend` in the signed server row, at most once a day. */
  async function resend(by) {
    const at = S.house?.resendAt;
    if (Number.isFinite(at) && now() - at < DAY) {
      const wait = Math.ceil((at + DAY - now()) / 1000);
      throw new HttpError(429, 'rate', 'Phones were asked less than a day ago. Try again tomorrow.', { retryAfter: wait, next: iso(at + DAY) });
    }
    S.house.resendAt = now();
    R.house.refreshServerRow();
    await R.st.save();
    R.writeOwn();
    R.note('phones-asked-to-resend', { by });
    return resendState();
  }

  // ---------- the endpoints (/api/v3/data/...) ----------

  /** c: { req, res, ip, url, path, method, actor, body, input, needWeb, needConfirm, sealedAnswer }. */
  async function api(c) {
    const { path, method, url, actor } = c;
    const q = (k) => url.searchParams.get(k);
    const answer = (obj) => c.sealedAnswer(actor, 200, obj, c.req, c.res);
    let m;
    if (path.startsWith('/api/v3/data/import/')) return importer.api(c);
    if (path === '/api/v3/data/summary' && method === 'GET') {
      c.needWeb(actor);
      return answer(await summary());
    }
    if (path === '/api/v3/data/stats' && method === 'GET') {
      c.needWeb(actor);
      return answer(stats(q('period')));
    }
    if (path === '/api/v3/data/top' && method === 'GET') {
      c.needWeb(actor);
      return answer(top(q('period'), q('offset'), q('limit')));
    }
    if (path === '/api/v3/data/series' && method === 'GET') {
      c.needWeb(actor);
      const item = String(q('item') ?? '');
      if (!item || item.length > 200) throw new HttpError(400, 'item', 'Which item?');
      return answer(series(item, q('period')));
    }
    if (path === '/api/v3/data/export' && method === 'GET') {
      c.needWeb(actor);
      R.note('data-exported', { by: actor.by });
      return answer(exportAll());
    }
    if ((m = /^\/api\/v3\/data\/export\/(prices|ticked)$/.exec(path)) && method === 'GET') {
      c.needWeb(actor);
      return answer(exportPage(m[1], q('after'), q('limit')));
    }
    if (path === '/api/v3/data/delete' && method === 'POST') {
      // 0.9.5: { dryRun: true } counts exactly what would go (Step 1), deleting nothing: any browser session.
      c.needWeb(actor);
      const b = c.input();
      const dryRun = b.dryRun === true;
      if (!dryRun) c.needWeb(actor, 'passphrase');
      const kinds = Array.isArray(b.kinds) ? [...new Set(b.kinds)] : null;
      if (!kinds || !kinds.length || kinds.length > KINDS.length || !kinds.every((k) => KINDS.includes(k))) throw new HttpError(400, 'kinds', `Pick what to delete: ${KINDS.join(', ')}.`);
      let before = null;
      if (b.before !== undefined && b.before !== null) {
        const t = typeof b.before === 'string' && b.before.length <= 40 ? Date.parse(b.before) : NaN;
        if (!Number.isFinite(t) || t > now()) throw new HttpError(400, 'before', 'Pick a date in the past.');
        before = new Date(t).toISOString();
      }
      if (dryRun) return answer({ counts: await R.merger.pruneTo(before ?? FOREVER, 'deleted', kinds, { dryRun: true }), kinds, before, dryRun: true });
      needDelete(c, b, WORD, 'delete-data');
      return answer({ deleted: await deleteKinds(kinds, before, actor.by), kinds, before });
    }
    if (path === '/api/v3/data/delete-everything' && method === 'POST') {
      c.needWeb(actor, 'passphrase');
      needDelete(c, c.input(), WORD_ALL, 'delete-everything');
      return answer(await deleteEverything(actor.by, actor.hash));
    }
    if (path === '/api/v3/data/autodelete') {
      if (method === 'GET') {
        c.needWeb(actor);
        return answer(autoDelete());
      }
      if (method === 'PUT') {
        c.needWeb(actor, 'passphrase');
        const b = c.input();
        if (b.months === undefined) throw new HttpError(400, 'months', 'Auto delete after 1 to 120 months, or off.');
        const g = autoDeleteGate(c, b, b.months);
        return answer(await setAutoDelete(b.months, actor.by, g.deletes));
      }
    }
    if (path === '/api/v3/data/resend' && method === 'POST') {
      // 0.9.5 (review): the passphrase's: every phone sends its whole file again.
      c.needWeb(actor, 'passphrase');
      return answer(await resend(actor.by));
    }
    if (path === '/api/v3/data/recount' && method === 'POST') {
      // 0.9.5 (review): the passphrase's (it's heavy), once a minute.
      c.needWeb(actor, 'passphrase');
      const out = await recountOnce();
      R.note('recounted', { by: actor.by, ...out });
      return answer(out);
    }
    throw new HttpError(404, 'not-found', 'Not found.');
  }

  return { api, sweep, recount, stats, top, series, summary, exportAll, exportPage, deleteKinds, deleteEverything, resend, autoDeleteGate, setAutoDelete, priceFor, usualOf, importer, importing: () => importer.current() };
}

export { AUTO_KINDS };
