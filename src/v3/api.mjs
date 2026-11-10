// 0.9.4: API v3 (docs/server-v3-design.md section 5, docs/server-protocol.md "v3"). Every endpoint
// says who may call it: a phone (Restock2, signed with its key, as v2), a browser session (RestockWeb3,
// every request MACed, household data sealed), or anyone (health, sign-in, joining, which carry their
// own proof). Built by makeServer with the helpers it shares with v2 (R).

import { randomBytes, createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { openKeys, makeHouse } from './house.mjs';
import { makeMerger } from './merge.mjs';
import { makeWebAuth, SEALED } from './webauth.mjs';
import { makeHa } from './ha.mjs';
import { makeData } from './data.mjs';
import { makeSearch } from './search.mjs';
import { backupStream } from './backup.mjs';
import { parseNameV3, canWriteV3, canReadV3, bodyOkV3, reservedDevice, DEVICE } from '../names.mjs';
import { checkPassphrase } from '../../public/setup/strength.js';

const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const b64u = (b) => Buffer.from(b).toString('base64url');
const V3_LIMITS = { inviteMs: 10 * MIN, handoverMs: 10 * MIN, maxInvites: 20, maxJoinNonces: 5000 };

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
  R.ha = makeHa(R);
  R.data = makeData(R);
  R.search = makeSearch(R);
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

  const invites = new Map(); // sha256(invite) -> { expires, used, label }
  const handovers = new Map(); // sha256(token) -> { expires }
  const joinNonces = new Map(); // n -> at

  // ---------- on start ----------
  const recovered = await house.recoverHandover();
  if (S.mode === 'v3' || S.mode === 'released') {
    if (!R.engine) await R.openDb({});
    if (house.refreshServerRow()) R.note('server-row-updated', {});
    R.mergeEverything({});
    R.writeOwn();
    if (K.ha?.enabled) ha.start();
  }
  if (recovered) R.log('Restock server: a handover that stopped part-way was ' + (recovered === 'finished' ? 'finished.' : 'rolled back (the owner phone can try again).'));

  const timers = [
    setInterval(() => {
      const t = now();
      for (const [k, v] of invites) if (v.expires < t) invites.delete(k);
      for (const [k, v] of handovers) if (v.expires < t) handovers.delete(k);
      for (const [k, v] of joinNonces) if (t - v > 11 * MIN) joinNonces.delete(k);
      web.prune();
    }, MIN),
    setInterval(() => void merger.daily().catch((e) => R.log('daily:', e.message)), 60 * MIN),
  ];
  for (const t of timers) t.unref();
  setTimeout(() => void merger.daily().catch((e) => R.log('daily:', e.message)), 30_000).unref();

  function close() {
    for (const t of timers) clearInterval(t);
    ha.stop();
    merger.settle();
    R.closeDb();
  }

  // ---------- helpers ----------

  const iso = (t) => (t ? new Date(t).toISOString() : null);
  const sealedAnswer = (actor, status, obj, req, res) => {
    if (actor?.type === 'web3') return R.send(req, res, status, web.seal(actor.session.key, obj), SEALED);
    return R.send(req, res, status, obj);
  };
  function needMode(...modes) {
    if (!modes.includes(S.mode)) {
      if (S.mode === 'released') throw new HttpError(409, 'released', `Your household was taken back by ${S.releasedBy ?? 'a phone'}. Start the server afresh from its web page.`);
      throw new HttpError(409, 'mode', S.mode === 'v2' ? 'This server still keeps a 0.9.3 household. Hand it to the server from the owner phone first.' : 'Set up this server first.', { mode: S.mode });
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
    const want = a?.loginKey ? core.loginProof(Buffer.from(a.loginKey, 'base64url'), String(c.c ?? ''), actor.sid) : '';
    if (!okC || !want || !R.same(String(c.proof ?? ''), want)) {
      R.failed(ip, 'confirm');
      R.note('confirm-refused', { by: actor.by, what, ip: R.mask(ip) });
      if (!okC) throw new HttpError(403, 'confirm', 'That took too long. Type your passphrase again.');
      throw new HttpError(403, 'current', "That isn't the current passphrase.");
    }
    R.clearFails(ip);
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
  function checkPhone(req, ph, body) {
    R.verifyPhone(req, ph.f, ph.dev.pub, body);
    if (ph.dev.status && ph.dev.status !== 'active') {
      throw new HttpError(401, 'removed', ph.dev.status === 'left' ? 'This phone left the household on the server.' : 'This phone was removed from the server.');
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
    const actor = ph ? checkPhone(req, ph, body) : wh ? web.check(req, wh, body) : null;
    if (actor?.type === 'web3') actor.sid = wh.f.s;
    const input = (opts) => web.body(actor, req, body, opts);
    const sealedIn = () => String(req.headers['content-type'] || '').startsWith(SEALED);
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
      needWeb(actor);
      return sealedAnswer(actor, 200, { browsers: web.list(actor.hash) }, req, res);
    }
    if ((m = /^\/api\/v3\/browsers\/([^/]+)$/.exec(path)) && method === 'DELETE') {
      needWeb(actor);
      const k = web.byId(m[1]);
      if (!k) throw new HttpError(404, 'not-found', "That browser isn't signed in.");
      web.endSession(k);
      await R.st.save();
      R.note('browser-signed-out', { by: actor.by });
      return sealedAnswer(actor, 200, { ok: true, ended: m[1] }, req, res);
    }

    // ---------- Sign in with a phone ----------
    if (path === '/api/v3/qrlogin' && method === 'POST') {
      needMode('v3');
      if (!S.account) throw new HttpError(409, 'setup', 'Set up the server first.');
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

    // ---------- the handover from an owner phone (section 7) ----------
    if (path === '/api/v3/handover' && method === 'POST') {
      const v2 = actor ? null : R.v2Session(req, res);
      if (!actor && !(v2?.type === 'web' && v2.kind === 'passphrase')) throw new HttpError(401, 'auth', 'Sign in first.');
      if (actor) needWeb(actor, 'passphrase');
      needMode('v2');
      needLoginKey();
      if (!R.sqlite) throw new HttpError(503, 'node', 'Restock server needs Node 22.13 or newer.');
      const t = b64u(randomBytes(32));
      handovers.clear(); // one code at a time
      handovers.set(b64u(R.sha256(Buffer.from(t))), { expires: now() + V3_LIMITS.handoverMs });
      const p = new URLSearchParams({ u: R.origin(req) ?? '', t, k: house.kexPub() });
      R.note('handover-code', { by: actor?.by ?? v2.by });
      const out = { token: t, code: 'restock-handover:3?' + p.toString(), expires: iso(now() + V3_LIMITS.handoverMs), expiresIn: V3_LIMITS.handoverMs / 1000 };
      return actor ? sealedAnswer(actor, 200, out, req, res) : R.send(req, res, 200, out);
    }
    if ((m = /^\/api\/v3\/handover\/([^/]+)$/.exec(path)) && method === 'POST') {
      needPhone(actor, false);
      if (S.mode === 'v3') throw new HttpError(409, 'done', 'This household already lives on the server.');
      needMode('v2');
      const tok = m[1];
      const h = /^[A-Za-z0-9_-]{40,64}$/.test(tok) ? handovers.get(b64u(R.sha256(Buffer.from(tok)))) : null;
      if (!h || h.expires < now()) throw new HttpError(h ? 410 : 404, h ? 'expired' : 'not-found', h ? 'That code has expired. Make a new one on the web page.' : "That code isn't on this server.");
      handovers.delete(b64u(R.sha256(Buffer.from(tok))));
      const b = R.json(body);
      let payload;
      try {
        const key = core.handoverKey(house.kexPriv(), core.unb64(String(b.epub)), core.unb64(tok));
        payload = core.openHandover(key, core.unb64(String(b.sealed)));
      } catch {
        throw new HttpError(400, 'sealed', "That handover couldn't be opened. Scan the server's code again.");
      }
      let c;
      try {
        const own = await fs.readFile(join(R.FILES, `restock-sync-${actor.device}.bin`)).catch(() => null);
        if (!own) throw Object.assign(new Error("the owner phone's file isn't here"), { handover: true });
        c = house.checkPayload(payload, actor.device, own);
      } catch (e) {
        if (!e.handover) throw e;
        R.note('handover-refused', { by: actor.device, why: e.message });
        throw new HttpError(409, 'handover', "The server couldn't check this household with what the phone sent. Nothing changed. Sync this phone with the server, then try again.");
      }
      const wasHouse = S.house;
      try {
        await house.commitHandover(c, actor.device);
      } catch (e) {
        // Stopped before the mode changed: rolled back now, as a restart would (the phone is still the
        // owner and can try again), not left running in v2 with the house's keys and a half-built db.
        if (S.mode !== 'v3') {
          await house.recoverHandover();
          S.house = wasHouse;
          await R.st.save();
        }
        throw e;
      }
      S.handoverFrom = actor.device;
      await R.st.save();
      return R.send(req, res, 200, { ok: true, mode: S.mode, sid: S.sid, house: S.house.name });
    }

    // ---------- phones joining ----------
    if (path === '/api/v3/join' && method === 'POST') {
      needMode('v3');
      R.checkLock(ip);
      return R.send(req, res, 200, await joinPhone(R.json(body), ip));
    }
    if (path === '/api/v3/upgrade' && method === 'POST') {
      needMode('v3');
      needPhone(actor, false);
      return R.send(req, res, 200, upgrade(actor, R.json(body)));
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

    // ---------- files ----------
    if (path === '/api/v3/files' && method === 'GET') {
      if (!actor) throw new HttpError(401, 'auth', 'Sign in first.');
      if (actor.type === 'phone') needPhone(actor);
      const files = (await R.walk()).filter((f) => {
        const p = parseNameV3(f.name);
        return p && canReadV3(actor, p);
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
      needWeb(actor);
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
            shares: R.engine.sharesOf(device),
            api: d.api ?? 2,
          };
        })
        .sort((a, b) => String(a.added).localeCompare(String(b.added)));
      return sealedAnswer(actor, 200, { phones }, req, res);
    }
    if (path === '/api/v3/phones' && method === 'POST') {
      needWeb(actor);
      const b = input();
      const label = cleanName(b.label);
      if (!label) throw new HttpError(400, 'label', 'Give the phone a name, like "Sarah\'s phone".');
      for (const [k, v] of invites) if (v.expires < now()) invites.delete(k);
      if ([...invites.values()].filter((v) => !v.used).length >= V3_LIMITS.maxInvites) throw new HttpError(429, 'busy', 'Too many codes waiting. Use one or wait 10 minutes.');
      // Without RESTOCK_HOME_URL / RESTOCK_AWAY_URL, the addresses this page is opened with (as v2's
      // invites): a home one is where phones find the house at home, any other one is away.
      const here = R.origin(req);
      if (here) {
        let host = '';
        try {
          host = new URL(here).hostname.replace(/^\[|\]$/g, '');
        } catch {
          host = '';
        }
        const loop = /^(localhost|127\.|::1$)/.test(host);
        const atHome = !loop && (R.isHomeAddress(host) || /\.(local|lan|home\.arpa)$/i.test(host));
        if (atHome && !R.cfg.homeUrl) S.house.home = here;
        else if (!loop && !atHome && !R.cfg.awayUrl) S.house.away = here;
        if (house.refreshServerRow()) R.writeOwn();
      }
      const invite = b64u(randomBytes(32));
      invites.set(b64u(R.sha256(Buffer.from(invite))), { expires: now() + V3_LIMITS.inviteMs, used: false, label });
      const p = new URLSearchParams();
      if (house.home()) p.set('h', house.home());
      if (house.away()) p.set('a', house.away());
      p.set('i', invite);
      p.set('k', house.kexPub());
      R.note('invite-made', { by: actor.by, label });
      return sealedAnswer(actor, 200, { code: 'restock-server:3?' + p.toString(), expires: iso(now() + V3_LIMITS.inviteMs), expiresIn: V3_LIMITS.inviteMs / 1000, label, home: house.home(), away: house.away() }, req, res);
    }
    if ((m = /^\/api\/v3\/phones\/([^/]+)$/.exec(path)) && (method === 'PATCH' || method === 'DELETE')) {
      needWeb(actor, method === 'DELETE' ? 'passphrase' : undefined);
      const device = m[1];
      const d = DEVICE.test(device) ? S.devices[device] : null;
      if (!d || (d.status && d.status !== 'active')) throw new HttpError(404, 'not-found', "That phone isn't on this server.");
      if (method === 'PATCH') {
        const label = cleanName(input().label);
        if (!label) throw new HttpError(400, 'label', 'Give the phone a name.');
        d.label = label;
        house.signMember(device, label, house.memberRow(device)?.pub ?? d.myPub ?? null);
        R.writeOwn();
        await R.st.save();
        R.note('phone-renamed', { by: actor.by, device, label });
        return sealedAnswer(actor, 200, { device, label }, req, res);
      }
      needConfirm(actor, body.length ? input() : null, ip, 'remove-phone');
      house.remove(device);
      web.endPhoneSessions(device);
      R.endV2PhoneSessions(device);
      R.forgetNonces(device);
      await R.st.save();
      R.note('phone-removed', { by: actor.by, device, name: d.label ?? d.name });
      return sealedAnswer(actor, 200, { removed: device, keyv: Number(K.keyv) }, req, res);
    }

    // ---------- settings ----------
    const dataCtx = () => ({ req, res, ip, url, path, method, actor, body, input, needWeb, needConfirm, sealedAnswer });
    if (path === '/api/v3/settings') {
      if (method === 'GET') {
        needWeb(actor);
        return sealedAnswer(actor, 200, { name: S.house.name, keepMonths: house.keepMonths(), autoDelete: house.keepMonths(), webSearch: R.search.enabled() }, req, res);
      }
      if (method === 'PUT') {
        needWeb(actor, 'passphrase');
        const b = input();
        let prune = false;
        // Checked before anything changes (review fix: a name in the same request was saved even
        // when the passphrase was then refused).
        if (b.keepMonths !== undefined) {
          // 0.9.5: Auto delete's values (off or 1–120 months); turning it on or keeping less deletes
          // what's older at once: the typed DELETE and the passphrase again first (data.mjs).
          if (b.keepMonths !== null && typeof b.keepMonths !== 'number') throw new HttpError(400, 'keepMonths', 'Auto delete after 1 to 120 months, or off.');
          R.data.autoDeleteGate(dataCtx(), b, b.keepMonths);
        }
        // 0.9.5: "Let the web page search the shops" (search.mjs), on or off.
        if (b.webSearch !== undefined && typeof b.webSearch !== 'boolean') throw new HttpError(400, 'webSearch', 'Turn Let the web page search the shops on or off.');
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
        const searchWas = R.search.enabled();
        if (b.webSearch !== undefined) R.search.setEnabled(b.webSearch);
        await R.st.save();
        R.writeOwn();
        R.note('settings-changed', { by: actor.by, keepMonths: house.keepMonths() });
        if (R.search.enabled() !== searchWas) R.note(R.search.enabled() ? 'web-search-on' : 'web-search-off', { by: actor.by });
        if (prune) {
          const cut = house.cutoff(now());
          if (cut) await merger.pruneTo(cut);
        }
        return sealedAnswer(actor, 200, { name: S.house.name, keepMonths: house.keepMonths(), autoDelete: house.keepMonths(), webSearch: R.search.enabled() }, req, res);
      }
    }
    // ---------- 0.9.5: Let the web page search the shops (search.mjs) ----------
    if (path === '/api/v3/search' && method === 'POST') {
      needWeb(actor);
      return sealedAnswer(actor, 200, await R.search.search(actor, input()), req, res);
    }
    if (path === '/api/v3/search/add' && method === 'POST') {
      needWeb(actor);
      return sealedAnswer(actor, 200, R.search.add(actor, input()), req, res);
    }
    if (path === '/api/v3/prune' && method === 'POST') {
      needWeb(actor, 'passphrase');
      const b = input();
      const t = Date.parse(String(b.before ?? ''));
      if (!Number.isFinite(t) || t > now()) throw new HttpError(400, 'before', 'Pick a date in the past.');
      needConfirm(actor, b, ip, 'prune');
      // 0.9.5 (review): what it meant on 0.9.4: prices, receipts (and their photos and archive months)
      // and logs. Never the statistics (srv_spend: POST /api/v3/data/delete, with its typed word).
      const out = await merger.pruneTo(new Date(t).toISOString(), 'deleted-older', ['prices', 'receipts', 'logs']);
      R.note('pruned', { by: actor.by, before: new Date(t).toISOString() });
      return sealedAnswer(actor, 200, out, req, res);
    }

    // ---------- the passphrase, the recovery key, the backup ----------
    if (path === '/api/v3/passphrase' && method === 'POST') {
      needWeb(actor, 'passphrase');
      R.checkLock(ip);
      const b = input({ sealedOnly: true });
      const a = S.account;
      const okC = web.useChallenge(b.c);
      const want = core.loginProof(Buffer.from(a.loginKey, 'base64url'), String(b.c ?? ''), actor.sid);
      if (!okC || !R.same(String(b.proof ?? ''), want)) {
        R.failed(ip, 'passphrase');
        R.note('passphrase-change-refused', { by: actor.by, ip: R.mask(ip) });
        throw new HttpError(403, 'current', "That isn't the current passphrase.");
      }
      const salt = typeof b.salt === 'string' ? Buffer.from(b.salt, 'base64url') : null;
      if (!salt || salt.length < 16 || salt.length > 32) throw new HttpError(400, 'bad-request', 'The salt must be 16-32 random bytes.');
      const auth = typeof b.auth === 'string' ? Buffer.from(b.auth, 'base64url') : null;
      if (!auth || auth.length !== 32) throw new HttpError(400, 'bad-request', 'The auth key must be 32 bytes.');
      await R.setPassphrase(b.salt, auth);
      // Everyone else is signed out; this browser carries on.
      for (const k of Object.keys(S.sessions3)) if (k !== actor.hash) delete S.sessions3[k];
      R.endV2Sessions();
      await R.st.save();
      R.note('passphrase-changed', { by: actor.by });
      return sealedAnswer(actor, 200, { ok: true }, req, res);
    }
    if (path === '/api/v3/recovery') {
      needWeb(actor, 'passphrase');
      // GET says only whether it was saved; the key itself needs the passphrase again (POST { confirm }).
      if (method === 'GET') return sealedAnswer(actor, 200, { saved: !!K.recoverySaved }, req, res);
      if (method === 'POST') {
        const b = input();
        if (b.confirm !== undefined) {
          needConfirm(actor, b, ip, 'recovery-key');
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
      needWeb(actor);
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
        needWeb(actor);
        return sealedAnswer(actor, 200, ha.view(), req, res);
      }
      if (method === 'PUT') {
        needWeb(actor, 'passphrase');
        const out = ha.set(input(), sealedIn());
        R.note('home-assistant-changed', { by: actor.by, enabled: out.enabled });
        return sealedAnswer(actor, 200, out, req, res);
      }
    }
    if (path === '/api/v3/homeassistant/test' && method === 'POST') {
      needWeb(actor, 'passphrase');
      return sealedAnswer(actor, 200, await ha.test(input(), sealedIn()), req, res);
    }
    if (path === '/api/v3/homeassistant/sync' && method === 'POST') {
      needWeb(actor);
      const r = await ha.round('now');
      return sealedAnswer(actor, 200, r.ok ? { ok: true, came: r.came, went: r.went, held: !!r.held } : { ok: false, message: r.message }, req, res);
    }

    // ---------- history, stats, specials ----------
    if (path === '/api/v3/history' && method === 'GET') {
      needWeb(actor);
      const product = String(url.searchParams.get('product') ?? '');
      if (!product || product.length > 200) throw new HttpError(400, 'product', 'Which product?');
      const from = url.searchParams.get('from');
      return sealedAnswer(actor, 200, { prices: merger.history(product, from && from.length <= 40 ? from : null) }, req, res);
    }
    if (path === '/api/v3/stats' && method === 'GET') {
      needWeb(actor);
      const months = Math.min(60, Math.max(1, Math.trunc(Number(url.searchParams.get('months')) || 12)));
      return sealedAnswer(actor, 200, { months: merger.stats(months) }, req, res);
    }
    if (path === '/api/v3/specials' && method === 'GET') {
      needWeb(actor);
      return sealedAnswer(actor, 200, merger.specials(), req, res);
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
      const secret = house.admit(device, { name: label, pub, kex, myPub: row.pub, label });
      await R.st.save();
      R.writeOwn();
      R.note('phone-joined', { by: device, label, how: 'member' });
      return { sealed: house.sealGift(device, kex, n, house.joinGift(device, label, false, secret)) };
    }

    const inv = typeof b.invite === 'string' && b.invite.length <= 100 ? invites.get(b64u(R.sha256(Buffer.from(b.invite)))) : null;
    if (!inv) {
      R.failed(ip, 'invite');
      throw new HttpError(401, 'invite', "That code isn't from this server. Make a new one on the web page.");
    }
    if (inv.used) throw new HttpError(410, 'used', 'That code was already used. Make a new one for each phone.');
    if (inv.expires < now()) throw new HttpError(410, 'expired', 'That code has expired. Make a new one on the web page.');
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
    await R.st.save();
    R.writeOwn();
    R.note('phone-joined', { by: device, label: inv.label, how: b.bring !== undefined ? 'bring' : 'invite' });
    return { sealed: house.sealGift(device, kex, n, house.joinGift(device, inv.label, seed, secret)) };
  }

  /** POST /api/v3/upgrade: a phone already here before the handover (signed with its v2 key). */
  function upgrade(actor, b) {
    const kex = p256Str(b.kex);
    const n = nOf(b.n);
    if (!kex) throw new HttpError(400, 'kex', "The phone's kex key isn't a P-256 public key.");
    if (!n) throw new HttpError(400, 'n', 'n must be 16 random bytes.');
    const myPub = b.myPub === undefined || b.myPub === null ? null : p256Str(b.myPub);
    if (b.myPub && !myPub) throw new HttpError(400, 'myPub', "The phone's household key isn't a P-256 public key.");
    const device = actor.device;
    const d = actor.dev;
    // Being on the server isn't being in the household: a phone the household removed (it kept its
    // server registration) or one that was never in it gets no keys (SyncHousehold's own rule).
    if (R.engine.householdValue('removed:' + device) !== null) {
      d.status = 'removed';
      d.statusAt = now();
      R.st.saveSoon();
      R.note('upgrade-refused', { by: device, why: 'removed from the household' });
      throw new HttpError(401, 'removed', 'This phone was removed from the household.');
    }
    const row = house.memberRow(device);
    if (!row) {
      R.note('upgrade-refused', { by: device, why: 'not in the household' });
      throw new HttpError(403, 'member', "This phone isn't in the household on the server. Add it on the server's Add a phone page instead.");
    }
    const label = cleanName(d.label ?? row?.name ?? d.name) || 'Phone';
    d.label = label;
    d.kex = kex;
    if (myPub) d.myPub = myPub;
    d.api = 3;
    d.status = 'active';
    if (!K.secrets) K.secrets = {};
    if (!K.secrets[device]) K.secrets[device] = b64u(randomBytes(32));
    R.keys.save();
    const pubForRow = myPub ?? row?.pub ?? null;
    if (!row || row.name !== label || (pubForRow && row.pub !== pubForRow)) house.signMember(device, label, pubForRow);
    house.resealRecovery();
    // Home Assistant from this phone (sealed to the server), only while the server doesn't run it, and
    // only from the phone the household says runs it (ha:phone): any other member could otherwise
    // point the server's requests (and its token) wherever it liked.
    let haTaken = false;
    const haOffered = typeof b.ha === 'string' && !(K.ha?.enabled && K.ha?.token);
    if (haOffered && ha.haPhone() !== device) R.note('home-assistant-refused', { by: device, why: 'not the Home Assistant phone' });
    else if (haOffered) {
      try {
        const p = core.openHa(core.haKey(house.kexPriv(), core.unb64(kex), n), device, core.unb64(b.ha));
        const clean = ha.cleanPayload(p);
        if (clean) {
          K.ha = { address: clean.address, entity: clean.entity, enabled: clean.enabled, token: clean.token };
          R.keys.save();
          ha.tookOver(clean.state);
          if (K.ha.enabled) ha.start();
          haTaken = true;
        }
      } catch {
        R.note('home-assistant-refused', { by: device });
      }
    }
    R.st.saveSoon();
    R.writeOwn();
    R.note('phone-upgraded', { by: device, label, ...(haTaken ? { homeAssistant: true } : {}) });
    return { sealed: house.sealGift(device, kex, n, house.joinGift(device, label, false, K.secrets[device])), ...(haTaken ? { ha: true } : {}) };
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

  return { api, close, invites, handovers };
}

export { DAY };
