// 0.9.4 (protocol v3): browsers. Challenge-response sign-in (the passphrase never crosses, not even
// v2's authKey), a session with its own key, every request MACed (RestockWeb3), answers with
// household data sealed (RSF1 with the session key), Sign in with a phone, and Sign out everywhere.
// No cookie, so a page on another site can't use a session (no CSRF). docs/server-v3-design.md
// section 4, docs/server-protocol.md "Browsers".

import { createHmac, randomBytes } from 'node:crypto';

const MIN = 60_000;
const DAY = 24 * 60 * MIN;
export const WEB_LIMITS = {
  challengeMs: 2 * MIN,
  maxChallenges: 500,
  challengesPerMinute: 30, // per address
  sessionMs: 30 * DAY, // unused
  phoneSessionMs: 12 * 60 * MIN,
  maxSessions: 100,
  qrMs: 2 * MIN,
  maxQr: 100,
};
export const SEALED = 'application/x-restock-sealed';
const b64u = (b) => Buffer.from(b).toString('base64url');

/** A short name for a browser, from its User-Agent ("Firefox on Linux"). */
export function browserLabel(ua) {
  const s = String(ua ?? '');
  const app = /Edg\//.test(s) ? 'Edge' : /OPR\//.test(s) ? 'Opera' : /Firefox\//.test(s) ? 'Firefox' : /Chrome\//.test(s) ? 'Chrome' : /Safari\//.test(s) ? 'Safari' : 'A browser';
  const os = /Android/.test(s) ? 'Android' : /iPhone|iPad/.test(s) ? 'iOS' : /Windows/.test(s) ? 'Windows' : /Mac OS X|Macintosh/.test(s) ? 'macOS' : /CrOS/.test(s) ? 'ChromeOS' : /Linux/.test(s) ? 'Linux' : '';
  return os ? `${app} on ${os}` : app;
}

