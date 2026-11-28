// 0.9.4: API v3 (docs/server-v3-design.md section 5, docs/server-protocol.md "v3"). Every endpoint
// says who may call it: a phone (Restock2, signed with its key, as v2), a browser session (RestockWeb3,
// every request MACed, household data sealed), or anyone (health, sign-in, joining, which carry their
// own proof). Built by makeServer with the helpers it shares with v2 (R).

import { randomBytes, createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { openKeys, makeHouse } from './house.mjs';
import { makeMerger } from './merge.mjs';
import { makeWebAuth, SEALED, SESSION_HOURS } from './webauth.mjs';
import { makeApprovals, compareVersions } from './approve.mjs';
import { validZone } from '../zone.mjs';
import { existsSync } from 'node:fs';
import { makeHa } from './ha.mjs';
import { makeData } from './data.mjs';
import { backupStream } from './backup.mjs';
import { parseNameV3, canWriteV3, canReadV3, bodyOkV3, reservedDevice, DEVICE } from '../names.mjs';
import { checkPassphrase } from '../../public/setup/strength.js';
import { placeOf, repairAddresses, cleanAddress } from './addr.mjs';

const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const b64u = (b) => Buffer.from(b).toString('base64url');
const V3_LIMITS = { inviteMs: 10 * MIN, maxInvites: 20, maxJoinNonces: 5000, inviteKeptMs: DAY };

/**
 * 0.18.3: the Add a phone codes, kept in state.json (S.invites) so a restart doesn't lose them, and a
 * used or expired one is remembered for a day, so scanning it says "already used" or "expired" (it
 * said "That code isn't from this server" once the minute's tidy-up had taken it). Map-like.
 */
function inviteStore(S, save) {
  if (!S.invites || typeof S.invites !== 'object' || Array.isArray(S.invites)) S.invites = {};
  const all = () => S.invites;
  return {
    get: (k) => (Object.hasOwn(all(), k) ? all()[k] : undefined),
    set(k, v) {
      all()[k] = v;
      save();
      return this;
    },
    delete(k) {
      const had = Object.hasOwn(all(), k);
      delete all()[k];
      if (had) save();
      return had;
    },
    clear() {
      S.invites = {};
      save();
    },
    values: () => Object.values(all()).values(),
    get size() {
      return Object.keys(all()).length;
    },
    [Symbol.iterator]: () => Object.entries(all())[Symbol.iterator](),
  };
}

/** Builds the v3 side on R (the helpers makeServer shares). Opens household.db when the mode is v3. */
export async function makeV3(R) {
  const { S, now, HttpError } = R;
  const core = R.core;
  R.keys = openKeys(R.DATA, R.TMP);
  const K = R.keys.data;
  if (!S.sid) {
    S.sid = randomBytes(5).toString('hex');
    await R.st.save();
  }
  R.house = makeHouse(R);
  R.merger = makeMerger(R);
  R.web = makeWebAuth(R);
  R.approvals = makeApprovals(R);
  // 0.18.3: Server settings → Household → Time zone, or TZ.
  R.zone = () => (S.settings?.timeZone && validZone(S.settings.timeZone) ? S.settings.timeZone : R.cfg.timeZone);
  R.ha = makeHa(R);
  R.data = makeData(R);
  R.openDb = (o) => R.merger.openDb(o);
  R.closeDb = () => R.merger.closeDb();
  R.writeOwn = () => {
    if (!R.engine) return false;
    if (R.house.widen()) return true; // it merged everything again and wrote the server's file
    return R.merger.writeOwn();
  };
  R.mergeEverything = (o) => R.merger.mergeEverything(o);
  R.moveActivity = () => R.merger.moveActivity();
  const { house, merger, web, ha } = R;

  const invites = inviteStore(S, () => R.st.saveSoon()); // sha256(invite) -> { expires, used, label, role }
  const joinNonces = new Map(); // n -> at

  // ---------- on start ----------
  if (S.mode === 'v3' || S.mode === 'released') {
    if (!R.engine) await R.openDb({});
    // 0.18.3: an http:// away address (or a home one that isn't at home) learnt from a tunnel before 0.18.3, put right.
    if (S.house) {
      const fixed = repairAddresses(S.house, R.isHomeAddress);
      if (fixed.changed) {
        R.note('addresses-repaired', { from: { home: S.house.home || null, away: S.house.away || null }, to: { home: fixed.home || null, away: fixed.away } });
        S.house.home = fixed.home;
        S.house.away = fixed.away;
        await R.st.save();
      }
    }
    if (house.refreshServerRow()) R.note('server-row-updated', {});
    R.mergeEverything({});
    R.writeOwn();
    if (K.ha?.enabled) ha.start();
  }

  const timers = [
    setInterval(() => {
      const t = now();
      for (const [k, v] of invites) if (v.expires + V3_LIMITS.inviteKeptMs < t) invites.delete(k);
      for (const [k, v] of joinNonces) if (t - v > 11 * MIN) joinNonces.delete(k);
      web.prune();
      R.approvals.prune();
    }, MIN),
    setInterval(() => void merger.daily().catch((e) => R.log('daily:', e.message)), 60 * MIN),
    setInterval(() => void checkUpdates(), 60 * MIN),
  ];
  for (const t of timers) t.unref();
  setTimeout(() => void merger.daily().catch((e) => R.log('daily:', e.message)), 30_000).unref();
  setTimeout(() => void checkUpdates(), 60_000).unref();

  function close() {
    for (const t of timers) clearInterval(t);
    ha.stop();
    merger.settle();
    R.closeDb();
  }

  // ---------- helpers ----------

  const iso = (t) => (t ? new Date(t).toISOString() : null);
  const sealedAnswer = (actor, status, obj, req, res, keyv = K.keyv) => {
    if (actor?.type === 'web3') return R.send(req, res, status, web.seal(actor.session.key, obj), SEALED);
    // 0.10.1: a phone that asks (X-Restock-Seal: rsf1) gets its answer sealed with the household's
    // server key, with its request's nonce inside, so nobody else on the network can read (or swap)
    // its Your data figures. 0.9.14 and 0.10.0 phones don't ask, and get them as before.
    if (actor?.type === 'phone' && /\brsf1\b/.test(String(req.headers['x-restock-seal'] ?? '')) && K.serverKeys?.[String(keyv)]) {
      const n = core?.parseAuthorization(req.headers.authorization)?.fields?.n ?? null;
      const msg = obj && typeof obj === 'object' && !Array.isArray(obj) ? { ...obj, reqN: n } : { value: obj, reqN: n };
      return R.send(req, res, status, Buffer.from(core.sealRsf1(Buffer.from(K.serverKeys[String(keyv)], 'base64url'), msg)), SEALED);
    }
    return R.send(req, res, status, obj);
  };
  /** 0.10.1: a phone's body sealed with the household's server key (any version it knows). */
  const phoneSealed = (body) => {
    let m;
    try {
      m = core.openWithAny(K.serverKeys ?? {}, body).msg;
    } catch {
      throw new HttpError(400, 'sealed', "That isn't sealed for this household.");
    }
    if (!m || typeof m !== 'object' || Array.isArray(m)) throw new HttpError(400, 'sealed', "That isn't sealed for this household.");
    return m;
  };
  function needMode(...modes) {
    if (!modes.includes(S.mode)) {
      if (S.mode === 'released') throw new HttpError(409, 'released', `Your household was taken back by ${S.releasedBy ?? 'a phone'}. Start the server afresh from its web page.`);
      throw new HttpError(409, 'mode', S.mode === 'v2' ? R.OLD_HOUSEHOLD : 'Set up this server first.', { mode: S.mode });
    }
  }
  function needCore() {
    if (!core) throw new HttpError(503, 'core', "This copy of the server was built without the Restock core, so it can't keep a household itself. Rebuild it (see the README).");
  }
  function needWeb(actor, kind) {
    if (!actor || actor.type !== 'web3') {
      if (actor?.type === 'phone') throw new HttpError(403, 'forbidden', 'Do this from the web page.');
      throw new HttpError(401, 'auth', 'Sign in first.');
    }
    if (kind === 'passphrase' && actor.kind !== 'passphrase') throw new HttpError(403, 'passphrase', 'Sign in with your passphrase to do that.');
  }
  /**
   * The house's sign-in (v3) needs the login key, which the server learns at a v2 sign-in on 0.9.4
   * (or when the passphrase is set). A v2 session from before the update never told it: making the
   * house then would leave no way to sign in to it (v2 sign-ins stop in v3).
   */
  function needLoginKey() {
    if (!S.account?.loginKey) throw new HttpError(409, 'signin', 'Sign out, then sign in again with your passphrase first (the new sign-in needs it once).');
  }
  /**
   * 0.18.0: who looks after the phones. The web page (any sign-in) and a phone the server made an
   * admin (Make admin, or an admin's code). A phone's request has to come sealed, and ask for its
   * answer sealed (X-Restock-Seal: rsf1): the codes it makes let a new phone in.
   */
  const isAdminPhone = (actor) => actor?.type === 'phone' && actor.dev?.role === 'admin' && actor.dev?.api === 3;
  function needManager(actor, req, change = true) {
    if (actor?.type === 'web3') {
      // A browser signed in with a phone looks after the phones only if that phone is an admin
      // (any browser still sees the list). The passphrase sign-in always does.
      if (!change || actor.kind === 'passphrase') return;
      const by = actor.session?.device ? S.devices[actor.session.device] : null;
      if (by && (by.status ?? 'active') === 'active' && by.role === 'admin') return;
      throw new HttpError(403, 'admin', 'Only an admin can do that. Sign in with the passphrase, or with an admin phone.');
    }
    if (!actor) throw new HttpError(401, 'auth', 'Sign in first.');
    if (!isAdminPhone(actor)) throw new HttpError(403, 'admin', 'Only an admin can do that. Ask an admin, or use the web page.');
    if (!/\brsf1\b/.test(String(req.headers['x-restock-seal'] ?? ''))) throw new HttpError(400, 'sealed', 'Update Restock to do that from this phone.');
  }
  /** Making admins (a code for one, Make admin, Make user) and removing phones: the passphrase on the web page, or an admin phone. */
  function needAdmin(actor, req) {
    needManager(actor, req);
    if (actor.type === 'web3' && actor.kind !== 'passphrase') throw new HttpError(403, 'passphrase', 'Sign in with your passphrase to do that.');
  }
  function needPhone(actor, api3 = true) {
    if (!actor || actor.type !== 'phone') throw new HttpError(actor ? 403 : 401, actor ? 'forbidden' : 'auth', actor ? 'Only a phone can do that.' : 'Sign in first.');
    if (api3 && actor.dev.api !== 3) throw new HttpError(403, 'update', 'Update Restock to keep syncing with your server.', { api: 3 });
  }
  /**
   * 0.9.4 review: the dangerous admin actions (the recovery key, the backup, deleting data with Keep
   * data for or Delete older data, Remove a phone) need the passphrase again, proved as a passphrase
   * change proves it: `confirm: { c, proof }`, `c` a fresh sign-in challenge (GET /api/v3/login/
   * challenge), `proof` = HMAC(loginKey, "restock-login-v3\n" + c + "\n" + this session's id). A wrong
   * one counts towards the sign-in lockout.
   */
  function needConfirm(actor, b, ip, what) {
    R.checkLock(ip);
    const c = b && typeof b === 'object' && b.confirm && typeof b.confirm === 'object' ? b.confirm : null;
    if (!c) throw new HttpError(403, 'confirm', 'Type your passphrase again to do that.');
    const a = S.account;
    const okC = web.useChallenge(c.c);
    // 0.18.3: an admin phone proves it over its own device id (it has no browser session).
    const bound = actor.type === 'phone' ? 'phone:' + actor.device : actor.sid;
    const want = a?.loginKey ? core.loginProof(Buffer.from(a.loginKey, 'base64url'), String(c.c ?? ''), bound) : '';
    if (!okC || !want || !R.same(String(c.proof ?? ''), want)) {
      R.failed(ip, 'confirm');
      R.note('confirm-refused', { by: actor.by, what, ip: R.mask(ip) });
      if (!okC) throw new HttpError(403, 'confirm', 'That took too long. Type your passphrase again.');
      throw new HttpError(403, 'current', "That isn't the current passphrase.");
    }
    R.clearFails(ip);
  }
  /**
   * 0.18.3: the risky changes (approve.mjs WHAT): the passphrase again (needConfirm), then on the web
   * page a yes on an admin phone too. The first request, with the passphrase, gets 403 'approve' and
   * the request to show ({ approve: { id, number, phones, expiresIn } }); once a phone said yes the
   * page sends it again with `approved: id` in place of the passphrase (taken once, within 2 minutes).
   * An admin phone asking for itself proves the passphrase (it is the phone). `what` is needConfirm's;
   * APPROVE_OF maps it to the request's kind (no kind: the passphrase alone, as before).
   */
  const APPROVE_OF = { 'phone-backup': 'phone-backup', 'backup-key': 'backup-key', 'auto-delete': 'keep-data', 'keep-data': 'keep-data', 'delete-data': 'delete-data', prune: 'delete-data', 'delete-everything': 'delete-everything', 'recovery-key': 'recovery-key', passphrase: 'passphrase', 'user-name': 'user-name', move: 'move', erase: 'erase' };
  function needSure(actor, b, ip, what) {
    const kind = APPROVE_OF[what];
    if (actor?.type === 'web3' && kind && b && typeof b.approved === 'string') {
      if (R.approvals.take(b.approved, actor.hash, kind)) return;
      throw new HttpError(403, 'approve-expired', 'That yes from the phone has run out. Try again.');
    }
    needConfirm(actor, b, ip, what);
    if (actor?.type === 'web3' && kind && R.approvals.needed()) {
      const a = R.approvals.start(kind, actor.hash, actor.session, R.mask(ip));
      throw new HttpError(403, 'approve', 'Say yes on an admin phone.', { approve: a });
    }
  }
  /**
   * 0.18.3: Server settings and Data, from the web page or an admin phone (Settings → Sync → Server
   * admin). `kind` 'passphrase' is needWeb's: on the web page, signed in with the passphrase (or an
   * admin phone's sign-in for reading); a phone must be an admin and send sealed.
   */
  function needAdminWeb(actor, req, kind) {
    if (actor?.type === 'phone') {
      needPhone(actor);
      needManager(actor, req);
      return;
    }
    needWeb(actor, kind);
  }
  const activeAdmins = () => Object.entries(S.devices).filter(([, d]) => (d.status ?? 'active') === 'active' && d.role === 'admin');
  /** 0.18.3: the last admin phone can't be removed or made a user, so there's always one to say yes and look after the phones. */
  function needNotLastAdmin(device) {
    const admins = activeAdmins();
    if (admins.length === 1 && admins[0][0] === device) {
      throw new HttpError(409, 'last-admin', "That's the only admin phone. Make another phone an admin first, so there's always one to look after the phones.");
    }
  }

  // ---------- 0.18.3: the rest of Server settings ----------

  const inDocker = () => R.cfg.inDocker ?? existsSync('/.dockerenv');
  /** Oldest Restock that can join: never below the core's own minimum, never above this server. */
  const lowestApp = () => core?.MIN_APP ?? '0.14.0';
  function minApp() {
    const v = S.settings?.minApp;
    return typeof v === 'string' && compareVersions(v, lowestApp()) > 0 && compareVersions(v, R.VERSION) <= 0 ? v : lowestApp();
  }
  const tooOldHere = (version) => !!version && compareVersions(version, minApp()) < 0 && compareVersions(minApp(), lowestApp()) > 0;
  const oldHereWords = () => `Update Restock to ${minApp()} or newer to keep syncing with your server (an admin chose that in Server settings).`;
  const updatesOn = () => S.settings?.updateCheck !== false;
  function updatesView() {
    const u = S.updates ?? {};
    const latest = typeof u.latest === 'string' ? u.latest : null;
    return { on: updatesOn(), version: R.VERSION, latest, newer: !!latest && compareVersions(latest, R.VERSION) > 0, checked: u.checked ? iso(u.checked) : null, url: typeof u.url === 'string' ? u.url : null };
  }
  /** Once a day, when it's on: the newest release on GitHub (only its version number comes back). */
  async function checkUpdates(force = false) {
    if (!updatesOn() || R.cfg.updateCheck === false) return;
    const u = S.updates ?? {};
    if (!force && u.checked && now() - u.checked < 20 * 60 * MIN) return;
    try {
      const r = await fetch('https://api.github.com/repos/d-plenty/restock-server/releases/latest', { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'restock-server/' + R.VERSION }, signal: AbortSignal.timeout(15_000) });
      if (!r.ok) throw new Error('GitHub answered ' + r.status);
      const j = await r.json();
      const v = String(j.tag_name ?? '').replace(/^v/i, '').trim();
      if (!/^\d+\.\d+\.\d+$/.test(v)) throw new Error('no version');
      S.updates = { latest: v, checked: now(), url: typeof j.html_url === 'string' && j.html_url.startsWith('https://github.com/') ? j.html_url : null };
      R.st.saveSoon();
    } catch (e) {
      S.updates = { ...u, checked: now(), failed: String(e?.message ?? e).slice(0, 100) };
      R.st.saveSoon();
    }
  }
  function settingsView() {
    return {
      name: S.house.name,
      keepMonths: house.keepMonths(),
      autoDelete: house.keepMonths(),
      home: house.home() || null,
      away: house.away() || null,
      homeFixed: !!R.cfg.homeUrl,
      awayFixed: !!R.cfg.awayUrl,
      addrSet: !!S.house.addrSet,
      timeZone: R.zone(),
      timeZoneSet: !!S.settings?.timeZone,
      minApp: minApp(),
      lowestApp: lowestApp(),
      version: R.VERSION,
      sessionHours: SESSION_HOURS.includes(S.settings?.sessionHours) ? S.settings.sessionHours : 720,
      user: S.account?.user ?? null,
      updates: updatesView(),
      inDocker: inDocker(),
      approvers: R.approvals.phonesOf(),
      recoverySaved: !!K.recoverySaved,
      qrSignIn: S.settings?.qrSignIn !== false,
    };
  }
  /** Does this address answer, and as this server? Five seconds, no redirects followed, a small answer only. */
  async function answersAsThis(url) {
    const stop = new AbortController();
    const t = setTimeout(() => stop.abort(), 5000);
    try {
      const r = await fetch(url + '/api/v3/health', { redirect: 'manual', cache: 'no-store', signal: stop.signal });
      if (r.status !== 200 || Number(r.headers.get('content-length') ?? 0) > 4096) return false;
      const j = JSON.parse((await r.text()).slice(0, 4096));
      return j?.app === 'restock-server' && (!S.house || j.house === S.house.name);
    } catch {
      return false;
    } finally {
      clearTimeout(t);
    }
  }

  /** Checks the 0.18.3 settings in a PUT before anything changes; returns what to change. */
  function checkMoreSettings(b) {
    const out = {};
    for (const where of ['home', 'away']) {
      if (b[where] === undefined) continue;
      if ((where === 'home' && R.cfg.homeUrl) || (where === 'away' && R.cfg.awayUrl)) {
        throw new HttpError(409, 'fixed', `The ${where === 'home' ? 'home' : 'away'} address is set where the server runs (RESTOCK_${where.toUpperCase()}_URL). Change it there.`);
      }
      const c = cleanAddress(b[where], where, R.isHomeAddress);
      if (c.error) throw new HttpError(400, where, c.error);
      out[where] = c.value;
    }
    const home = out.home !== undefined ? out.home : house.home() || null;
    const away = out.away !== undefined ? out.away : house.away() || null;
    if ((out.home !== undefined || out.away !== undefined) && !home && !away) throw new HttpError(400, 'home', 'Keep at least one address, or phones have nowhere to find the server.');
    if (b.timeZone !== undefined) {
      if (b.timeZone !== null && !validZone(b.timeZone)) throw new HttpError(400, 'timeZone', "That isn't a time zone (like Australia/Brisbane).");
      out.timeZone = b.timeZone;
    }
    if (b.minApp !== undefined) {
      if (typeof b.minApp !== 'string' || !/^\d+\.\d+\.\d+$/.test(b.minApp) || compareVersions(b.minApp, lowestApp()) < 0 || compareVersions(b.minApp, R.VERSION) > 0) {
        throw new HttpError(400, 'minApp', `Pick a version from ${lowestApp()} to ${R.VERSION}.`);
      }
      out.minApp = b.minApp;
    }
    if (b.sessionHours !== undefined) {
      if (!SESSION_HOURS.includes(b.sessionHours)) throw new HttpError(400, 'sessionHours', 'Sign out after 1 hour, 1 day, 7 days or 30 days.');
      out.sessionHours = b.sessionHours;
    }
    if (b.qrSignIn !== undefined) {
      if (typeof b.qrSignIn !== 'boolean') throw new HttpError(400, 'qrSignIn', 'Turn Sign in by scanning with a phone on or off.');
      out.qrSignIn = b.qrSignIn;
    }
    if (b.updateCheck !== undefined) {
      if (typeof b.updateCheck !== 'boolean') throw new HttpError(400, 'updateCheck', 'Turn the update check on or off.');
      out.updateCheck = b.updateCheck;
    }
    return out;
  }
  function applyMoreSettings(o, actor) {
    if (o.home !== undefined || o.away !== undefined) {
      if (o.home !== undefined) S.house.home = o.home ?? '';
      if (o.away !== undefined) S.house.away = o.away;
      // Set by hand: the server stops learning them from where it's opened.
      S.house.addrSet = true;
      house.refreshServerRow();
      R.note('addresses-changed', { by: actor.by, home: house.home() || null, away: house.away() || null });
    }
    if (o.timeZone !== undefined) {
      if (o.timeZone === null) delete S.settings.timeZone;
      else S.settings.timeZone = o.timeZone;
      R.note('time-zone-changed', { by: actor.by, zone: R.zone() });
    }
    if (o.minApp !== undefined) {
      if (compareVersions(o.minApp, lowestApp()) === 0) delete S.settings.minApp;
      else S.settings.minApp = o.minApp;
      R.note('oldest-app-changed', { by: actor.by, version: minApp() });
    }
    if (o.sessionHours !== undefined) {
      S.settings.sessionHours = o.sessionHours;
      R.note('sign-out-after-changed', { by: actor.by, hours: o.sessionHours });
    }
    if (o.qrSignIn !== undefined) {
      S.settings.qrSignIn = o.qrSignIn;
      R.note(o.qrSignIn ? 'qr-sign-in-on' : 'qr-sign-in-off', { by: actor.by });
    }
    if (o.updateCheck !== undefined) {
      S.settings.updateCheck = o.updateCheck;
      if (o.updateCheck) void checkUpdates(true);
    }
  }

  /** 0.9.4 review: a receipt photo (photos/<sha256>.bin) must hold the photo its name says. */
  function photoOk(parsed, body) {
    const sha = parsed.name.slice('photos/'.length, -'.bin'.length);
    let m;
    try {
      m = core.openWithAny(K.serverKeys, body).msg;
    } catch {
      return false;
    }
    if (!m || typeof m !== 'object' || m.format !== 'restock-photo' || m.sha256 !== sha || typeof m.data !== 'string') return false;
    return createHash('sha256').update(Buffer.from(m.data, 'base64')).digest('hex') === sha;
  }
  const cleanName = R.cleanName;
  const nOf = (s) => {
    if (typeof s !== 'string' || !/^[A-Za-z0-9_-]{16,32}={0,2}$/.test(s)) return null;
    const b = Buffer.from(s, 'base64url');
    return b.length === 16 ? b : null;
  };
  const p256Str = (s) => (typeof s === 'string' && s.length <= 200 && R.p256Key(s) ? s : null);
  /** 0.18.4: the backup key's private half, sealed with the passphrase (RSK1 + nonce + GCM), base64url. */
  const cleanSealedKey = (s) => {
    if (typeof s !== 'string' || s.length > 300 || !/^[A-Za-z0-9_-]+$/.test(s)) return null;
    const bytes = Buffer.from(s, 'base64url');
    return bytes.length >= 4 + 12 + 16 + 32 && bytes.subarray(0, 4).toString('latin1') === 'RSK1' ? s : null;
  };
  /** 0.18.4: each phone's backup on the server: device -> { at, size }. */
  async function backupFiles() {
    const out = new Map();
    for (const f of await R.walk()) {
      const p = parseNameV3(f.name);
      if (p?.kind === 'backup') out.set(p.owner, { at: f.modified ?? null, size: f.size ?? 0 });
    }
    return out;
  }
  /** 0.18.4: one-off downloads of a phone's backup for the web page (two minutes, once). */
  const backupTokens = new Map();

  /**
   * Without RESTOCK_HOME_URL / RESTOCK_AWAY_URL, and until an admin sets the addresses (Server settings
   * → Addresses), the address the page or the admin phone reached the server at: a home one is where
   * phones find it at home, any other one is away, always as https:// (0.18.3: a Cloudflare tunnel
   * passes plain http on, which made an http:// away address no phone uses).
   */
  function learnAddress(req, actor) {
    if (S.house?.addrSet) return;
    // A phone's request says nothing about how the page is reached from elsewhere.
    if (actor?.type === 'phone') return;
    const p = placeOf(R.origin(req), R.isHomeAddress);
    if (!p || (p.loop && S.house.home)) return;
    if (p.home && !R.cfg.homeUrl) S.house.home = p.home;
    if (p.away && !R.cfg.awayUrl) S.house.away = p.away;
    if (house.refreshServerRow()) R.writeOwn();
  }

  /** A phone's signed request: Restock2, as v2's (its v2 key). */
  function phoneFields(req) {
    const p = core?.parseAuthorization(req.headers.authorization) ?? null;
    if (!p || p.scheme !== 'Restock2') return null;
    const f = p.fields;
    if (!DEVICE.test(f.d || '') || !/^\d{10,16}$/.test(f.t || '') || !/^[A-Za-z0-9_-]{16,32}={0,2}$/.test(f.n || '') || !f.s) throw new HttpError(401, 'auth', "That request isn't signed properly.");
    const dev = S.devices[f.d];
    if (!dev) {
      if ((S.removedDevices ?? []).includes(f.d)) throw new HttpError(401, 'removed', 'This phone was removed from the server.');
      throw new HttpError(401, 'auth', "This server doesn't know this phone. Add it from the web page.");
    }
    // Refused before its body is read (an upload from a removed phone isn't taken in at all).
    if (dev.status && dev.status !== 'active') {
      throw new HttpError(401, 'removed', dev.status === 'left' ? 'This phone left the household on the server.' : 'This phone was removed from the server.');
    }
    return { f, dev };
  }
  function checkPhone(req, ph, body, ownFile = false) {
    R.verifyPhone(req, ph.f, ph.dev.pub, body);
    if (ph.dev.status && ph.dev.status !== 'active') {
      throw new HttpError(401, 'removed', ph.dev.status === 'left' ? 'This phone left the household on the server.' : 'This phone was removed from the server.');
    }
    // 0.15.0: phones older than 0.14.0 are told to update. A phone says its version in X-Restock-App
    // (0.15.0 and newer); for one that doesn't, the version in its last summary. Its own file is
    // still taken, so a phone that has just been updated gets its new summary in and is let back.
    const told = String(req.headers['x-restock-app'] ?? '').trim().slice(0, 40);
    const version = told || summaryOf(ph.f.d)?.summary?.version || '';
    if (!ownFile && core?.appTooOld?.(version)) throw new HttpError(403, core.OLD_APP_ERROR, core.oldAppWords(), { min: core.MIN_APP, version });
    // 0.18.3: Server settings → Household → Oldest Restock that can join.
    if (!ownFile && tooOldHere(version)) throw new HttpError(403, core.OLD_APP_ERROR, oldHereWords(), { min: minApp(), version });
    // 0.18.3: the version it said, so the server knows which admin phones can say yes to a sign-in.
    if (told && ph.dev.app !== told && /^\d+\.\d+\.\d+/.test(told)) {
      ph.dev.app = told;
      R.st.saveSoon();
    }
    if (now() - (ph.dev.lastSeen || 0) > MIN) {
      ph.dev.lastSeen = now();
      R.st.saveSoon();
    }
    return { type: 'phone', device: ph.f.d, dev: ph.dev, by: ph.f.d };
  }

  function summaryOf(device) {
    try {
      const v = R.engine?.meta('phone_summary:' + device);
      return v ? JSON.parse(v) : null;
    } catch {
      return null;
    }
  }

  // ---------- the API ----------

  async function api(req, res, ip, url) {
    const path = url.pathname;
    const method = req.method;

    if (path === '/api/v3/health' && (method === 'GET' || method === 'HEAD')) {
      return R.send(req, res, 200, { ok: true, app: 'restock-server', version: R.VERSION, api: 3, mode: S.mode, ...(S.mode === 'v3' && S.house ? { house: S.house.name } : {}), core: !!core });
    }
    if (!core) needCore();

    // Who's asking: a phone's header and a browser's session are checked before the body is read.
    const isFilePut = method === 'PUT' && path.startsWith('/api/v3/files/');
    const ph = phoneFields(req);
    const wh = ph ? null : web.header(req);
    if (isFilePut && !ph && !wh) throw new HttpError(401, 'auth', 'Sign in first.');
    // DELETE /api/v3/phones/<d> carries the passphrase proof (needConfirm); other DELETEs have no body.
    const withBody = method === 'POST' || method === 'PUT' || method === 'PATCH' || (method === 'DELETE' && path.startsWith('/api/v3/phones/'));
    const body = withBody ? await R.readBody(req, isFilePut ? R.maxFile : R.LIMITS.maxJson) : Buffer.alloc(0);
    const ownFile = isFilePut && !!ph && decodeURIComponent(path.slice('/api/v3/files/'.length)).includes(ph.f.d);
    const actor = ph ? checkPhone(req, ph, body, ownFile) : wh ? web.check(req, wh, body) : null;
    if (actor?.type === 'web3') actor.sid = wh.f.s;
    // 0.18.3: a sign-in waiting for an admin phone's yes can only ask how that's going, or sign out.
    if (actor?.type === 'web3' && actor.session.waiting && !(path === '/api/v3/approve/' + actor.session.waiting || path === '/api/v3/logout')) {
      throw new HttpError(403, 'approve', 'Say yes on an admin phone first.', { approve: R.approvals.view(actor.session.waiting) });
    }
    const sealedIn = () => String(req.headers['content-type'] || '').startsWith(SEALED);
    const input = (opts) => (actor?.type === 'phone' && sealedIn() ? phoneSealed(body) : web.body(actor, req, body, opts));
    let m;

    // ---------- browsers: sign-in ----------
    if (path === '/api/v3/login/challenge' && method === 'GET') {
      const user = String(url.searchParams.get('user') ?? '').normalize('NFKC').slice(0, 200);
      return R.send(req, res, 200, web.challenge(user, ip));
    }
    if (path === '/api/v3/login' && method === 'POST') {
      R.checkLock(ip);
      if (R.scryptUse.hit('all') > R.LIMITS.scryptPerMinute) throw new HttpError(429, 'busy', 'The server is busy. Try again in a minute.', { retryAfter: 60 });
      return R.send(req, res, 200, web.login(input(), req, ip));
    }
    if (path === '/api/v3/logout' && method === 'POST') {
      needWeb(actor);
      const b = input();
      if (b.everywhere) {
        web.endAll();
        R.endV2Sessions();
        R.note('signed-out-everywhere', { by: actor.by });
      } else web.endSession(actor.hash);
      await R.st.save();
      return R.send(req, res, 200, { ok: true });
    }
    if (path === '/api/v3/session' && method === 'GET') {
      needWeb(actor);
      return sealedAnswer(actor, 200, { ...web.gift(actor.session), user: S.account?.user ?? null, kind: actor.kind, expires: web.expiresOf(actor.session) }, req, res);
    }
    if (path === '/api/v3/browsers' && method === 'GET') {
      needAdminWeb(actor, req);
      return sealedAnswer(actor, 200, { browsers: web.list(actor.hash) }, req, res);
    }
    if ((m = /^\/api\/v3\/browsers\/([^/]+)$/.exec(path)) && method === 'DELETE') {
      needAdminWeb(actor, req, 'passphrase');
      const k = web.byId(m[1]);
      if (!k) throw new HttpError(404, 'not-found', "That browser isn't signed in.");
      web.endSession(k);
      await R.st.save();
      R.note('browser-signed-out', { by: actor.by });
      return sealedAnswer(actor, 200, { ok: true, ended: m[1] }, req, res);
    }

    // ---------- 0.18.3: a yes on an admin phone (approve.mjs) ----------
    if ((m = /^\/api\/v3\/approve\/([A-Za-z0-9_-]{20,40})$/.exec(path))) {
      needWeb(actor);
      const id = m[1];
      if (method === 'GET') {
        if (actor.session.waiting === id) {
          // The sign-in's own: with the yes, the session goes on and gets the household's keys.
          const r = R.approvals.signInDone(id, actor.hash);
          if (!r) return R.send(req, res, 200, R.approvals.view(id) ?? { status: 'waiting' });
          delete actor.session.waiting;
          await R.st.save();
          R.note('signed-in', { ip: actor.session.ip, kind: 'passphrase', approvedBy: r.by });
          return R.send(req, res, 200, { status: 'yes', sealed: b64u(web.seal(actor.session.key, web.gift(actor.session))) });
        }
        return R.send(req, res, 200, R.approvals.status(id, actor.hash));
      }
      if (method === 'POST') {
        // { recovery }: the recovery key in place of a phone.
        const b = input({ sealedOnly: true });
        const v = R.approvals.byRecovery(id, actor.hash, b.recovery, ip);
        return R.send(req, res, 200, v);
      }
      if (method === 'DELETE') {
        R.approvals.cancel(id, actor.hash);
        if (actor.session.waiting === id) web.endSession(actor.hash);
        await R.st.save();
        return R.send(req, res, 200, { ok: true });
      }
    }
    if (path === '/api/v3/approvals' && method === 'GET') {
      needMode('v3');
      needPhone(actor);
      if (actor.dev.role !== 'admin') return sealedAnswer(actor, 200, { approvals: [] }, req, res);
      return sealedAnswer(actor, 200, { approvals: R.approvals.list() }, req, res);
    }
    if ((m = /^\/api\/v3\/approvals\/([A-Za-z0-9_-]{20,40})$/.exec(path)) && method === 'POST') {
      needMode('v3');
      needPhone(actor);
      needManager(actor, req);
      const b = input();
      if (typeof b.yes !== 'boolean') throw new HttpError(400, 'yes', 'Yes or no?');
      return sealedAnswer(actor, 200, R.approvals.answer(m[1], actor.device, b.yes), req, res);
    }
    // 0.18.3: an admin phone proving the passphrase (its risky changes): the salt and a challenge.
    if (path === '/api/v3/confirm/challenge' && method === 'GET') {
      needMode('v3');
      needPhone(actor);
      needManager(actor, req, false);
      if (actor.dev.role !== 'admin') throw new HttpError(403, 'admin', 'Only an admin can do that.');
      const user = S.account?.user ?? '';
      return sealedAnswer(actor, 200, { ...web.challenge(user, ip), user }, req, res);
    }

    // ---------- Sign in with a phone ----------
    if (path === '/api/v3/qrlogin' && method === 'POST') {
      needMode('v3');
      if (!S.account) throw new HttpError(409, 'setup', 'Set up the server first.');
      // 0.18.3: Server settings → Sign-in and security → Sign in by scanning with a phone.
      if (S.settings?.qrSignIn === false) throw new HttpError(403, 'qr-off', 'Signing in by scanning is off on this server. Use the passphrase.');
      if (R.qrMade.hit(R.limitKey(ip)) > R.LIMITS.qrLoginsPer10Min) throw new HttpError(429, 'rate', 'Too many sign-in codes. Try again in 10 minutes.', { retryAfter: 600 });
      return R.send(req, res, 200, web.qrStart(R.json(body)));
    }
    if ((m = /^\/api\/v3\/qrlogin\/([^/]+)$/.exec(path))) {
      needMode('v3');
      if (method === 'POST') {
        needPhone(actor);
        web.qrApprove(m[1], actor.device, R.json(body));
        R.note('web-sign-in-approved', { by: actor.device });
        return R.send(req, res, 200, { ok: true });
      }
      if (method === 'GET') {
        const out = web.qrCollect(m[1], req, ip);
        if (!out.pending) await R.st.save();
        return R.send(req, res, 200, out);
      }
    }

    // ---------- Set up this server ----------
    if (path === '/api/v3/setup' && method === 'POST') {
      // A v3 session, or (the setup page, right after the passphrase) v2's passphrase cookie session.
      const v2 = actor ? null : R.v2Session(req, res);
      if (!actor && !(v2?.type === 'web' && v2.kind === 'passphrase')) throw new HttpError(401, 'auth', 'Sign in first.');
      if (actor) needWeb(actor, 'passphrase');
      needLoginKey();
      const b = actor ? input() : R.json(body);
      if (S.mode === 'released') {
        if (b.afresh !== true) needMode('new');
        await startAfresh(actor?.by ?? 'web', actor?.hash ?? null);
      } else needMode('new');
      if (!R.sqlite) throw new HttpError(503, 'node', 'Restock server needs Node 22.13 or newer.');
      const name = cleanName(b.name);
      if (!name) throw new HttpError(400, 'name', 'Give the house a name.');
      await house.create(name, R.origin(req), actor?.hash ?? null);
      R.note('set-up', { by: actor?.by ?? 'web', name });
      if (actor) return sealedAnswer(actor, 200, web.gift(actor.session), req, res);
      return R.send(req, res, 200, { ok: true, mode: S.mode, house: { name } });
    }

    // ---------- phones joining ----------
    if (path === '/api/v3/join' && method === 'POST') {
      needMode('v3');
      R.checkLock(ip);
      const told = String(req.headers['x-restock-app'] ?? '').trim().slice(0, 40);
      if (tooOldHere(told)) throw new HttpError(403, core.OLD_APP_ERROR, oldHereWords(), { min: minApp(), version: told });
      return R.send(req, res, 200, await joinPhone(R.json(body), ip));
    }
    if ((m = /^\/api\/v3\/devices\/([^/]+)$/.exec(path)) && method === 'DELETE') {
      needMode('v3');
      needPhone(actor);
      if (m[1] !== actor.device) throw new HttpError(403, 'forbidden', 'A phone can only take itself off.');
      house.leave(actor.device);
      web.endPhoneSessions(actor.device);
      R.endV2PhoneSessions(actor.device);
      R.forgetNonces(actor.device);
      await R.st.save();
      R.note('phone-left', { by: actor.device, name: actor.dev.label ?? actor.dev.name });
      return R.send(req, res, 200, { left: actor.device });
    }

    // From here on: the house.
    needMode('v3');

    // 0.18.0: a phone asks what it is on this server (an admin sees Phones and tablets in Settings → Sync).
    if (path === '/api/v3/me' && method === 'GET') {
      needPhone(actor);
      const admin = actor.dev.role === 'admin';
      // 0.18.3: an admin phone also hears of a newer server, and whether a yes is waiting (Server admin).
      return sealedAnswer(
        actor,
        200,
        { device: actor.device, role: admin ? 'admin' : 'user', label: actor.dev.label ?? actor.dev.name ?? null, server: R.VERSION, ...(admin ? { updates: updatesView(), waiting: R.approvals.list().length } : {}) },
        req,
        res,
      );
    }

    // ---------- files ----------
    if (path === '/api/v3/files' && method === 'GET') {
      if (!actor) throw new HttpError(401, 'auth', 'Sign in first.');
      if (actor.type === 'phone') needPhone(actor);
      const files = (await R.walk()).filter((f) => {
        const p = parseNameV3(f.name);
        // 0.18.4: phone backups aren't part of syncing: read by name (backups/<device>.bin).
        return p && p.kind !== 'backup' && canReadV3(actor, p);
      });
      return sealedAnswer(actor, 200, { files }, req, res);
    }
    if ((m = /^\/api\/v3\/files\/(.+)$/.exec(path))) {
      if (!actor) throw new HttpError(401, 'auth', 'Sign in first.');
      if (actor.type === 'phone') needPhone(actor);
      let name;
      try {
        name = decodeURIComponent(m[1]);
      } catch {
        name = '';
      }
      const parsed = parseNameV3(name);
      if (!parsed) throw new HttpError(400, 'name', "That isn't a Restock file name.");
      if (method === 'GET' || method === 'HEAD') {
        if (!canReadV3(actor, parsed)) throw new HttpError(404, 'not-found', "That file isn't on the server.");
        return R.serveFile(req, res, actor, name);
      }
      if (method === 'PUT' || method === 'DELETE') {
        if (!canWriteV3(actor, parsed)) throw new HttpError(403, 'forbidden', actor.type === 'web3' ? 'The web page can only write its own file.' : 'A phone can only write its own files.');
        if (method === 'DELETE') return R.send(req, res, 200, await R.deleteFile(actor, name, parsed));
        if (!bodyOkV3(parsed, body)) throw new HttpError(400, 'sealed', "That isn't a sealed Restock file.");
        // 0.9.5 (review): a browser's copy of a household that isn't this one (signed in before Delete
        // everything, or before the server was set up afresh) can't put its records in this one.
        if (actor.type === 'web3' && parsed.kind === 'sync' && !web.ofThisHouse(actor.session)) {
          throw new HttpError(409, 'household', "This browser's copy is of a household that's no longer on this server. Sign out, then sign in again.");
        }
        if (parsed.kind === 'photo' && !photoOk(parsed, body)) throw new HttpError(400, 'photo', "That photo doesn't match its name (or the server can't open it).");
        const out = await R.putFile(actor, name, parsed, body);
        if (parsed.kind === 'sync' || parsed.kind === 'archive') merger.queue(name);
        return R.send(req, res, 200, out);
      }
      throw new HttpError(405, 'method', 'Not allowed.');
    }

    // ---------- Server and phones ----------
    if (path === '/api/v3/phones' && method === 'GET') {
      needManager(actor, req, false);
      const backups = await backupFiles();
      const phones = Object.entries(S.devices)
        .map(([device, d]) => {
          const sum = summaryOf(device);
          return {
            device,
            label: d.label ?? house.memberRow(device)?.name ?? d.name,
            name: d.name,
            status: d.status ?? 'active',
            statusAt: iso(d.statusAt),
            added: iso(d.added),
            lastSeen: iso(d.lastSeen),
            version: sum?.summary?.version ?? null,
            // 0.15.0: on a version this server no longer syncs with (the web page says to update it).
            tooOld: !!core?.appTooOld?.(sum?.summary?.version),
            shares: R.engine.sharesOf(device),
            api: d.api ?? 2,
            role: d.role === 'admin' ? 'admin' : 'user',
            // 0.18.4: its latest backup on the server (backups/<device>.bin), if it keeps one.
            backup: backups.get(device) ?? null,
            ...(actor.type === 'phone' && device === actor.device ? { me: true } : {}),
          };
        })
        .sort((a, b) => String(a.added).localeCompare(String(b.added)));
      return sealedAnswer(actor, 200, { phones }, req, res);
    }
    if (path === '/api/v3/phones' && method === 'POST') {
      needManager(actor, req);
      if (actor.type === 'phone' && !sealedIn()) throw new HttpError(400, 'sealed', 'Update Restock to do that from this phone.');
      const b = input();
      const label = cleanName(b.label);
      if (!label) throw new HttpError(400, 'label', 'Give the phone a name, like "Sarah\'s phone".');
      // 0.18.0: a code for an admin: the passphrase on the web page, or an admin phone.
      // 0.18.4: a code that replaces a lost phone: the new one takes its place (its role, and its backup to restore).
      let replaces = null;
      if (b.replaces !== undefined && b.replaces !== null) {
        const old = typeof b.replaces === 'string' && DEVICE.test(b.replaces) ? S.devices[b.replaces] : null;
        if (!old || (old.status ?? 'active') !== 'active') throw new HttpError(404, 'not-found', "That phone isn't on this server.");
        if (actor.type === 'phone' && b.replaces === actor.device) throw new HttpError(400, 'replaces', "A phone can't make a code to replace itself.");
        replaces = b.replaces;
      }
      const role = replaces ? (S.devices[replaces].role === 'admin' ? 'admin' : 'user') : b.admin === true ? 'admin' : 'user';
      if (role === 'admin') needAdmin(actor, req);
      for (const [k, v] of invites) if (v.expires + V3_LIMITS.inviteKeptMs < now()) invites.delete(k);
      if ([...invites.values()].filter((v) => !v.used && v.expires >= now()).length >= V3_LIMITS.maxInvites) throw new HttpError(429, 'busy', 'Too many codes waiting. Use one or wait 10 minutes.');
      learnAddress(req, actor);
      const invite = b64u(randomBytes(32));
      // 0.18.3: a code that goes in a locked export file (Export data → Connections, from an admin
      // phone) lasts a day: the file may be opened on the new phone later. Still once only.
      const life = b.forExport === true ? 24 * 60 * MIN : V3_LIMITS.inviteMs;
      invites.set(b64u(R.sha256(Buffer.from(invite))), { expires: now() + life, used: false, label, role, ...(b.forExport === true ? { forExport: true } : {}), ...(replaces ? { replaces } : {}) });
      const p = new URLSearchParams();
      if (house.home()) p.set('h', house.home());
      if (house.away()) p.set('a', house.away());
      p.set('i', invite);
      p.set('k', house.kexPub());
      R.note('invite-made', { by: actor.by, label, ...(role === 'admin' ? { role } : {}), ...(replaces ? { replaces } : {}) });
      return sealedAnswer(actor, 200, { code: 'restock-server:3?' + p.toString(), expires: iso(now() + life), expiresIn: life / 1000, label, role, home: house.home(), away: house.away() }, req, res);
    }
    if ((m = /^\/api\/v3\/phones\/([^/]+)$/.exec(path)) && (method === 'PATCH' || method === 'DELETE')) {
      const fromPhone = actor?.type === 'phone';
      if (method === 'DELETE') needAdmin(actor, req);
      else needManager(actor, req);
      if (fromPhone && !sealedIn()) throw new HttpError(400, 'sealed', 'Update Restock to do that from this phone.');
      const device = m[1];
      const d = DEVICE.test(device) ? S.devices[device] : null;
      if (!d || (d.status && d.status !== 'active')) throw new HttpError(404, 'not-found', "That phone isn't on this server.");
      if (method === 'PATCH') {
        const b = input();
        const label = b.label === undefined ? undefined : cleanName(b.label);
        const role = b.role === undefined ? undefined : b.role === 'admin' ? 'admin' : b.role === 'user' ? 'user' : null;
        if (label === undefined && role === undefined) throw new HttpError(400, 'label', 'Give the phone a name.');
        if (label !== undefined && !label) throw new HttpError(400, 'label', 'Give the phone a name.');
        if (role === null) throw new HttpError(400, 'role', 'A phone is an admin or a user.');
        // 0.18.0: Make admin and Make user: the passphrase on the web page, or an admin phone.
        if (role !== undefined) needAdmin(actor, req);
        if (role === 'user' && d.role === 'admin') needNotLastAdmin(device);
        if (label !== undefined) {
          d.label = label;
          house.signMember(device, label, house.memberRow(device)?.pub ?? d.myPub ?? null);
          R.writeOwn();
        }
        if (role !== undefined && (d.role === 'admin' ? 'admin' : 'user') !== role) {
          if (role === 'admin') d.role = 'admin';
          else delete d.role;
          R.note('phone-role', { by: actor.by, device, role, name: d.label ?? d.name });
        }
        await R.st.save();
        if (label !== undefined) R.note('phone-renamed', { by: actor.by, device, label });
        return sealedAnswer(actor, 200, { device, label: d.label ?? d.name, role: d.role === 'admin' ? 'admin' : 'user' }, req, res);
      }
      // An admin phone takes itself off with Leave (Settings → Sync), not here.
      if (fromPhone && device === actor.device) throw new HttpError(403, 'forbidden', 'To take this phone off, use Leave this server.');
      if (d.role === 'admin') needNotLastAdmin(device);
      if (!fromPhone) needConfirm(actor, body.length ? input() : null, ip, 'remove-phone');
      // The answer to a phone is sealed with the key it asked with: the household's new one reaches it in keys/.
      const askedWith = K.keyv;
      house.remove(device);
      web.endPhoneSessions(device);
      R.endV2PhoneSessions(device);
      R.forgetNonces(device);
      await R.st.save();
      R.note('phone-removed', { by: actor.by, device, name: d.label ?? d.name });
      return sealedAnswer(actor, 200, { removed: device, keyv: Number(K.keyv) }, req, res, askedWith);
    }

    // ---------- settings ----------
    // 0.18.3: Data from an admin phone too (Server admin in the app), and its risky changes need a yes on a phone (needSure).
    const dataCtx = () => ({ req, res, ip, url, path, method, actor, body, input, needWeb: (a, k) => needAdminWeb(a, req, k), needConfirm: needSure, sealedAnswer });
    // 0.19.0: "Test both" on Addresses asks the server (the page's own rules only let it talk to
    // the address it was opened with, so its own test said "didn't answer" for every other one).
    if (path === '/api/v3/addresses/test' && method === 'POST') {
      needAdminWeb(actor, req);
      const b = input();
      const out = {};
      await Promise.all(
        ['home', 'away'].map(async (where) => {
          if (b[where] === undefined || b[where] === null || b[where] === '') return;
          const c = cleanAddress(b[where], where, R.isHomeAddress);
          out[where] = c.value ? await answersAsThis(c.value) : false;
        }),
      );
      return sealedAnswer(actor, 200, out, req, res);
    }
    if (path === '/api/v3/settings') {
      if (method === 'GET') {
        needAdminWeb(actor, req);
        return sealedAnswer(actor, 200, settingsView(), req, res);
      }
      if (method === 'PUT') {
        needAdminWeb(actor, req, 'passphrase');
        const b = input();
        const more = checkMoreSettings(b);
        let prune = false;
        // Checked before anything changes (review fix: a name in the same request was saved even
        // when the passphrase was then refused).
        if (b.keepMonths !== undefined) {
          // 0.9.5: Auto delete's values (off or 1–120 months); turning it on or keeping less deletes
          // what's older at once: the typed DELETE and the passphrase again first (data.mjs).
          if (b.keepMonths !== null && typeof b.keepMonths !== 'number') throw new HttpError(400, 'keepMonths', 'Auto delete after 1 to 120 months, or off.');
          R.data.autoDeleteGate(dataCtx(), b, b.keepMonths);
        }
        if (b.name !== undefined) {
          const name = cleanName(b.name);
          if (!name) throw new HttpError(400, 'name', 'Give the house a name.');
          S.house.name = name;
          R.engine.setMeta('name', name);
          R.engine.writeHousehold('name', name);
        }
        if (b.keepMonths !== undefined) {
          prune = b.keepMonths !== S.settings.keepMonths;
          S.settings.keepMonths = b.keepMonths;
          house.refreshServerRow();
        }
        applyMoreSettings(more, actor);
        await R.st.save();
        R.writeOwn();
        R.note('settings-changed', { by: actor.by, keepMonths: house.keepMonths() });
        if (prune) {
          const cut = house.cutoff(now());
          if (cut) await merger.pruneTo(cut);
        }
        return sealedAnswer(actor, 200, settingsView(), req, res);
      }
    }
    // 0.18.3: Server settings → Updates and moving: the server's log (no household data in it), and Restart.
    if (path === '/api/v3/server/log' && method === 'GET') {
      needAdminWeb(actor, req);
      const rows = merger.readLog('log', 2000, null);
      const text = rows.map((r) => `${r.at ?? ''} ${r.what ?? ''}${r.detail ? ' ' + JSON.stringify(r.detail) : ''}`).join('\n');
      R.note('server-log-downloaded', { by: actor.by });
      return sealedAnswer(actor, 200, { text: `Restock server ${R.VERSION} · ${S.mode} · ${new Date(now()).toISOString()}\n${text}\n`, lines: rows.length }, req, res);
    }
    if (path === '/api/v3/server/restart' && method === 'POST') {
      needAdminWeb(actor, req, 'passphrase');
      if (!inDocker()) throw new HttpError(409, 'restart', "This server doesn't run in Docker, so it wouldn't start again by itself. Restart it where it runs.");
      R.note('restarting', { by: actor.by });
      await R.st.save();
      sealedAnswer(actor, 200, { ok: true, back: 'in a few seconds' }, req, res);
      // Docker (restart: unless-stopped) starts it again.
      setTimeout(() => R.restart?.() ?? process.exit(0), 500).unref();
      return;
    }
    if (path === '/api/v3/server/updates' && method === 'GET') {
      needAdminWeb(actor, req);
      return sealedAnswer(actor, 200, updatesView(), req, res);
    }
    // 0.18.3: Server settings → Sign-in and security → User name (the passphrase stays the same).
    if (path === '/api/v3/username' && method === 'POST') {
      needAdminWeb(actor, req, 'passphrase');
      const b = input();
      const user = String(b.user ?? '').normalize('NFKC').trim();
      if (!user || user.length > 60 || /[\u0000-\u001f\u007f]/.test(user)) throw new HttpError(400, 'user', 'Give a user name (up to 60 letters).');
      needSure(actor, b, ip, 'user-name');
      const was = S.account.user;
      S.account.user = user;
      await R.st.save();
      R.note('user-name-changed', { by: actor.by, was });
      return sealedAnswer(actor, 200, { user }, req, res);
    }
    if (path === '/api/v3/prune' && method === 'POST') {
      needWeb(actor, 'passphrase');
      const b = input();
      const t = Date.parse(String(b.before ?? ''));
      if (!Number.isFinite(t) || t > now()) throw new HttpError(400, 'before', 'Pick a date in the past.');
      needSure(actor, b, ip, 'prune');
      // 0.9.5 (review): what it meant on 0.9.4: prices, receipts (and their photos and archive months)
      // and logs. Never the statistics (srv_spend: POST /api/v3/data/delete, with its typed word).
      const out = await merger.pruneTo(new Date(t).toISOString(), 'deleted-older', ['prices', 'receipts', 'logs']);
      R.note('pruned', { by: actor.by, before: new Date(t).toISOString() });
      return sealedAnswer(actor, 200, out, req, res);
    }

    // ---------- 0.18.4: each phone's backup ----------
    // A phone keeps its whole backup here (backups/<device>.bin, through /files), sealed to the
    // household's backup key: a P-256 key whose private half is sealed with a key from the passphrase,
    // so the server can't open them. Restoring (the web page's Download, or a new phone that replaces
    // a lost one) needs the passphrase.
    if (path === '/api/v3/backupkey' && method === 'GET') {
      if (!actor) throw new HttpError(401, 'auth', 'Sign in first.');
      const k = S.backupKey ?? null;
      if (actor.type === 'phone') {
        needPhone(actor);
        const full = actor.dev.role === 'admin' || !!actor.dev.restoreFrom;
        return sealedAnswer(actor, 200, k ? { pub: k.pub, at: k.at, ...(full ? { sealed: k.sealed, salt: S.account?.salt ?? null } : {}) } : {}, req, res);
      }
      needWeb(actor, 'passphrase');
      return sealedAnswer(actor, 200, k ? { pub: k.pub, at: k.at, sealed: k.sealed } : {}, req, res);
    }
    if (path === '/api/v3/backupkey' && method === 'PUT') {
      if (actor?.type === 'phone') needAdminWeb(actor, req, 'passphrase');
      else needWeb(actor, 'passphrase');
      const b = input();
      const pub = p256Str(b.pub);
      const sealed = cleanSealedKey(b.sealed);
      if (!pub || !sealed) throw new HttpError(400, 'bad-request', "That isn't a backup key.");
      if (S.backupKey && b.replace !== true) throw new HttpError(409, 'backup-key', 'Phone backups are already on.');
      needSure(actor, b, ip, 'backup-key');
      S.backupKey = { pub, sealed, at: iso(now()) };
      await R.st.save();
      R.note('phone-backups-on', { by: actor.by });
      return sealedAnswer(actor, 200, { pub, at: S.backupKey.at }, req, res);
    }
    if (path === '/api/v3/restore' && method === 'GET') {
      needPhone(actor);
      const from = actor.dev.restoreFrom;
      if (!from) return sealedAnswer(actor, 200, {}, req, res);
      const old = S.devices[from];
      const backup = (await backupFiles()).get(from) ?? null;
      const k = S.backupKey;
      return sealedAnswer(
        actor,
        200,
        { from, label: old ? (old.label ?? house.memberRow(from)?.name ?? old.name ?? null) : null, backup, ...(k ? { key: { pub: k.pub, sealed: k.sealed, salt: S.account?.salt ?? null } } : {}) },
        req,
        res,
      );
    }
    if (path === '/api/v3/restore' && method === 'POST') {
      needPhone(actor);
      const from = actor.dev.restoreFrom;
      if (!from) throw new HttpError(409, 'restore', 'This phone has nothing to restore.');
      const b = input();
      delete actor.dev.restoreFrom;
      const old = S.devices[from];
      // Taking the lost phone off gives the household a new key: the answer is sealed with the one this phone asked with.
      const askedWith = K.keyv;
      // Restored (not skipped): the lost phone is taken off, as Remove does.
      if (b.skip !== true && old && (old.status ?? 'active') === 'active' && from !== actor.device) {
        house.remove(from);
        web.endPhoneSessions(from);
        R.endV2PhoneSessions(from);
        R.forgetNonces(from);
        R.note('phone-removed', { by: actor.by, device: from, name: old.label ?? old.name, why: 'replaced' });
      }
      await R.st.save();
      return sealedAnswer(actor, 200, { ok: true, keyv: Number(K.keyv) }, req, res, askedWith);
    }
    if ((m = /^\/api\/v3\/phone-backup\/([A-Za-z0-9_-]{1,64})$/.exec(path))) {
      needWeb(actor, 'passphrase');
      const name = `backups/${m[1]}.bin`;
      if (method === 'POST') {
        const b = input();
        if (!(await backupFiles()).has(m[1])) throw new HttpError(404, 'not-found', "That phone hasn't kept a backup here.");
        needSure(actor, b, ip, 'phone-backup');
        const token = b64u(randomBytes(24));
        for (const [k, v] of backupTokens) if (v.until < now()) backupTokens.delete(k);
        backupTokens.set(token, { device: m[1], hash: actor.hash, until: now() + 2 * MIN });
        R.note('phone-backup-downloaded', { by: actor.by, device: m[1] });
        return sealedAnswer(actor, 200, { token, key: S.backupKey ? { sealed: S.backupKey.sealed } : null }, req, res);
      }
      if (method === 'GET') {
        const t = backupTokens.get(String(url.searchParams.get('t') ?? ''));
        if (!t || t.until < now() || t.device !== m[1] || t.hash !== actor.hash) throw new HttpError(403, 'token', 'That download has run out. Try again.');
        backupTokens.delete(String(url.searchParams.get('t')));
        return R.serveFile(req, res, actor, name);
      }
      throw new HttpError(405, 'method', 'Not allowed.');
    }

    // ---------- the passphrase, the recovery key, the backup ----------
    if (path === '/api/v3/passphrase' && method === 'POST') {
      // 0.18.4: an admin phone can change it too (Server admin → Passphrase): it proves the current one
      // over its own id, and being an admin phone is the yes.
      const fromPhone = actor?.type === 'phone';
      if (fromPhone) needAdminWeb(actor, req, 'passphrase');
      else needWeb(actor, 'passphrase');
      R.checkLock(ip);
      const b = input({ sealedOnly: true });
      const a = S.account;
      if (!a?.loginKey) throw new HttpError(409, 'no-passphrase', 'This server has no passphrase yet. Set it up on the web page.');
      // 0.18.3: then a yes on an admin phone; sent again with `approved` (and the same new passphrase).
      const approved = !fromPhone && typeof b.approved === 'string' && R.approvals.take(b.approved, actor.hash, 'passphrase');
      if (!fromPhone && typeof b.approved === 'string' && !approved) throw new HttpError(403, 'approve-expired', 'That yes from the phone has run out. Try again.');
      if (!approved) {
        const okC = web.useChallenge(b.c);
        const want = core.loginProof(Buffer.from(a.loginKey, 'base64url'), String(b.c ?? ''), fromPhone ? 'phone:' + actor.device : actor.sid);
        if (!okC || !R.same(String(b.proof ?? ''), want)) {
          R.failed(ip, 'passphrase');
          R.note('passphrase-change-refused', { by: actor.by, ip: R.mask(ip) });
          throw new HttpError(403, 'current', "That isn't the current passphrase.");
        }
      }
      const salt = typeof b.salt === 'string' ? Buffer.from(b.salt, 'base64url') : null;
      if (!salt || salt.length < 16 || salt.length > 32) throw new HttpError(400, 'bad-request', 'The salt must be 16-32 random bytes.');
      const auth = typeof b.auth === 'string' ? Buffer.from(b.auth, 'base64url') : null;
      if (!auth || auth.length !== 32) throw new HttpError(400, 'bad-request', 'The auth key must be 32 bytes.');
      if (!fromPhone && !approved && R.approvals.needed()) throw new HttpError(403, 'approve', 'Say yes on an admin phone.', { approve: R.approvals.start('passphrase', actor.hash, actor.session, R.mask(ip)) });
      // 0.18.4: the phone backups' key, sealed with the new passphrase (the page or phone opened it with the old one).
      if (S.backupKey) {
        const sealed = cleanSealedKey(b.backupSealed);
        if (!sealed) throw new HttpError(400, 'backup-key', "The phone backups' key has to come too. Reload the page (or update Restock on this phone) and try again.");
        S.backupKey = { ...S.backupKey, sealed, at: iso(now()) };
      }
      await R.setPassphrase(b.salt, auth);
      // Everyone else is signed out; this browser carries on (from a phone: every browser is signed out).
      for (const k of Object.keys(S.sessions3)) if (fromPhone || k !== actor.hash) delete S.sessions3[k];
      R.endV2Sessions();
      await R.st.save();
      R.note('passphrase-changed', { by: actor.by });
      return sealedAnswer(actor, 200, { ok: true }, req, res);
    }
    if (path === '/api/v3/recovery') {
      needAdminWeb(actor, req, 'passphrase');
      // GET says only whether it was saved; the key itself needs the passphrase again (POST { confirm }).
      if (method === 'GET') return sealedAnswer(actor, 200, { saved: !!K.recoverySaved }, req, res);
      if (method === 'POST') {
        const b = input();
        if (b.confirm !== undefined || b.approved !== undefined) {
          needSure(actor, b, ip, 'recovery-key');
          R.note('recovery-key-shown', { by: actor.by });
          return sealedAnswer(actor, 200, { recovery: core.formatRecovery(core.unbase32(K.recovery)), saved: !!K.recoverySaved }, req, res);
        }
        if (b.saved === true) {
          K.recoverySaved = true;
          R.keys.save();
        }
        return sealedAnswer(actor, 200, { saved: !!K.recoverySaved }, req, res);
      }
    }
    if (path === '/api/v3/backup' && method === 'POST') {
      needWeb(actor, 'passphrase');
      const b = input({ sealedOnly: true });
      const pass = String(b.passphrase ?? '');
      const c = checkPassphrase(pass, S.account?.user ?? '');
      if (!c.ok) throw new HttpError(400, 'weak', c.reason);
      needConfirm(actor, b, ip, 'backup');
      return backup(req, res, actor, pass);
    }

    // ---------- activity and logs ----------
    if ((path === '/api/v3/activity' || path === '/api/v3/logs') && method === 'GET') {
      needAdminWeb(actor, req);
      const limit = Math.min(2000, Math.max(1, Number(url.searchParams.get('limit')) || 300));
      const before = url.searchParams.get('before');
      const kind = path.endsWith('activity') ? 'activity' : 'log';
      const names = Object.fromEntries(Object.entries(S.devices).map(([k, d]) => [k, d.label ?? d.name]));
      const rows = merger.readLog(kind, limit, before && before.length <= 40 ? before : null).map((r) => ({
        ...r,
        who: !r.device ? null : r.device.startsWith('web-') ? 'Web page' : r.device.startsWith('srv-') ? 'The server' : (names[r.device] ?? 'A removed phone'),
      }));
      return sealedAnswer(actor, 200, kind === 'activity' ? { activity: rows } : { logs: rows }, req, res);
    }

    // ---------- Home Assistant ----------
    if (path === '/api/v3/homeassistant') {
      if (method === 'GET') {
        needAdminWeb(actor, req);
        return sealedAnswer(actor, 200, ha.view(), req, res);
      }
      if (method === 'PUT') {
        needAdminWeb(actor, req, 'passphrase');
        const out = ha.set(input(), sealedIn());
        R.note('home-assistant-changed', { by: actor.by, enabled: out.enabled });
        return sealedAnswer(actor, 200, out, req, res);
      }
    }
    if (path === '/api/v3/homeassistant/test' && method === 'POST') {
      needAdminWeb(actor, req, 'passphrase');
      return sealedAnswer(actor, 200, await ha.test(input(), sealedIn()), req, res);
    }
    if (path === '/api/v3/homeassistant/sync' && method === 'POST') {
      needAdminWeb(actor, req);
      const r = await ha.round('now');
      return sealedAnswer(actor, 200, r.ok ? { ok: true, came: r.came, went: r.went, held: !!r.held } : { ok: false, message: r.message }, req, res);
    }

    // ---------- 0.9.5: the Data tab (data.mjs) ----------
    if (path.startsWith('/api/v3/data/')) return R.data.api(dataCtx());

    throw new HttpError(404, 'not-found', 'Not found.');
  }

  // ---------- joining ----------

  async function joinPhone(b, ip) {
    const device = String(b.device ?? '');
    if (!DEVICE.test(device) || reservedDevice(device)) throw new HttpError(400, 'device', "That device id won't work.");
    const pub = p256Str(b.pub);
    const kex = p256Str(b.kex);
    const n = nOf(b.n);
    if (!pub) throw new HttpError(400, 'pub', "The phone's key isn't a P-256 public key.");
    if (!kex) throw new HttpError(400, 'kex', "The phone's kex key isn't a P-256 public key.");
    if (!n) throw new HttpError(400, 'n', 'n must be 16 random bytes.');
    if (joinNonces.has(b.n)) throw new HttpError(401, 'replay', 'That request was already used.');
    if (joinNonces.size > V3_LIMITS.maxJoinNonces) joinNonces.clear();
    const was = S.devices[device];
    const taken = () => {
      if (was && (was.status ?? 'active') === 'active' && !R.sameKey(was.pub, pub)) {
        throw new HttpError(409, 'device-taken', 'That phone is already on this server. Remove it on the Server and phones page first, then add it again.');
      }
    };
    const activeCount = Object.values(S.devices).filter((d) => (d.status ?? 'active') === 'active').length;
    if (!(was && (was.status ?? 'active') === 'active') && activeCount >= R.LIMITS.maxDevices) throw new HttpError(507, 'full', 'This server has as many phones as it takes.');

    if (b.member === true) {
      const row = house.memberRow(device);
      const sig = typeof b.sig === 'string' && b.sig.length <= 200 ? b.sig : '';
      const ok = !!row?.pub && core.verifySig(row.pub, core.memberJoinText({ device, pub: b.pub, kex: b.kex, n: b.n }), sig);
      if (!ok) {
        R.failed(ip, 'member-join');
        R.note('member-join-refused', { device, ip: R.mask(ip) });
        throw new HttpError(401, 'member', "This phone isn't a member of the household on this server.");
      }
      if (R.engine.householdValue('removed:' + device) !== null) throw new HttpError(401, 'removed', 'This phone was removed from the household.');
      taken();
      joinNonces.set(b.n, now());
      const label = cleanName(row.name) || 'Phone';
      const keepRole = was && (was.status ?? 'active') === 'active' && was.role === 'admin';
      const secret = house.admit(device, { name: label, pub, kex, myPub: row.pub, label });
      if (keepRole) S.devices[device].role = 'admin';
      await R.st.save();
      R.writeOwn();
      R.note('phone-joined', { by: device, label, how: 'member' });
      return { sealed: house.sealGift(device, kex, n, house.joinGift(device, label, false, secret)) };
    }

    const inv = typeof b.invite === 'string' && b.invite.length <= 100 ? invites.get(b64u(R.sha256(Buffer.from(b.invite)))) : null;
    if (!inv) {
      R.failed(ip, 'invite');
      throw new HttpError(401, 'invite', "That code isn't from this server. Ask an admin to make a new one.");
    }
    if (inv.used) throw new HttpError(410, 'used', 'That code was already used: each one adds one phone. Ask an admin to make a new one (Settings → Sync → Server admin → Add a phone or tablet).');
    if (inv.expires < now()) throw new HttpError(410, 'expired', inv.forExport ? 'The code in that file has run out (it lasts a day). Ask an admin for a new one (Settings → Sync → Server admin → Add a phone or tablet).' : 'That code has expired (they last 10 minutes). Ask an admin to make a new one (Settings → Sync → Server admin → Add a phone or tablet).');
    const myPub = p256Str(b.myPub);
    if (!myPub) throw new HttpError(400, 'myPub', "The phone's household key isn't a P-256 public key.");
    taken();
    let seed = !S.house.seeded;
    if (b.bring !== undefined) {
      // A phone household brought onto a new, empty server (section 7): its owner hands it over here.
      if (S.house.seeded) throw new HttpError(409, 'not-empty', 'This server already has a household. Join it, or leave yours first.');
      let payload;
      try {
        const key = core.handoverKey(house.kexPriv(), core.unb64(String(b.bring.epub)), core.unb64(b.invite));
        payload = core.openHandover(key, core.unb64(String(b.bring.sealed)));
      } catch {
        throw new HttpError(400, 'sealed', "That household couldn't be opened. Scan the server's code again.");
      }
      let c;
      try {
        c = house.checkPayload(payload, device, null);
      } catch (e) {
        if (!e.handover) throw e;
        throw new HttpError(409, 'handover', "The server couldn't check the household this phone sent. Nothing changed.");
      }
      inv.used = true;
      await house.bring(c, device);
      seed = false;
    }
    inv.used = true;
    joinNonces.set(b.n, now());
    S.house.seeded = true;
    const name = cleanName(b.name) || 'Phone';
    const secret = house.admit(device, { name, pub, kex, myPub, label: inv.label });
    // 0.18.0: an admin's code makes an admin; any other code, a user.
    if (inv.role === 'admin') S.devices[device].role = 'admin';
    // 0.18.4: replacing a lost phone: this one may read its backup (and takes it off once restored).
    if (inv.replaces && S.devices[inv.replaces] && inv.replaces !== device) S.devices[device].restoreFrom = inv.replaces;
    await R.st.save();
    R.writeOwn();
    R.note('phone-joined', { by: device, label: inv.label, how: b.bring !== undefined ? 'bring' : 'invite' });
    return { sealed: house.sealGift(device, kex, n, house.joinGift(device, inv.label, seed, secret)) };
  }

  // ---------- starting afresh (after the household was taken back) ----------

  async function startAfresh(by, keep) {
    R.closeDb();
    // 0.9.5 (review): as Delete everything: the other browsers' copies are of the household that's gone.
    web.endAllBut(keep);
    for (const name of R.listFileNames()) await R.trashFile(name, by, 'started afresh');
    for (const f of ['household.db', 'household.db-wal', 'household.db-shm']) await fs.rm(join(R.DATA, f), { force: true });
    R.keys.clearHouse();
    S.devices = Object.create(null);
    S.removedDevices = [];
    delete S.releasedBy;
    delete S.handoverFrom;
    S.house = null;
    S.mode = 'new';
    await R.st.save();
  }

  // ---------- the backup download ----------

  let backingUp = false;
  async function backup(req, res, actor, pass) {
    if (backingUp) throw new HttpError(429, 'busy', 'A backup is already being made. Try again in a minute.', { retryAfter: 60 });
    backingUp = true;
    const snap = join(R.TMP, 'household-' + randomBytes(6).toString('hex') + '.db');
    try {
      merger.settle();
      merger.raw().exec(`VACUUM INTO '${snap.replace(/'/g, "''")}'`);
      const state = JSON.parse(JSON.stringify(S));
      state.sessions = {};
      state.sessions3 = {};
      const entries = [
        { name: 'state.json', data: Buffer.from(JSON.stringify(state)) },
        { name: 'keys.json', data: Buffer.from(JSON.stringify(K)) },
        { name: 'household.db', path: snap },
        ...R.listFileNames().map((n) => ({ name: 'files/' + n, path: join(R.FILES, ...n.split('/')) })),
      ];
      const stream = await backupStream(entries, pass);
      const day = new Date(now()).toISOString().slice(0, 10);
      R.note('backup-downloaded', { by: actor.by });
      await R.sendStream(req, res, stream, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': `attachment; filename="restock-server-${day}.rsb"` });
    } finally {
      backingUp = false;
      await fs.rm(snap, { force: true });
    }
  }

  return { api, close, invites };
}

export { DAY };
