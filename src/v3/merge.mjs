// 0.9.4 (protocol v3): household.db (node:sqlite, Restock's own schema through the core's migrate),
// the merge queue (every accepted sync or archive file is taken in with the core's engine, as the
// server's role), the server's own file restock-sync-srv-<sid>.bin, the log (srv_log), the phones'
// shared specials, and "Keep data for" (an input filter in the engine, and a quiet daily prune here).
// docs/server-v3-design.md sections 3, 5 and 8.

import { readFileSync, lstatSync, readdirSync, rmSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { parseNameV3 } from '../names.mjs';
import { hourIn, serverZone } from '../zone.mjs';

const DAY = 24 * 3600 * 1000;
const sha256hex = (b) => createHash('sha256').update(b).digest('hex');
const SPECIALS_DAYS = 14;
const LIMITS = { specialsLists: 60, specialsItems: 1000, specialsBytes: 512 * 1024, logDetail: 2000 };

/** node:sqlite, or null on a Node without it (the start-up check says so first). */
export function sqliteModule() {
  return process.getBuiltinModule?.('node:sqlite') ?? null;
}

const SERVER_TABLES = [
  'CREATE TABLE IF NOT EXISTS srv_log (at TEXT NOT NULL, kind TEXT NOT NULL, what TEXT NOT NULL, device TEXT, detail TEXT)',
  'CREATE INDEX IF NOT EXISTS srv_log_at ON srv_log(at)',
  // Receipt photo paths (as phones name them), the photos/<sha256>.bin they were offloaded to, and
  // the phone whose file said so (only that phone may change it).
  'CREATE TABLE IF NOT EXISTS srv_photos (path TEXT PRIMARY KEY, sha TEXT NOT NULL, device TEXT)',
  // What phones shared of the specials and catalogues they fetched (never fetched by the server).
  'CREATE TABLE IF NOT EXISTS srv_specials (chain TEXT PRIMARY KEY, at TEXT NOT NULL, device TEXT, list TEXT NOT NULL)',
  'CREATE TABLE IF NOT EXISTS srv_catalogues (chain TEXT PRIMARY KEY, at TEXT NOT NULL, url TEXT NOT NULL, note TEXT)',
  // 0.9.5: what was bought, from list lines ticked off (data.mjs sweep): one row a tick, keyed by the
  // line and its checked_at (ms). `price` is per pack, `total` = price × qty; `usual` the usual price
  // then; `src` where the price came from: "line" (the line's own), "price" (the newest known), "none".
  `CREATE TABLE IF NOT EXISTS srv_spend (
    entry_id TEXT NOT NULL, checked_at INTEGER NOT NULL, at TEXT NOT NULL,
    chain TEXT, section TEXT, item_id TEXT, product_id TEXT, text TEXT NOT NULL,
    qty INTEGER NOT NULL DEFAULT 1, price REAL, total REAL, usual REAL, special INTEGER NOT NULL DEFAULT 0, src TEXT NOT NULL,
    PRIMARY KEY (entry_id, checked_at))`,
  'CREATE INDEX IF NOT EXISTS srv_spend_at ON srv_spend(checked_at)',
];
/** What Auto delete (0.9.4's Keep data for) covers: data.mjs kinds. */
export const AUTO_KINDS = ['prices', 'receipts', 'stats', 'logs'];
/** "Everything", for a delete with no date: after any date data can have. */
export const FOREVER = '9999-12-31T23:59:59.999Z';

export function makeMerger(R) {
  const { core, S, keys, now } = R;
  const K = keys.data;
  let raw = null;
  const iso = (t = now()) => new Date(t).toISOString();

  // ---------- the database ----------

  async function openDb({ fresh = false, name, ownerPub } = {}) {
    closeDb();
    const path = join(R.DATA, 'household.db');
    if (fresh) for (const f of ['', '-wal', '-shm']) rmSync(path + f, { force: true });
    const { DatabaseSync } = sqliteModule();
    raw = new DatabaseSync(path);
    raw.exec('PRAGMA journal_mode=WAL');
    raw.exec('PRAGMA busy_timeout=5000');
    // household.db isn't sealed: only the server's own user may read it (keys.json is 0600 too).
    for (const f of ['', '-wal', '-shm']) {
      try {
        chmodSync(path + f, 0o600);
      } catch {
        /* not there (yet) */
      }
    }
    await core.migrate(raw);
    for (const sql of SERVER_TABLES) raw.exec(sql);
    // A household.db from before srv_photos noted the phone (its rows stay as they are: nobody's).
    if (!raw.prepare('PRAGMA table_info(srv_photos)').all().some((c) => c.name === 'device')) raw.exec('ALTER TABLE srv_photos ADD COLUMN device TEXT');
    const e = new core.WebSyncEngine(core.syncDbOfNode(raw), core.verifySig, core.signedText, now, {
      role: 'server',
      sign: (text) => core.signWithPkcs8(K.owner.priv, text),
      keepFrom: () => R.house.cutoff(now()),
    });
    R.engine = e;
    e.setMeta('device', 'srv-' + S.sid);
    e.setMeta('name', name ?? S.house?.name ?? 'Restock server');
    e.setMeta('owner_pin', ownerPub ?? K.owner.pub);
    // The server's settings, so household settings rows for shops people added say which tab they're on.
    raw.exec("INSERT OR IGNORE INTO kv (key, value) VALUES ('settings', '{}')");
    // 0.9.5: once, after an update: every phone's file is read again, for the General list lines a
    // 0.9.4 server passed over (the next merge, at start, takes them in).
    e.catchUpLists?.();
    return e;
  }
  function closeDb() {
    if (raw) {
      try {
        raw.close();
      } catch {
        /* already closed */
      }
    }
    raw = null;
    R.engine = null;
  }

  // ---------- the log (srv_log): activity and logs, never contents or secrets ----------

  function logLine(kind, what, device, detail) {
    if (!raw) return false;
    let d = detail === undefined || detail === null ? null : typeof detail === 'string' ? detail : JSON.stringify(detail);
    if (d && d.length > LIMITS.logDetail) d = d.slice(0, LIMITS.logDetail);
    try {
      raw.prepare('INSERT INTO srv_log (at, kind, what, device, detail) VALUES (?, ?, ?, ?, ?)').run(iso(), kind, String(what), device ?? null, d);
      return true;
    } catch {
      return false;
    }
  }
  function readLog(kind, limit, before) {
    if (!raw) return [];
    const rows = before
      ? raw.prepare('SELECT rowid AS id, at, kind, what, device, detail FROM srv_log WHERE kind = ? AND at < ? ORDER BY at DESC, rowid DESC LIMIT ?').all(kind, before, limit)
      : raw.prepare('SELECT rowid AS id, at, kind, what, device, detail FROM srv_log WHERE kind = ? ORDER BY at DESC, rowid DESC LIMIT ?').all(kind, limit);
    return rows.map((r) => {
      let detail = r.detail;
      try {
        detail = r.detail === null ? null : JSON.parse(r.detail);
      } catch {
        /* plain words */
      }
      return { at: r.at, kind: r.kind, what: r.what, device: r.device, detail };
    });
  }
  /** 0.9.3's activity.jsonl, moved into srv_log at the handover. */
  function moveActivity() {
    const file = join(R.DATA, 'activity.jsonl');
    let lines = [];
    try {
      lines = readFileSync(file, 'utf8').trim().split('\n').filter(Boolean);
    } catch {
      return;
    }
    const ins = raw.prepare('INSERT INTO srv_log (at, kind, what, device, detail) VALUES (?, ?, ?, ?, ?)');
    raw.exec('BEGIN');
    try {
      for (const l of lines) {
        try {
          const a = JSON.parse(l);
          const { at, what, by, ...rest } = a;
          ins.run(String(at), 'activity', String(what), by ?? null, Object.keys(rest).length ? JSON.stringify(rest) : null);
        } catch {
          /* a damaged line */
        }
      }
      raw.exec('COMMIT');
    } catch (e) {
      raw.exec('ROLLBACK');
      throw e;
    }
    rmSync(file, { force: true });
  }

  // ---------- taking files in ----------

  const pending = new Set();
  let timer = null;
  let haSoon = false;
  /** Queues a file for merging (1 second debounce, one merge at a time: they run synchronously). */
  function queue(name) {
    pending.add(name);
    if (!timer) {
      timer = setTimeout(run, R.cfg.mergeDelayMs ?? 1000);
      timer.unref?.();
    }
  }
  function run() {
    if (timer) clearTimeout(timer);
    timer = null;
    if (!R.engine || S.mode !== 'v3') {
      pending.clear();
      return;
    }
    const names = [...pending];
    pending.clear();
    for (const n of names) mergeOne(n);
    afterMerges();
  }
  /** For tests and the handover: everything queued, merged now. */
  function settle() {
    if (pending.size) run();
  }

  /** Branch rows the web writes (branch:<chain> = { name, storeNo? }): only exactly that shape. */
  function branchRowOk(x) {
    if (!x || x.tbl !== 'household_settings' || typeof x.pk !== 'string' || !x.pk.startsWith('branch:')) return true;
    if (!/^branch:[a-z0-9][a-z0-9_-]{0,63}$/.test(x.pk)) return false;
    if (x.deleted === true || x.deleted === 'true') return true;
    let v;
    try {
      v = JSON.parse(String(x.row?.v));
    } catch {
      return false;
    }
    if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
    const keysOk = Object.keys(v).every((k) => k === 'name' || k === 'storeNo');
    return keysOk && typeof v.name === 'string' && v.name.length >= 1 && v.name.length <= 80 && (v.storeNo === undefined || (typeof v.storeNo === 'string' && /^[A-Za-z0-9 _-]{1,16}$/.test(v.storeNo)));
  }

  function openFile(bytes) {
    return core.openWithAny(K.serverKeys, bytes);
  }

  /**
   * A phone's file lists its offloaded receipt photos (path → sha256). Each path is that phone's
   * once it lists it: another phone's file can't point it at another photo (0.9.4 review), and a
   * photo that isn't on the server isn't noted.
   */
  function notePhotos(map, device) {
    if (!map || typeof map !== 'object' || Array.isArray(map) || !device) return;
    const ins = raw.prepare('INSERT INTO srv_photos (path, sha, device) VALUES (?, ?, ?) ON CONFLICT(path) DO UPDATE SET sha = excluded.sha WHERE srv_photos.device = excluded.device');
    let n = 0;
    for (const [p, sha] of Object.entries(map)) {
      if (n++ > 20000) break;
      if (typeof p === 'string' && p.length <= 400 && typeof sha === 'string' && /^[0-9a-f]{64}$/.test(sha) && R.hasFile(`photos/${sha}.bin`)) ins.run(p, sha, device);
    }
  }

  /**
   * 0.9.5 (review): a browser's file whose session is gone (signed out, run out, or of a household
   * that isn't this one): never read again, and moved to the trash. Its changes came in while it was
   * signed in; read again later (after a catch-up, a restart) it could only bring back what was
   * deleted since. The 0.9.3 web's own file (its account's webId) stays, as the handover reads it.
   */
  function staleWeb(parsed) {
    if (parsed?.kind !== 'sync' || !parsed.owner.startsWith('web-')) return false;
    const webId = parsed.owner.slice(4);
    if (S.account?.webId && webId === S.account.webId) return false;
    const sess = R.web?.byWebId(webId);
    return !sess || !R.web.ofThisHouse(sess);
  }
  const trashing = new Set();
  function dropStaleWeb(name) {
    if (trashing.has(name)) return;
    trashing.add(name);
    void R.trashFile(name, 'srv-' + S.sid, 'browser signed out')
      .then((moved) => moved && logLine('log', 'web-file-dropped', parsed(name), { file: name }))
      .catch(() => undefined)
      .finally(() => trashing.delete(name));
  }
  const parsed = (name) => parseNameV3(name)?.owner ?? null;
  /** 0.9.5 (review): every browser file whose session is gone, to the trash (the nightly round, a start). */
  function dropStaleWebFiles() {
    let n = 0;
    for (const name of R.listFileNames()) {
      if (staleWeb(parseNameV3(name))) {
        dropStaleWeb(name);
        n++;
      }
    }
    return n;
  }

  function mergeOne(name) {
    const parsed = parseNameV3(name);
    if (!parsed || (parsed.kind !== 'sync' && parsed.kind !== 'archive')) return;
    if (parsed.kind === 'sync' && parsed.owner === 'srv-' + S.sid) return;
    if (staleWeb(parsed)) {
      dropStaleWeb(name);
      return;
    }
    const file = join(R.FILES, ...name.split('/'));
    let bytes;
    try {
      const l = lstatSync(file);
      if (!l.isFile()) return;
      bytes = readFileSync(file);
    } catch {
      return;
    }
    const e = R.engine;
    const sum = sha256hex(bytes);
    if (e.seenSum(name) === sum) return;
    let opened;
    try {
      opened = openFile(bytes);
    } catch {
      e.setMeta('folder_seen:' + name, sum);
      logLine('log', 'merge-unreadable', parsed.owner, { file: name });
      return;
    }
    const msg = opened.msg;
    // 0.9.5 (review): read again unchanged by the one-time catch-up (engine catchUpLists): only the
    // General lines never had here (takeFile), nothing else of it; an archive not at all.
    const catchingUp = e.catchingUp?.(name, sum) ?? false;
    try {
      if (parsed.kind === 'archive' && catchingUp) {
        e.setMeta('catchup:folder_seen:' + name, null);
        e.setMeta('folder_seen:' + name, sum);
        return;
      }
      if (parsed.kind === 'sync') {
        if (msg && Array.isArray(msg.entries)) msg.entries = msg.entries.filter(branchRowOk);
        const device = parsed.owner;
        const phone = !device.startsWith('web-') && e.householdValue('removed:' + device) === null;
        if (phone && !catchingUp) {
          notePhotos(msg.photos, device);
          takeSpecials(device, msg);
        }
        const lists = Array.isArray(msg.entries) && msg.entries.some((x) => x && (x.tbl === 'list_entries' || x.tbl === 'items' || x.tbl === 'household_settings'));
        const n = e.takeFile(name, sum, msg, iso());
        if (n > 0 && lists) haSoon = true;
        logLine('log', 'merged', device, { file: name, changes: Math.max(0, n), dropped: n < 0 ? 0 : e.lastDropped, passed: n < 0 });
        if (n > 0) R.note('changes-in', { by: device, changes: n });
      } else {
        if (e.householdValue('removed:' + parsed.owner) === null) notePhotos(msg.photos, parsed.owner);
        floorArchive(msg);
        const n = e.takeArchive(msg);
        e.setMeta('folder_seen:' + name, sum);
        logLine('log', 'merged', parsed.owner, { file: name, added: n });
      }
    } catch (err) {
      logLine('log', 'merge-failed', parsed.owner, { file: name, error: String(err?.message ?? err).slice(0, 200) });
    }
  }

  /** Every sync file and archive on the server (start, handover, bring), `first` before the rest. */
  function mergeEverything({ first } = {}) {
    const names = R.listFileNames().filter((n) => {
      const p = parseNameV3(n);
      return p && (p.kind === 'sync' || p.kind === 'archive');
    });
    names.sort((a, b) => (a === first ? -1 : b === first ? 1 : (a.startsWith('archive/') ? 1 : 0) - (b.startsWith('archive/') ? 1 : 0) || a.localeCompare(b)));
    for (const n of names) mergeOne(n);
    afterMerges();
  }

  function afterMerges() {
    const e = R.engine;
    if (!e) return;
    // Someone took the household back with the recovery key (a validly signed owner other than us).
    const owner = e.householdValue('owner');
    if (owner && owner !== 'srv-' + S.sid && S.mode === 'v3') {
      S.mode = 'released';
      S.releasedBy = owner;
      R.st.saveSoon();
      R.note('household-taken-back', { by: owner });
      return;
    }
    if (R.house.widen()) return; // it merged everything again (and so wrote the server's file)
    writeOwn();
    if (haSoon) {
      haSoon = false;
      R.ha?.soon();
    }
  }

  // ---------- the server's own file ----------

  function specialsOut() {
    const from = iso(now() - SPECIALS_DAYS * DAY);
    const lists = raw
      .prepare('SELECT list FROM srv_specials WHERE at >= ? ORDER BY chain')
      .all(from)
      .map((r) => JSON.parse(r.list));
    const catalogues = {};
    for (const r of raw.prepare('SELECT chain, url, note FROM srv_catalogues ORDER BY chain').all()) catalogues[r.chain] = r.note ? { url: r.url, note: r.note } : { url: r.url };
    const at = lists.reduce((m, l) => (l.at > m ? l.at : m), '');
    return { specials: lists.length ? { at, lists } : null, catalogues: Object.keys(catalogues).length ? catalogues : null };
  }

  /** Writes restock-sync-srv-<sid>.bin when something in it changed. */
  function writeOwn() {
    const e = R.engine;
    if (!e || !K.keyv || S.mode !== 'v3') return false;
    // 0.9.5: whatever just changed the list (a merge, Home Assistant, the web), the ticks are noted first.
    try {
      R.data?.sweep();
    } catch (err) {
      logLine('log', 'spend-failed', null, { error: String(err?.message ?? err).slice(0, 200) });
    }
    const name = core.serverFileName(S.sid);
    const extra = specialsOut();
    const extraMark = sha256hex(JSON.stringify(extra)).slice(0, 16);
    const present = R.hasFile(name) && e.meta('own_extra') === extraMark;
    const own = e.ownFile(Number(K.keyv), iso(), present);
    if (!own) return false;
    if (extra.specials) own.msg.specials = extra.specials;
    if (extra.catalogues) own.msg.catalogues = extra.catalogues;
    const sealed = core.sealRsf1(Buffer.from(K.serverKeys[String(K.keyv)], 'base64url'), own.msg);
    R.writeServerFile(name, sealed);
    e.wroteOwn(own.mark);
    e.setMeta('own_extra', extraMark);
    return true;
  }

  // ---------- specials and catalogues phones shared (P3's device-file section) ----------

  const str = (v, max) => (typeof v === 'string' && v.length <= max ? v : undefined);
  const numOrNull = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const httpUrl = (v) => (typeof v === 'string' && v.length <= 500 && /^https?:\/\/[^\s]+$/i.test(v) ? v : undefined);
  const timeOk = (v) => typeof v === 'string' && v.length <= 40 && Number.isFinite(Date.parse(v)) && Date.parse(v) <= now() + DAY;
  const CHAIN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

  function chainShared(shares, chain) {
    if (!shares) return true;
    const tab = R.engine.chainTab(chain) ?? 'pantry';
    return shares.tabs.includes(tab);
  }

  function takeSpecials(device, msg) {
    // What this file says it shares (a file without `shares`, a 0.9.3 phone's: what it sends).
    const shares = core.parseShares(msg.shares);
    const sp = msg.specials;
    if (sp && typeof sp === 'object' && Array.isArray(sp.lists)) {
      const up = raw.prepare('INSERT INTO srv_specials (chain, at, device, list) VALUES (?, ?, ?, ?) ON CONFLICT(chain) DO UPDATE SET at = excluded.at, device = excluded.device, list = excluded.list WHERE excluded.at > srv_specials.at');
      for (const l of sp.lists.slice(0, LIMITS.specialsLists)) {
        if (!l || typeof l !== 'object' || !CHAIN.test(String(l.chain ?? '')) || !timeOk(l.at) || !Array.isArray(l.items)) continue;
        if (!chainShared(shares, l.chain)) continue;
        const items = [];
        for (const it of l.items.slice(0, LIMITS.specialsItems)) {
          if (!it || typeof it !== 'object') continue;
          const name = str(it.name, 200);
          const id = str(it.storeProductId, 64);
          if (!name || !id) continue;
          const o = { storeProductId: id, name, price: numOrNull(it.price), wasPrice: numOrNull(it.wasPrice), promo: str(it.promo, 200) ?? null, imageUrl: httpUrl(it.imageUrl) ?? null, isSpecial: it.isSpecial === true };
          items.push(o);
        }
        const list = JSON.stringify({ chain: l.chain, at: l.at, items });
        if (list.length > LIMITS.specialsBytes) continue;
        up.run(l.chain, l.at, device, list);
      }
    }
    const cats = msg.catalogues;
    if (cats && typeof cats === 'object' && !Array.isArray(cats)) {
      const at = timeOk(msg.at) ? msg.at : iso();
      const up = raw.prepare('INSERT INTO srv_catalogues (chain, at, url, note) VALUES (?, ?, ?, ?) ON CONFLICT(chain) DO UPDATE SET at = excluded.at, url = excluded.url, note = excluded.note WHERE excluded.at > srv_catalogues.at');
      for (const [chain, c] of Object.entries(cats).slice(0, LIMITS.specialsLists)) {
        if (!CHAIN.test(chain) || !c || typeof c !== 'object') continue;
        const url = httpUrl(c.url);
        if (!url || !chainShared(shares, chain)) continue;
        up.run(chain, at, url, str(c.note, 300) ?? null);
      }
    }
  }

  // ---------- Keep data for (D14) ----------

  /** Archive months wholly before `cutoff` (ISO): yyyy-mm whose next month starts at or before it. */
  function monthBefore(month, cutoff) {
    const [y, m] = month.split('-').map(Number);
    return new Date(Date.UTC(y, m, 1)).toISOString() <= cutoff;
  }

  /** The receipts' photos (photos/<sha>.bin) no receipt uses any more, to the trash. */
  /** The photo paths a receipt row names (its photo, and its pages). */
  function photoPaths(r) {
    const paths = [];
    if (r.photo) paths.push(r.photo);
    if (r.pages) {
      try {
        const p = JSON.parse(r.pages);
        const list = Array.isArray(p) ? p : p && typeof p === 'object' ? Object.values(p) : [];
        for (const x of list) if (typeof x === 'string') paths.push(x);
      } catch {
        for (const x of String(r.pages).split(',')) if (x.trim()) paths.push(x.trim());
      }
    }
    return paths;
  }
  async function dropPhotos(receipts, why) {
    let photos = 0;
    for (const r of receipts) {
      for (const p of photoPaths(r)) {
        const row = raw.prepare('SELECT sha FROM srv_photos WHERE path = ?').get(p);
        if (!row) continue;
        const still = raw.prepare("SELECT 1 FROM receipts WHERE photo = ? OR instr(COALESCE(pages, ''), ?) > 0 LIMIT 1").get(p, p);
        if (still) continue;
        const other = raw.prepare('SELECT 1 FROM srv_photos WHERE sha = ? AND path <> ? LIMIT 1').get(row.sha, p);
        raw.prepare('DELETE FROM srv_photos WHERE path = ?').run(p);
        if (other) continue;
        if (await R.trashFile(`photos/${row.sha}.bin`, 'srv-' + S.sid, why)) photos++;
      }
    }
    return photos;
  }

  /**
   * Prices and receipts dated before `cutoff`, quietly (applying = 1: no deletes go out), by the
   * engine's own rule (prune): never each product's newest price, never a pinned receipt. Unlike the
   * engine's (Auto delete, whose input filter keeps them out), a receipt's sync_log row stays, so a
   * phone's unchanged copy doesn't bring a deleted receipt back.
   */
  function dropRows(cutoff, { prices, receipts }) {
    const out = { prices: 0, receipts: [] };
    raw.exec('BEGIN');
    try {
      raw.exec("INSERT OR REPLACE INTO sync_meta (key, value) VALUES ('applying', '1')");
      if (prices) {
        const where = `date < ? AND source <> 'demo' AND date < (SELECT MAX(q.date) FROM prices q WHERE q.product_id = prices.product_id)`;
        out.prices = Number(raw.prepare(`SELECT COUNT(*) AS n FROM prices WHERE ${where}`).get(cutoff).n);
        if (out.prices) raw.prepare(`DELETE FROM prices WHERE ${where}`).run(cutoff);
      }
      if (receipts) {
        out.receipts = raw.prepare("SELECT id, photo, pages FROM receipts WHERE scanned_at < ? AND pinned = 0 AND id NOT LIKE 'demo-%'").all(cutoff).map((r) => ({ ...r }));
        const del = raw.prepare('DELETE FROM receipts WHERE id = ?');
        for (const r of out.receipts) del.run(r.id);
      }
      raw.exec("DELETE FROM sync_meta WHERE key = 'applying'");
      raw.exec('COMMIT');
    } catch (e) {
      raw.exec('ROLLBACK');
      throw e;
    }
    return out;
  }

  // ---------- 0.9.5 (review): the archive/ months and what Delete took off the server ----------

  /** An archive month's file, opened (null: it can't be). */
  function readArchive(name) {
    try {
      const bytes = readFileSync(join(R.FILES, ...name.split('/')));
      const m = openFile(bytes).msg;
      return m && typeof m === 'object' ? m : null;
    } catch {
      return null;
    }
  }
  /**
   * The archive months a delete moves to the trash: wholly before `cutoff`, and only when everything
   * in one goes: its prices only when prices are deleted, its receipts only when receipts are, and
   * never one holding a pinned receipt (pinned there, or here). One that can't be opened goes only
   * when both are deleted (as on 0.9.4). The rest stay as they are; what of them was deleted stays
   * out of the household (floorArchive), so reading one again brings nothing back.
   */
  function archivesFor(cutoff, k) {
    const out = [];
    if (!k.has('prices') && !k.has('receipts')) return out;
    const pinned = raw.prepare('SELECT 1 FROM receipts WHERE id = ? AND pinned = 1');
    for (const n of R.listFileNames()) {
      const p = parseNameV3(n);
      if (p?.kind !== 'archive' || !monthBefore(n.slice(-11, -4), cutoff)) continue;
      const m = readArchive(n);
      if (!m) {
        if (k.has('prices') && k.has('receipts')) out.push(n);
        continue;
      }
      const prices = Array.isArray(m.prices) && m.prices.length > 0;
      const receipts = Array.isArray(m.receipts) ? m.receipts.filter((r) => r && typeof r === 'object') : [];
      if (prices && !k.has('prices')) continue;
      if (receipts.length && !k.has('receipts')) continue;
      if (receipts.some((r) => Number(r.pinned) === 1 || (typeof r.id === 'string' && pinned.get(r.id)))) continue;
      out.push(n);
    }
    return out;
  }
  /** Notes how far back prices or receipts were deleted (sync_meta prices_floor, receipts_floor). */
  function raiseFloor(key, cutoff) {
    const floor = cutoff === FOREVER ? iso() : cutoff;
    const was = R.engine.meta(key);
    if (!was || floor > was) R.engine.setMeta(key, floor);
  }
  /**
   * An archive month taken in: nothing from before what Delete took off the server comes back
   * (prices dated before prices_floor where the product has a price that new or newer here, as Auto
   * delete's own rule; receipts scanned before receipts_floor, unless pinned).
   */
  function floorArchive(msg) {
    const e = R.engine;
    const pf = e.meta('prices_floor');
    const rf = e.meta('receipts_floor');
    if (pf && Array.isArray(msg.prices)) {
      const has = raw.prepare('SELECT 1 FROM prices WHERE product_id = ? AND date >= ? LIMIT 1');
      msg.prices = msg.prices.filter((p) => !(p && typeof p.date === 'string' && p.date < pf && typeof p.product_id === 'string' && has.get(p.product_id, p.date)));
    }
    if (rf && Array.isArray(msg.receipts)) msg.receipts = msg.receipts.filter((r) => !(r && typeof r.scanned_at === 'string' && r.scanned_at < rf && Number(r.pinned) !== 1));
  }

  /** The receipts' photo files dropPhotos would move to the trash (for a dry run), without changing anything. */
  function photosFor(receipts) {
    const going = new Set(receipts.map((r) => r.id));
    const paths = new Set();
    for (const r of receipts) for (const p of photoPaths(r)) paths.add(p);
    const freed = new Set();
    for (const p of paths) {
      const still = raw.prepare("SELECT id FROM receipts WHERE photo = ? OR instr(COALESCE(pages, ''), ?) > 0").all(p, p).some((x) => !going.has(x.id));
      if (!still && raw.prepare('SELECT 1 FROM srv_photos WHERE path = ?').get(p)) freed.add(p);
    }
    const shas = new Set();
    for (const p of freed) {
      const sha = raw.prepare('SELECT sha FROM srv_photos WHERE path = ?').get(p).sha;
      const all = raw.prepare('SELECT path FROM srv_photos WHERE sha = ?').all(sha).map((x) => x.path);
      if (all.every((x) => freed.has(x)) && R.hasFile(`photos/${sha}.bin`)) shas.add(sha);
    }
    return shas.size;
  }

  /**
   * Drops what's older than `cutoff` quietly (no deletes go out). `kinds` (data.mjs): prices (and the
   * archive/ months that hold only what goes), receipts (and their photos, and those archive/
   * months), stats (srv_spend), logs (srv_log), backups (the trash). Auto delete ("keep-data-for")
   * is AUTO_KINDS and runs the engine's prune, as 0.9.4 did. Never the shopping list, the pantry,
   * categories, each product's newest price, or a pinned receipt.
   * 0.9.5: `dryRun` counts exactly what would go, and changes nothing.
   */
  async function pruneTo(cutoff, why = 'keep-data-for', kinds = AUTO_KINDS, { dryRun = false } = {}) {
    const e = R.engine;
    if (!e || !cutoff) return null;
    const k = new Set(kinds);
    if (dryRun) return countTo(cutoff, k);
    const gone =
      why === 'keep-data-for' && k.has('prices') && k.has('receipts') ? e.prune(cutoff) : dropRows(cutoff, { prices: k.has('prices'), receipts: k.has('receipts') });
    const photos = await dropPhotos(gone.receipts, why);
    if (k.has('prices')) raiseFloor('prices_floor', cutoff);
    if (k.has('receipts')) raiseFloor('receipts_floor', cutoff);
    let archives = 0;
    for (const n of archivesFor(cutoff, k)) if (await R.trashFile(n, 'srv-' + S.sid, why)) archives++;
    let logs = 0;
    if (k.has('logs')) {
      logs = Number(raw.prepare('SELECT COUNT(*) AS n FROM srv_log WHERE at < ?').get(cutoff).n);
      raw.prepare('DELETE FROM srv_log WHERE at < ?').run(cutoff);
    }
    let stats = 0;
    if (k.has('stats')) {
      const ms = Math.min(Date.parse(cutoff) || 0, now());
      stats = Number(raw.prepare('DELETE FROM srv_spend WHERE checked_at < ?').run(cutoff === FOREVER ? Number.MAX_SAFE_INTEGER : ms).changes);
      // Lines still ticked on the list from before then aren't noted again (data.mjs sweep).
      const floor = cutoff === FOREVER ? now() : ms;
      if (floor > Number(e.meta('srv_spend_floor') ?? 0)) e.setMeta('srv_spend_floor', String(floor));
    }
    const backups = k.has('backups') ? await R.emptyTrash(cutoff) : 0;
    raw.prepare('DELETE FROM srv_specials WHERE at < ?').run(iso(now() - 60 * DAY));
    const out = { cutoff, prices: gone.prices, receipts: gone.receipts.length, photos, archives, logs, stats, backups };
    logLine('log', 'pruned', null, { ...out, kinds: [...k], why });
    writeOwn();
    return out;
  }

  /** 0.9.5: what pruneTo would delete, counted by the same rules (POST /api/v3/data/delete with dryRun). */
  async function countTo(cutoff, k) {
    const out = { cutoff, prices: 0, receipts: 0, photos: 0, archives: 0, logs: 0, stats: 0, backups: 0, dryRun: true };
    if (k.has('prices')) {
      out.prices = Number(raw.prepare(`SELECT COUNT(*) AS n FROM prices WHERE date < ? AND source <> 'demo' AND date < (SELECT MAX(q.date) FROM prices q WHERE q.product_id = prices.product_id)`).get(cutoff).n);
    }
    if (k.has('receipts')) {
      const going = raw.prepare("SELECT id, photo, pages FROM receipts WHERE scanned_at < ? AND pinned = 0 AND id NOT LIKE 'demo-%'").all(cutoff).map((r) => ({ ...r }));
      out.receipts = going.length;
      out.photos = photosFor(going);
    }
    out.archives = archivesFor(cutoff, k).length;
    if (k.has('logs')) out.logs = Number(raw.prepare('SELECT COUNT(*) AS n FROM srv_log WHERE at < ?').get(cutoff).n);
    if (k.has('stats')) out.stats = Number(raw.prepare('SELECT COUNT(*) AS n FROM srv_spend WHERE checked_at < ?').get(cutoff === FOREVER ? Number.MAX_SAFE_INTEGER : Math.min(Date.parse(cutoff) || 0, now())).n);
    if (k.has('backups')) out.backups = await R.emptyTrash(cutoff, { dryRun: true });
    return out;
  }

  // Auto delete runs nightly (and once soon after a start, so a restart doesn't skip a night): the
  // hourly check runs it in the 3 o'clock hour (the server's time zone: TZ, zone.mjs) at most once a day.
  let lastDaily = 0;
  const zone = R.cfg?.timeZone || serverZone();
  async function daily(force = false) {
    if (!R.engine || S.mode !== 'v3') return;
    if (!force && now() - lastDaily < 20 * 3600 * 1000) return;
    if (!force && lastDaily && hourIn(now(), zone) !== 3 && now() - lastDaily < 26 * 3600 * 1000) return;
    lastDaily = now();
    const cut = R.house.cutoff(now());
    if (cut) await pruneTo(cut);
    const c = R.engine.compact();
    if (c) logLine('log', 'compacted', null, { deletes: c });
    dropStaleWebFiles();
    writeOwn();
  }

  // ---------- reading for the web: history, stats, specials ----------

  function history(product, from) {
    const rows = from
      ? raw.prepare('SELECT product_id, date, price, was_price, is_special, member_only, promo, source FROM prices WHERE product_id = ? AND date >= ? ORDER BY date').all(product, from)
      : raw.prepare('SELECT product_id, date, price, was_price, is_special, member_only, promo, source FROM prices WHERE product_id = ? ORDER BY date').all(product);
    return rows.map((r) => ({ ...r }));
  }

  function stats(months) {
    const from = new Date(now());
    from.setUTCDate(1);
    from.setUTCHours(0, 0, 0, 0);
    from.setUTCMonth(from.getUTCMonth() - (months - 1));
    const since = from.toISOString();
    const out = new Map();
    const row = (m) => {
      if (!out.has(m)) out.set(m, { month: m, receipts: {}, receiptCount: 0, productsTracked: 0, specialsSeen: 0 });
      return out.get(m);
    };
    for (let d = new Date(from); d.getTime() <= now(); d.setUTCMonth(d.getUTCMonth() + 1)) row(d.toISOString().slice(0, 7));
    for (const r of raw.prepare("SELECT substr(COALESCE(receipt_date, scanned_at), 1, 7) AS m, section, COUNT(*) AS n, COALESCE(SUM(total), 0) AS total FROM receipts WHERE COALESCE(receipt_date, scanned_at) >= ? AND id NOT LIKE 'demo-%' GROUP BY m, section").all(since)) {
      if (!out.has(r.m)) continue;
      const x = row(r.m);
      x.receipts[r.section] = Math.round(Number(r.total) * 100) / 100;
      x.receiptCount += Number(r.n);
    }
    for (const r of raw.prepare("SELECT substr(date, 1, 7) AS m, COUNT(DISTINCT product_id) AS products, COUNT(DISTINCT CASE WHEN is_special = 1 THEN product_id END) AS specials FROM prices WHERE date >= ? AND source <> 'demo' GROUP BY m").all(since)) {
      if (!out.has(r.m)) continue;
      const x = row(r.m);
      x.productsTracked = Number(r.products);
      x.specialsSeen = Number(r.specials);
    }
    return [...out.values()].sort((a, b) => a.month.localeCompare(b.month));
  }

  function specials() {
    const from = iso(now() - SPECIALS_DAYS * DAY);
    const rows = raw
      .prepare(
        `SELECT p.product_id, p.date, p.price, p.was_price, p.promo, p.member_only, pr.chain, pr.name, pr.brand, pr.size, pr.image_url
         FROM prices p JOIN products pr ON pr.id = p.product_id
         WHERE p.is_special = 1 AND p.date >= ? AND p.date = (SELECT MAX(q.date) FROM prices q WHERE q.product_id = p.product_id)
         ORDER BY p.date DESC LIMIT 2000`,
      )
      .all(from)
      .map((r) => ({ ...r }));
    const extra = specialsOut();
    return { specials: rows, lists: extra.specials?.lists ?? [], catalogues: extra.catalogues ?? {} };
  }

  return { openDb, closeDb, logLine, readLog, moveActivity, queue, settle, mergeEverything, writeOwn, pruneTo, daily, dropStaleWebFiles, history, stats, specials, raw: () => raw };
}

/** File names under files/ (for the merge and retention), from a directory walk. */
export function walkNames(filesDir) {
  const out = [];
  const dir = (rel, depth) => {
    let ents;
    try {
      ents = readdirSync(rel ? join(filesDir, rel) : filesDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of ents) {
      const r = rel ? rel + '/' + e.name : e.name;
      if (e.isDirectory() && depth < 2) dir(r, depth + 1);
      else if (e.isFile()) out.push(r);
    }
  };
  dir('', 0);
  return out;
}