export function makeWebAuth(R) {
  const { core, S, now, HttpError, same } = R;
  const challenges = new Map(); // c -> { expires }
  const qr = new Map(); // id -> { epub, expires, approved: { device } | null, done }
  const perIp = new Map(); // limitKey -> { n, from }

  const life = (s) => (s.kind === 'phone' ? WEB_LIMITS.phoneSessionMs : WEB_LIMITS.sessionMs);
  const require256 = (s) => R.sha256(Buffer.from(String(s)));

  function prune() {
    const t = now();
    for (const [k, v] of challenges) if (v.expires < t) challenges.delete(k);
    for (const [k, v] of qr) if (v.expires < t) qr.delete(k);
    for (const [k, v] of perIp) if (t - v.from > MIN) perIp.delete(k);
    let changed = false;
    for (const [k, s] of Object.entries(S.sessions3)) {
      if (t - s.lastUsed > life(s)) {
        delete S.sessions3[k];
        changed = true;
      }
    }
    if (changed) R.st.saveSoon();
  }

  function fakeSalt(user) {
    const a = S.account;
    const len = a ? Buffer.from(a.salt, 'base64url').length : 16;
    return b64u(createHmac('sha256', S.secret).update('salt\n' + user).digest().subarray(0, len));
  }

  /** GET /api/v3/login/challenge?user= → { salt, c, kex } (a fake, stable salt for unknown users). */
  function challenge(user, ip) {
    const k = R.limitKey(ip);
    let e = perIp.get(k);
    if (!e || now() - e.from > MIN) perIp.set(k, (e = { n: 0, from: now() }));
    if (++e.n > WEB_LIMITS.challengesPerMinute) throw new HttpError(429, 'rate', 'Too many sign-in tries. Try again in a minute.', { retryAfter: 60 });
    if (challenges.size >= WEB_LIMITS.maxChallenges) {
      prune();
      if (challenges.size >= WEB_LIMITS.maxChallenges) throw new HttpError(429, 'busy', 'The server is busy. Try again in a minute.', { retryAfter: 60 });
    }
    const c = b64u(randomBytes(32));
    challenges.set(c, { expires: now() + WEB_LIMITS.challengeMs });
    const a = S.account;
    const salt = a && same(user, a.user) ? a.salt : fakeSalt(user);
    return { salt, c, kex: R.house.kexPub(), ...(a ? {} : { setup: true }) };
  }
  /** Takes a challenge (once). */
  function useChallenge(c) {
    if (typeof c !== 'string' || c.length > 100) return false;
    const ch = challenges.get(c);
    challenges.delete(c);
    return !!ch && ch.expires >= now();
  }

  function newSession(kind, key, extra, req) {
    const ids = Object.keys(S.sessions3);
    if (ids.length >= WEB_LIMITS.maxSessions) {
      ids.sort((a, b) => S.sessions3[a].lastUsed - S.sessions3[b].lastUsed);
      for (const k of ids.slice(0, ids.length - WEB_LIMITS.maxSessions + 1)) delete S.sessions3[k];
    }
    const s = b64u(randomBytes(32));
    const sess = {
      kind,
      key: b64u(key),
      created: now(),
      lastUsed: now(),
      label: browserLabel(req.headers['user-agent']),
      webId: b64u(randomBytes(12)),
      ...extra,
    };
    S.sessions3[b64u(require256(s))] = sess;
    return { s, sess };
  }

  /** What a session is given: every serverKey, the house, its own webId. */
  function gift(sess) {
    const K = R.keys.data;
    const v3 = S.mode === 'v3' && !!K.keyv;
    return {
      keys: v3 ? { ...K.serverKeys } : {},
      keyv: v3 ? Number(K.keyv) : 0,
      webId: sess.webId,
      household: v3 ? { name: S.house?.name ?? '', owner_pub: K.owner.pub } : null,
      mode: S.mode,
    };
  }
  const expiresOf = (sess) => new Date(sess.lastUsed + life(sess)).toISOString();
  const seal = (key, obj) => Buffer.from(core.sealRsf1(Buffer.from(key, 'base64url'), obj));

  /** POST /api/v3/login { user, c, epub, proof }. */
  function login(b, req, ip) {
    const user = String(b.user ?? '').normalize('NFKC');
    const okC = useChallenge(b.c);
    const epub = typeof b.epub === 'string' ? b.epub : '';
    const epubOk = !!R.p256Key(epub);
    const a = S.account;
    const loginKey = a?.loginKey ? Buffer.from(a.loginKey, 'base64url') : randomBytes(32);
    const want = core.loginProof(loginKey, String(b.c ?? ''), epub);
    const ok = okC && epubOk && !!a?.loginKey && same(user, a.user) & same(String(b.proof ?? ''), want);
    if (!ok) {
      R.failed(ip, 'login');
      R.note('login-failed', { ip: R.mask(ip) });
      if (!okC) throw new HttpError(401, 'challenge', 'That sign-in took too long. Try again.');
      throw new HttpError(401, 'auth', 'Wrong user name or passphrase.');
    }
    R.clearFails(ip);
    const key = core.sessionKeyOf(R.house.kexPriv(), core.unb64(epub), core.unb64(b.c), loginKey);
    const { s, sess } = newSession('passphrase', key, { ip: R.mask(ip) }, req);
    R.st.saveSoon();
    R.note('signed-in', { ip: R.mask(ip), kind: 'passphrase' });
    return { session: s, expires: expiresOf(sess), sealed: b64u(seal(sess.key, gift(sess))) };
  }

  /** The RestockWeb3 header's fields and the session it names, or null (no such header). Throws 401 for a session that's gone. */
  function header(req) {
    const p = core.parseAuthorization(req.headers.authorization);
    if (!p || p.scheme !== 'RestockWeb3') return null;
    const f = p.fields;
    if (!/^[A-Za-z0-9_-]{20,64}$/.test(f.s || '') || !/^\d{10,16}$/.test(f.t || '') || !/^[A-Za-z0-9_-]{16,32}={0,2}$/.test(f.n || '') || !/^[A-Za-z0-9_-]{20,64}={0,2}$/.test(f.m || '')) {
      throw new HttpError(401, 'auth', "That request isn't signed properly.");
    }
    const hash = b64u(require256(f.s));
    const sess = S.sessions3[hash];
    if (!sess || now() - sess.lastUsed > life(sess)) {
      if (sess) delete S.sessions3[hash];
      throw new HttpError(401, 'signed-out', "You've been signed out. Sign in again.");
    }
    return { f, hash, sess };
  }

  /** Checks a request's MAC, clock and nonce (after its body was read). */
  function check(req, h, body) {
    const text = core.requestText(req.method, req.url, h.f.t, h.f.n, body);
    if (!core.macOk(Buffer.from(h.sess.key, 'base64url'), text, h.f.m)) throw new HttpError(401, 'auth', "That request's signature doesn't match this session.");
    if (Math.abs(now() - Number(h.f.t)) > R.LIMITS.skewMs) throw new HttpError(401, 'clock', "This computer's clock is off; it'll retry with the server's time.");
    const nk = 'web:' + h.hash + ':' + h.f.n;
    if (R.nonces.has(nk)) throw new HttpError(401, 'replay', 'That request was already used.');
    R.nonces.set(nk, now());
    if (now() - h.sess.lastUsed > MIN) {
      h.sess.lastUsed = now();
      R.st.saveSoon();
    }
    return { type: 'web3', hash: h.hash, session: h.sess, kind: h.sess.kind, webId: h.sess.webId, webDevice: 'web-' + h.sess.webId, by: 'web-' + h.sess.webId };
  }

  /** A request body: raw RSF1 sealed with the session key (Content-Type application/x-restock-sealed), or JSON. */
  function body(actor, req, raw, { sealedOnly = false } = {}) {
    const type = String(req.headers['content-type'] || '');
    if (type.startsWith(SEALED)) {
      if (actor?.type !== 'web3') throw new HttpError(400, 'sealed', 'Only a signed-in browser seals requests.');
      try {
        const v = core.openRsf1(Buffer.from(actor.session.key, 'base64url'), raw);
        if (v && typeof v === 'object' && !Array.isArray(v)) return v;
      } catch {
        /* below */
      }
      throw new HttpError(400, 'sealed', "That request couldn't be opened.");
    }
    if (sealedOnly) throw new HttpError(400, 'sealed', 'Send this sealed (it carries a secret).');
    return R.json(raw);
  }

  function endSession(hash) {
    delete S.sessions3[hash];
  }
  function endAll() {
    S.sessions3 = Object.create(null);
    qr.clear();
  }
  function endPhoneSessions(device) {
    for (const [k, s] of Object.entries(S.sessions3)) if (s.kind === 'phone' && s.device === device) delete S.sessions3[k];
  }

  // ---------- Sign in with a phone ----------

  function qrStart(b) {
    const epub = typeof b.epub === 'string' ? b.epub : '';
    if (!R.p256Key(epub)) throw new HttpError(400, 'epub', "That isn't a P-256 public key.");
    if (qr.size >= WEB_LIMITS.maxQr) {
      prune();
      if (qr.size >= WEB_LIMITS.maxQr) throw new HttpError(429, 'busy', 'Too many codes waiting. Try again in a few minutes.');
    }
    const id = b64u(randomBytes(32));
    qr.set(id, { epub, expires: now() + WEB_LIMITS.qrMs, approved: null });
    return { id, kex: R.house.kexPub(), expires: new Date(now() + WEB_LIMITS.qrMs).toISOString(), expiresIn: WEB_LIMITS.qrMs / 1000 };
  }
  function qrGet(id) {
    if (!/^[A-Za-z0-9_-]{20,64}$/.test(id)) throw new HttpError(404, 'not-found', "That code isn't on this server.");
    const r = qr.get(id);
    if (!r) throw new HttpError(404, 'not-found', "That code isn't on this server.");
    if (r.expires < now()) {
      qr.delete(id);
      throw new HttpError(410, 'expired', 'That code has expired. Make a new one.');
    }
    return r;
  }
  function qrApprove(id, device, b) {
    const r = qrGet(id);
    if (r.approved) throw new HttpError(409, 'used', 'That code was already used.');
    // The phone may say which browser key it saw in the code: then it must be this one.
    if (b && typeof b.k === 'string' && !R.sameKey(b.k, r.epub)) throw new HttpError(409, 'code', "That code doesn't match this sign-in.");
    r.approved = { device };
  }
  /** Polls: { pending: true } until a phone approved, then (once) the session, its keys sealed with HKDF(ECDH(kex, epub), salt id). */
  function qrCollect(id, req, ip) {
    const r = qrGet(id);
    if (!r.approved) return { pending: true, status: 'waiting', expires: new Date(r.expires).toISOString() };
    qr.delete(id);
    const d = S.devices[r.approved.device];
    if (!d || d.status !== 'active') throw new HttpError(410, 'expired', 'That phone was removed. Try again.');
    const key = core.sessionKeyOf(R.house.kexPriv(), core.unb64(r.epub), core.unb64(id));
    const { s, sess } = newSession('phone', key, { device: r.approved.device, ip: R.mask(ip) }, req);
    R.st.saveSoon();
    R.note('signed-in', { by: r.approved.device, ip: R.mask(ip), kind: 'phone' });
    const g = { ...gift(sess), device: r.approved.device, deviceName: d.label ?? d.name ?? null };
    return { pending: false, status: 'done', session: s, expires: expiresOf(sess), sealed: b64u(seal(sess.key, g)) };
  }

  function list(currentHash) {
    return Object.entries(S.sessions3)
      .map(([k, s]) => ({
        id: k.slice(0, 22),
        kind: s.kind,
        label: s.label ?? null,
        created: new Date(s.created).toISOString(),
        lastUsed: new Date(s.lastUsed).toISOString(),
        expires: expiresOf(s),
        ...(s.device ? { device: s.device } : {}),
        ...(s.ip ? { ip: s.ip } : {}),
        ...(k === currentHash ? { current: true } : {}),
      }))
      .sort((a, b) => b.lastUsed.localeCompare(a.lastUsed));
  }
  function byId(id) {
    if (!/^[A-Za-z0-9_-]{22}$/.test(id)) return null;
    return Object.keys(S.sessions3).find((k) => k.slice(0, 22) === id) ?? null;
  }

  return { challenge, useChallenge, login, header, check, body, seal, gift, expiresOf, endSession, endAll, endPhoneSessions, qrStart, qrApprove, qrCollect, list, byId, prune };
}
