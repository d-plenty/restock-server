// 0.18.3: a yes on an admin phone, like two-factor. Signing in to the web page with the passphrase,
// and each risky change made there (how long data is kept, deleting data, the recovery key, the
// passphrase or user name, moving and erasing), waits for an admin phone to say yes. The browser shows
// a two-digit number; the admin phone (Restock → Settings → Sync → Server admin, or the sheet that
// opens when Restock does) shows the same number, which browser asks and from where, with "Yes, it's
// me" and "No, block it". Every admin phone lost: the recovery key says yes instead.
//
// Only admin phones that know how (Restock 0.18.3 or newer) are asked. A household with none (no
// admin phones, or only older ones) signs in with the passphrase alone, as before, so nobody is shut
// out by updating the server first.

import { randomBytes, randomInt } from 'node:crypto';

const MIN = 60_000;
export const APPROVE_LIMITS = { waitMs: 5 * MIN, useMs: 2 * MIN, max: 50, perSession: 3 };
export const APPROVE_APP = '0.18.3';
const b64u = (b) => Buffer.from(b).toString('base64url');

/** "0.18.3" against "0.18.10": negative, zero or positive. Anything that isn't a version counts as 0.0.0. */
export function compareVersions(a, b) {
  const p = (v) => (/^(\d+)\.(\d+)\.(\d+)/.exec(String(v ?? '').trim()) ?? [0, 0, 0, 0]).slice(1).map(Number);
  const x = p(a);
  const y = p(b);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
}

/** What each risky change is called, on the phone ("A browser wants to …"). */
export const WHAT = {
  'sign-in': 'sign in',
  'keep-data': 'change how long data is kept',
  'delete-data': 'delete data',
  'delete-everything': 'delete everything',
  'recovery-key': 'see the recovery key',
  passphrase: 'change the passphrase',
  'user-name': 'change the user name',
  move: 'move the household to a new server',
  erase: 'erase this server',
};

