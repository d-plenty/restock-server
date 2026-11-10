// 0.9.4 (protocol v3): Home Assistant on the server (D12). The core's syncRound (haSync.ts, the same
// code the phones run) against Home Assistant's REST API, 24/7: every 60 seconds and 4 seconds after a
// merge that changed the groceries list. Restock's side is a Store over household.db (the Pantry tab's
// and General's lines, 0.9.5: items of every shared tab, so a voice add goes to the list of what it
// matches and to General when nothing does; aliases from household_settings, the pairing in kv), written through the triggers
// as srv-<sid>, so the changes reach phones in the server's own file.
// The token is in keys.json only: never in an answer, the log or an error (requests carry it, nothing
// else does). docs/server-v3-design.md section 9.

import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { randomUUID } from 'node:crypto';

const HA_STATE = 'homeAssistantState';
const MIN = 60_000;
export const HA_LIMITS = { everyMs: MIN, afterMergeMs: 4000, timeoutMs: 15_000, maxAnswer: 4 * 1024 * 1024 };

/** An address as typed: "http://homeassistant.local:8123/" → "http://homeassistant.local:8123"; null if it isn't one. */
export function tidyAddress(s) {
  let t = String(s ?? '').trim();
  if (!t || t.length > 300) return null;
  if (!/^https?:\/\//i.test(t)) t = 'http://' + t;
  try {
    const u = new URL(t);
    if (u.username || u.password || (u.protocol !== 'http:' && u.protocol !== 'https:')) return null;
    return `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, '')}`;
  } catch {
    return null;
  }
}

/** Is `b` another place than `a` (scheme, host or port)? The saved token only goes where it was saved for. */
function elsewhere(a, b) {
  try {
    return new URL(a).origin !== new URL(b).origin;
  } catch {
    return true;
  }
}

/** May plain http go there? Home and Tailscale addresses, .local/.lan/.home.arpa names, one-word names (Docker's, Home Assistant's own). */
async function httpAllowed(host, isHomeAddress) {
  const h = host.replace(/^\[|\]$/g, '');
  if (isIP(h)) return isHomeAddress(h);
  if (/\.(local|lan|home\.arpa|internal)$/i.test(h) || !h.includes('.')) return true;
  try {
    const all = await lookup(h, { all: true });
    return all.length > 0 && all.every((a) => isHomeAddress(a.address));
  } catch {
    return false;
  }
}

export function makeHa(R) {
  const { core, S, keys, now } = R;
  const K = keys.data;
  const status = { lastAt: null, lastError: null, okAt: null, last: null };
  let timer = null;
  let soonTimer = null;
  let running = null;
  const me = () => 'srv-' + S.sid;
  const raw = () => R.merger.raw();

  /** A Home Assistant payload from a phone (handover or upgrade), checked. */
  function cleanPayload(p) {
    const address = tidyAddress(p.address);
    const entity = typeof p.entity === 'string' && /^todo\.[a-z0-9_]{1,100}$/.test(p.entity) ? p.entity : null;
    const token = typeof p.token === 'string' && p.token.length >= 10 && p.token.length <= 1000 && !/\s/.test(p.token) ? p.token : null;
    if (!address || !entity || !token) return null;
    let state = null;
    if (p.state && typeof p.state === 'object' && Array.isArray(p.state.pairs)) state = p.state;
    return { address, entity, enabled: p.enabled !== false, token, state };
  }

  // ---------- the transport: Node's fetch, with the token, http only at home ----------

  function transport(address, token) {
    return async (method, path, body) => {
      const u = new URL(address + path);
      if (u.protocol === 'http:' && !(await httpAllowed(u.hostname, R.isHomeAddress))) {
        throw new core.HaError('Plain http only goes to an address at home or on Tailscale. Use https:// for Home Assistant away from home.');
      }
      let r;
      try {
        r = await fetch(u, {
          method,
          headers: { Authorization: 'Bearer ' + token, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
          body: body === undefined ? undefined : JSON.stringify(body),
          redirect: 'manual',
          signal: AbortSignal.timeout(HA_LIMITS.timeoutMs),
        });
      } catch {
        throw new core.HaError("Couldn't reach Home Assistant. Check the address, and that the server can reach it.");
      }
      const text = await r.text();
      return { status: r.status, text: text.length > HA_LIMITS.maxAnswer ? text.slice(0, HA_LIMITS.maxAnswer) : text };
    };
  }

  // ---------- Restock's side: household.db ----------

  function store() {
    const db = raw();
    const entity = K.ha.entity;
    // 0.9.5: the items of every tab the household shares (the server only has those), with their tab.
    const tabs = () => R.engine?.householdTabs() ?? new Set(['pantry']);
    const allItems = () => db.prepare('SELECT id, name, section FROM items').all();
    return {
      async lines() {
        // 0.9.5: the grocery list's and General's, and lines made from Home Assistant's list (core.onHaList).
        const groups = new Map(allItems().map((g) => [g.id, g.section ?? 'pantry']));
        return db
          .prepare('SELECT id, text, item_id, section, checked, qty FROM list_entries')
          .all()
          .filter((e) => core.onHaList(e.id, (e.item_id ? groups.get(e.item_id) : undefined) ?? e.section ?? 'pantry'))
          .map((e) => ({ id: e.id, text: e.text, qty: Math.max(1, Number(e.qty ?? 1)), checked: Number(e.checked) !== 0, groupId: e.item_id ?? undefined }));
      },
      async items() {
        const on = tabs();
        return allItems()
          .filter((g) => on.has(g.section ?? 'pantry') || (g.section ?? 'pantry') === 'pantry')
          .map((g) => ({ id: g.id, name: g.name, section: g.section ?? 'pantry' }));
      },
      async aliases() {
        const out = {};
        for (const r of db.prepare("SELECT k, v FROM household_settings WHERE k LIKE 'alias:%'").all()) {
          let v;
          try {
            v = JSON.parse(r.v);
          } catch {
            continue;
          }
          const id = core.checkListRow(r.k, v);
          if (typeof id === 'string') out[r.k.slice('alias:'.length)] = id;
        }
        return out;
      },
      async addLine(l, uid) {
        const id = uid ? core.haLineId(entity, uid) : 'ha-' + randomUUID();
        db.prepare('INSERT OR IGNORE INTO list_entries (id, text, item_id, section, checked, qty, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, l.text, l.groupId ?? null, l.section ?? 'pantry', l.checked ? 1 : 0, l.qty, new Date(now()).toISOString());
        return id;
      },
      async updateLine(id, patch) {
        const sets = [];
        const vals = [];
        const add = (sql, ...v) => {
          sets.push(sql);
          vals.push(...v);
        };
        if ('text' in patch) add('text = ?', patch.text);
        if ('qty' in patch) add('qty = ?, qty_at = ?', patch.qty, now());
        if ('checked' in patch) add('checked = ?, checked_at = ?', patch.checked ? 1 : 0, now());
        if ('groupId' in patch) add('item_id = ?', patch.groupId ?? null);
        if (sets.length) db.prepare(`UPDATE list_entries SET ${sets.join(', ')} WHERE id = ?`).run(...vals, id);
      },
      async removeLines(ids) {
        for (const id of ids) db.prepare('DELETE FROM list_entries WHERE id = ?').run(id);
      },
      async loadState() {
        const r = db.prepare('SELECT value FROM kv WHERE key = ?').get(HA_STATE);
        try {
          const s = r ? JSON.parse(r.value) : null;
          if (!s || !Array.isArray(s.pairs)) return core.emptyState();
          const out = { pairs: s.pairs, pick: Array.isArray(s.pick) ? s.pick : [] };
          if (Number.isFinite(s.emptySince)) out.emptySince = s.emptySince;
          if (Number.isFinite(s.emptyLast)) out.emptyLast = s.emptyLast;
          return out;
        } catch {
          return core.emptyState();
        }
      },
      async saveState(s) {
        db.prepare('INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)').run(HA_STATE, JSON.stringify(s));
      },
    };
  }

  // ---------- who runs it ----------

  /** The household's ha:phone row (a device id), or null. */
  function haPhone() {
    const db = raw();
    if (!db) return null;
    const r = db.prepare("SELECT v FROM household_settings WHERE k = 'ha:phone'").get();
    if (!r) return null;
    try {
      const v = JSON.parse(r.v);
      return typeof v === 'string' ? v : null;
    } catch {
      return null;
    }
  }
  /**
   * The household's ha:phone row = "srv-<sid>", written through the triggers as the server (so it goes
   * out in the server's file, stamped after the phone's): the phone that ran Home Assistant reads it,
   * deletes its token and stops (and a 0.9.3 one over Wi-Fi takes it as "moved to another phone").
   */
  function claim() {
    const db = raw();
    if (!db || haPhone() === me()) return false;
    db.prepare('INSERT OR REPLACE INTO household_settings (k, v) VALUES (?, ?)').run('ha:phone', JSON.stringify(me()));
    R.merger.logLine('log', 'home-assistant-claimed', null, null);
    return true;
  }
  /** Why the server can't run it now, or null. */
  function blocked() {
    if (!K.ha) return 'Home Assistant isn\'t set up on the server.';
    if (!K.ha.enabled) return 'Home Assistant is off.';
    if (!K.ha.token) return 'Add a long-lived access token from Home Assistant.';
    const p = haPhone();
    if (p && p !== me()) {
      const d = S.devices[p];
      // A 0.9.3 phone still running it (api 2): one runner, until the admin says it's off there.
      if (d && d.status === 'active' && d.api !== 3 && K.ha.offOn !== p) return `Home Assistant still runs on ${d.label ?? d.name ?? p} (Restock 0.9.3).`;
    }
    return null;
  }

  async function round(why) {
    if (running) return running;
    running = (async () => {
      const no = blocked();
      if (no) return { ok: false, message: no };
      claim();
      status.lastAt = new Date(now()).toISOString();
      try {
        const r = await core.syncRound(core.restApi(transport(K.ha.address, K.ha.token), K.ha.entity), store(), now());
        status.lastError = null;
        status.okAt = status.lastAt;
        status.last = r;
        if (r.came || r.went || r.held) R.merger.logLine('log', 'home-assistant', null, { why, came: r.came, went: r.went, held: !!r.held });
        R.writeOwn();
        return { ok: true, ...r };
      } catch (e) {
        const message = e instanceof core.HaError ? e.message : "Couldn't sync with Home Assistant.";
        status.lastError = message;
        R.merger.logLine('log', 'home-assistant-failed', null, { why, message });
        R.writeOwn();
        return { ok: false, message };
      }
    })();
    try {
      return await running;
    } finally {
      running = null;
    }
  }

  function start() {
    stop();
    timer = setInterval(() => {
      if (S.mode === 'v3' && R.engine && K.ha?.enabled) void round('timer');
    }, R.cfg.haEveryMs ?? HA_LIMITS.everyMs);
    timer.unref?.();
  }
  function stop() {
    if (timer) clearInterval(timer);
    if (soonTimer) clearTimeout(soonTimer);
    timer = soonTimer = null;
  }
  /** 4 seconds after a merge that changed the groceries list. */
  function soon() {
    if (!K.ha?.enabled || soonTimer) return;
    soonTimer = setTimeout(() => {
      soonTimer = null;
      void round('merge');
    }, R.cfg.haAfterMergeMs ?? HA_LIMITS.afterMergeMs);
    soonTimer.unref?.();
  }

  /** At the handover: the owner phone's Home Assistant moved here (its pairing too, so nothing is paired again). */
  function tookOver(state) {
    if (state && typeof state === 'object' && Array.isArray(state.pairs)) raw().prepare('INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)').run(HA_STATE, JSON.stringify(state));
    if (K.ha) delete K.ha.state;
    keys.save();
    // Running it here from now on (it was on, on the phone): the row tells that phone to stop.
    if (K.ha?.enabled && !blocked()) claim();
  }

  /** What the web sees: never the token. */
  function view() {
    const p = haPhone();
    const d = p && p !== me() ? S.devices[p] : null;
    return {
      address: K.ha?.address ?? '',
      entity: K.ha?.entity ?? '',
      enabled: !!K.ha?.enabled,
      hasToken: !!K.ha?.token,
      ...(status.okAt ? { lastAt: status.okAt } : {}),
      ...(status.lastError ? { lastError: status.lastError } : {}),
      ...(p ? { phone: p, phoneName: d?.label ?? d?.name ?? null, phoneApi: p === me() ? null : (d?.api ?? null) } : {}),
      ...(K.ha?.offOn ? { offOn: K.ha.offOn } : {}),
      blocked: K.ha?.enabled ? blocked() : null,
    };
  }

  /** PUT: { address?, entity?, enabled?, token?, offOn? } (the token only sealed). */
  function set(b, sealed) {
    const HttpError = R.HttpError;
    const next = { ...(K.ha ?? { address: '', entity: 'todo.shopping_list', enabled: false, token: null }) };
    if (b.address !== undefined) {
      const a = tidyAddress(b.address);
      if (!a) throw new HttpError(400, 'address', "That doesn't look like an address. Use the one you open Home Assistant with, like http://homeassistant.local:8123.");
      next.address = a;
    }
    if (b.entity !== undefined) {
      if (typeof b.entity !== 'string' || !/^todo\.[a-z0-9_]{1,100}$/.test(b.entity)) throw new HttpError(400, 'entity', 'Pick a to-do list (todo.…).');
      next.entity = b.entity;
    }
    if (b.token !== undefined) {
      if (!sealed) throw new HttpError(400, 'sealed', 'Send the token sealed.');
      if (b.token === null || b.token === '') next.token = null;
      else if (typeof b.token !== 'string' || b.token.length < 10 || b.token.length > 1000 || /\s/.test(b.token)) throw new HttpError(400, 'token', "That doesn't look like a Home Assistant token.");
      else next.token = b.token;
    }
    // A new address keeps the saved token only if it's the same Home Assistant (scheme, host and port):
    // otherwise a signed-in browser could send the token wherever it liked, and it's write-only.
    if (b.token === undefined && next.token && K.ha?.address && elsewhere(K.ha.address, next.address)) {
      throw new HttpError(400, 'token', 'Paste the long-lived access token again for a new Home Assistant address.');
    }
    if (b.offOn !== undefined) next.offOn = typeof b.offOn === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(b.offOn) ? b.offOn : null;
    if (b.enabled !== undefined) next.enabled = b.enabled === true;
    const changedList = K.ha && (next.address !== K.ha.address || next.entity !== K.ha.entity);
    K.ha = next;
    keys.save();
    // A new address or list: start the pairing afresh (the old one's items aren't this list's).
    if (changedList) raw().prepare('DELETE FROM kv WHERE key = ?').run(HA_STATE);
    if (next.enabled) {
      if (!blocked()) claim();
      start();
      soon();
    } else {
      // Off: let go of ha:phone, so a phone in the house can't think the server still runs it.
      if (haPhone() === me()) raw().prepare("DELETE FROM household_settings WHERE k = 'ha:phone'").run();
    }
    R.writeOwn();
    return view();
  }

  /** Test connection: { ok, message?, lists?, version? }. */
  async function test(b, sealed) {
    const address = b.address !== undefined ? tidyAddress(b.address) : K.ha?.address;
    if (!address) return { ok: false, message: "That doesn't look like an address." };
    if (b.token !== undefined && !sealed) throw new R.HttpError(400, 'sealed', 'Send the token sealed.');
    if (b.token === undefined && K.ha?.token && K.ha?.address && elsewhere(K.ha.address, address)) {
      return { ok: false, message: 'Paste the long-lived access token again to test a new Home Assistant address.' };
    }
    const token = b.token !== undefined ? b.token : K.ha?.token;
    if (!token || typeof token !== 'string') return { ok: false, message: 'Add a long-lived access token from Home Assistant.' };
    try {
      const r = await core.haLists(transport(address, token));
      if (core.tooOld(r.version)) return { ok: false, message: `Restock needs Home Assistant ${core.MIN_HA_VERSION} or newer for the shopping list.`, version: r.version };
      return { ok: true, version: r.version, lists: r.lists.map((l) => ({ entity: l.id, name: l.name })) };
    } catch (e) {
      return { ok: false, message: e instanceof core.HaError ? e.message : "Couldn't reach Home Assistant." };
    }
  }

  return { cleanPayload, round, start, stop, soon, tookOver, view, set, test, haPhone, blocked, status };
}