export function makeApprovals(R) {
  const { S, now, HttpError } = R;
  const waiting = new Map(); // id -> { what, hash, number, label, ip, made, expires, answer: null|'yes'|'no', by, at, used }

  const active = (d) => (d.status ?? 'active') === 'active' && d.api === 3;
  /** The admin phones that can say yes (on 0.18.3 or newer): [device, d]. */
  function approvers() {
    return Object.entries(S.devices).filter(([, d]) => active(d) && d.role === 'admin' && compareVersions(d.app, APPROVE_APP) >= 0);
  }
  const needed = () => approvers().length > 0;

  function prune() {
    const t = now();
    for (const [k, v] of waiting) if (Math.max(v.expires, (v.at ?? 0) + APPROVE_LIMITS.useMs) < t) waiting.delete(k);
  }

  /** A new request for a yes, from the browser session `hash`. */
  function start(what, hash, sess, ip) {
    prune();
    // One waiting request per session and kind: asking again replaces it.
    let mine = 0;
    for (const [k, v] of waiting) {
      if (v.hash !== hash) continue;
      if (v.what === what && !v.answer) waiting.delete(k);
      else mine++;
    }
    if (mine >= APPROVE_LIMITS.perSession || waiting.size >= APPROVE_LIMITS.max) throw new HttpError(429, 'busy', 'Too many requests waiting for a phone. Try again in a few minutes.');
    const id = b64u(randomBytes(18));
    const r = { what, hash, number: String(randomInt(10, 100)), label: sess?.label ?? 'A browser', ip: ip ?? null, made: now(), expires: now() + APPROVE_LIMITS.waitMs, answer: null, by: null, at: null, used: false };
    waiting.set(id, r);
    R.note('approval-asked', { what, ip });
    return view(id, r);
  }

  const phonesOf = () => approvers().map(([, d]) => d.label ?? d.name ?? 'Admin phone');
  function view(id, r) {
    return {
      id,
      what: r.what,
      number: r.number,
      phones: phonesOf(),
      expires: new Date(r.expires).toISOString(),
      expiresIn: Math.max(0, Math.round((r.expires - now()) / 1000)),
      status: r.answer === 'yes' ? 'yes' : r.answer === 'no' ? 'no' : r.expires < now() ? 'expired' : 'waiting',
    };
  }

  function get(id) {
    if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{20,40}$/.test(id)) return null;
    return waiting.get(id) ?? null;
  }

  /** The browser asks how its request is going (its own only). */
  function status(id, hash) {
    const r = get(id);
    if (!r || r.hash !== hash) throw new HttpError(404, 'not-found', "That request isn't waiting any more. Try again.");
    return view(id, r);
  }

  /** What an admin phone sees: every request still waiting. */
  function list() {
    prune();
    const t = now();
    return [...waiting.entries()]
      .filter(([, r]) => !r.answer && r.expires >= t)
      .map(([id, r]) => ({ id, what: r.what, words: WHAT[r.what] ?? r.what, number: r.number, browser: r.label, ip: r.ip, asked: new Date(r.made).toISOString(), expires: new Date(r.expires).toISOString() }));
  }

  /** An admin phone says yes or no. */
  function answer(id, device, yes) {
    const r = get(id);
    if (!r || r.expires < now()) throw new HttpError(410, 'expired', 'That request has run out. Ask again from the web page.');
    if (r.answer) throw new HttpError(409, 'used', yes ? 'That request was already answered.' : 'That request was already answered.');
    r.answer = yes ? 'yes' : 'no';
    r.by = device;
    r.at = now();
    const d = S.devices[device];
    R.note(yes ? 'approval-yes' : 'approval-no', { by: device, what: r.what, name: d?.label ?? d?.name });
    if (!yes && r.what === 'sign-in') {
      // No, block it: that browser's session goes.
      delete S.sessions3[r.hash];
      R.st.saveSoon();
    }
    return { ok: true };
  }

  /** The recovery key in place of a phone (every admin phone lost). */
  function byRecovery(id, hash, typed, ip) {
    R.checkLock(ip);
    const r = get(id);
    if (!r || r.hash !== hash) throw new HttpError(404, 'not-found', "That request isn't waiting any more. Try again.");
    const K = R.keys.data;
    const want = String(K.recovery ?? '');
    const got = String(typed ?? '').replace(/[^A-Za-z0-9]/g, '').toUpperCase();
    if (!want || !got || !R.same(got, want.toUpperCase())) {
      R.failed(ip, 'recovery');
      R.note('approval-recovery-refused', { what: r.what });
      throw new HttpError(403, 'recovery', "That isn't this household's recovery key.");
    }
    r.answer = 'yes';
    r.by = 'recovery-key';
    r.at = now();
    R.note('approval-recovery', { what: r.what });
    return view(id, r);
  }

  function cancel(id, hash) {
    const r = get(id);
    if (r && r.hash === hash) waiting.delete(id);
  }

  /**
   * A risky change that came back with `approved`: the yes must be this session's, for this change,
   * and used within 2 minutes of the yes, once.
   */
  function take(id, hash, what) {
    const r = get(id);
    if (!r || r.hash !== hash || r.what !== what || r.answer !== 'yes' || r.used || now() - r.at > APPROVE_LIMITS.useMs) return false;
    r.used = true;
    waiting.delete(id);
    return true;
  }

  /** A sign-in that waited, said yes to: its session may go on. Null while it waits; throws once it's no or run out. */
  function signInDone(id, hash) {
    const r = get(id);
    if (!r || r.hash !== hash) throw new HttpError(410, 'expired', 'That sign-in has run out. Sign in again.');
    if (r.answer === 'no') throw new HttpError(403, 'blocked', 'An admin phone said no. Sign in again if that was you.');
    if (r.answer !== 'yes') {
      if (r.expires < now()) throw new HttpError(410, 'expired', 'No phone said yes in time. Sign in again.');
      return null;
    }
    waiting.delete(id);
    return r;
  }

  return { needed, approvers, phonesOf, start, status, list, answer, byRecovery, cancel, take, signInDone, prune, view: (id) => (get(id) ? view(id, get(id)) : null) };
}
