// Restock server (API v2, Restock 0.9.2; API v3, Restock 0.9.4): a small server a household runs itself.
//
// v2 (a 0.9.3 household, until its owner phone hands it over): it stores and hands back sealed
// files. It never has the household key, the server key or anything that opens them
// (docs/server-protocol.md in the Restock repo is the contract).
// v3 (0.9.4, "server-first"): the server is the household's owner. It holds the keys, opens what
// phones share, merges it into household.db with the Restock core, and writes a file of its own
// (src/v3/, docs/server-v3-design.md). Mode: state.mode, "new" | "v2" | "v3" | "released".
//
// - Phones: each has its own ECDSA P-256 key. The server keeps the public key and checks a
//   signature on every request (with replay protection).
// - The web user: one user. First start uses RESTOCK_USER / RESTOCK_PASSWORD only to set a
//   passphrase. The browser turns the passphrase into an authKey (the server keeps scrypt of it)
//   and a vaultKey (never sent). Sessions are HttpOnly cookies.
// - The web app (the Restock web build, built into public/app/) is served at /.
//
// No dependencies beyond Node itself.

import { createServer } from 'node:http';
import { BlockList, isIP } from 'node:net';
import { createHash, createHmac, randomBytes, timingSafeEqual, createPublicKey, verify as cryptoVerify, scrypt } from 'node:crypto';
import { promises as fs, readFileSync, existsSync, mkdirSync, appendFileSync, writeFileSync, rmSync, accessSync, realpathSync, constants as fsc } from 'node:fs';
import { join, extname, dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openState, atomicWrite, atomicWriteSync, dict } from './state.mjs';
import { serverZone } from './zone.mjs';
import { parseName, parseNameV3, canWrite, bodyOk, reservedDevice, DEVICE, WEB_ID, FOLDERS, FOLDERS_V3 } from './names.mjs';
import { loadCore } from './v3/core.mjs';
import { makeV3 } from './v3/api.mjs';
import { walkNames, sqliteModule } from './v3/merge.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const VERSION = JSON.parse(readFileSync(join(HERE, '..', 'package.json'), 'utf8')).version;
const PUBLIC = resolve(HERE, '..', 'public');

const MIN = 60_000;
const DAY = 24 * 60 * MIN;
export const LIMITS = {
  inviteMs: 10 * MIN,
  linkMs: 10 * MIN,
  qrLoginMs: 2 * MIN,
  skewMs: 5 * MIN,
  nonceMs: 11 * MIN, // a little over the 10 the contract asks for, so a request at the edge of the window can't come back
  sessionMs: 30 * DAY, // unused
  phoneSessionMs: 12 * 60 * MIN, // a browser signed in with a phone keeps the keys in memory only
  setupSessionMs: 60 * MIN,
  failsBeforeLockout: 10,
  lockoutMs: 15 * MIN,
  requestsPerMinute: 1200,
  qrLoginsPer10Min: 10,
  scryptPerMinute: 120,
  maxInvites: 20,
  maxRelays: 100,
  maxSessions: 100,
  maxDevices: 50,
  maxJson: 256 * 1024,
  maxVault: 64 * 1024,
  maxSealed: 64 * 1024,
  maxInFlightBytes: 128 * 1024 * 1024, // request bodies held in memory at once, all uploads together
  activityKept: 2000,
  trashDays: 30, // archive/ and photos/ files deleted or replaced by another writer are kept this long
};
const SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
/** The http server's limits on slow and idle connections (cfg.timeouts overrides them, for tests). */
export const TIMEOUTS = {
  headersMs: 20_000, // a request's headers
  requestMs: 10 * MIN, // a whole request, body too: 32 MB at about half a megabit a second
  keepAliveMs: 10_000, // a kept-alive connection waiting for its next request
  idleMs: 2 * MIN, // nothing moving either way (a client that stopped reading an answer, say)
  checkMs: 5_000, // how often headersMs and requestMs are checked
};

/** Node 22.13 or newer has node:sqlite (household.db). Null if this Node can run the server, else why not. */
export function nodeProblem(proc = process) {
  return proc.getBuiltinModule?.('node:sqlite') ? null : 'Restock server needs Node 22.13 or newer.';
}

const yes = (v) => /^(1|true|yes|on)$/i.test(String(v ?? '').trim());

/**
 * First-start passwords anyone could guess: the default, and the placeholder in compose.yaml and
 * the README. While one of these is set, the first-start login only works from home.
 */
const KNOWN_PASSWORDS = new Set(['admin', 'change-me-now', 'changeme', 'change-me', 'password', 'restock']);
export const isKnownPassword = (p) => KNOWN_PASSWORDS.has(String(p ?? '').trim().toLowerCase());

/** Settings from the environment (or the object passed in, for the tests). */
export function config(env = process.env) {
  const tp = String(env.RESTOCK_TRUST_PROXY || '').trim();
  return {
    port: Number(env.PORT || 8787),
    host: env.HOST || '0.0.0.0',
    dataDir: env.DATA_DIR || '/data',
    user: (env.RESTOCK_USER || 'admin').trim().normalize('NFKC') || 'admin',
    password: env.RESTOCK_PASSWORD || 'admin',
    homeUrl: (env.RESTOCK_HOME_URL || '').trim().replace(/\/+$/, ''),
    awayUrl: (env.RESTOCK_AWAY_URL || '').trim().replace(/\/+$/, ''),
    maxFileMb: Number(env.RESTOCK_MAX_FILE_MB || 32),
    maxTotalMb: Number(env.RESTOCK_MAX_TOTAL_MB || 2048),
    trustProxy: /^cloudflare$/i.test(tp) ? 'cloudflare' : yes(tp),
    quiet: yes(env.RESTOCK_QUIET),
    now: Date.now,
    // 0.9.5 (final review): the zone for the Data tab's months and days and the night's Auto delete (TZ).
    timeZone: serverZone(env),
    mergeDelayMs: 1000,
  };
}

// ---------- small helpers ----------

const sha256 = (b) => createHash('sha256').update(b).digest();
const b64u = (b) => Buffer.from(b).toString('base64url');
const token = (n = 32) => randomBytes(n).toString('base64url');

/** Constant-time compare of two strings or buffers (of any length). */
export function same(a, b) {
  return timingSafeEqual(sha256(Buffer.from(a ?? '')), sha256(Buffer.from(b ?? '')));
}

/** Decodes base64 or base64url (with or without padding); null if it's neither. */
export function unb64(s) {
  if (typeof s !== 'string' || s.length === 0 || s.length > 4 * 1024 * 1024) return null;
  if (/^[A-Za-z0-9_-]+={0,2}$/.test(s)) return Buffer.from(s, 'base64url');
  if (/^[A-Za-z0-9+/]+={0,2}$/.test(s)) return Buffer.from(s, 'base64');
  return null;
}

const P256_SPKI_PREFIX = Buffer.from('3059301306072a8648ce3d020106082a8648ce3d030107034200', 'hex');
/** A P-256 public key from base64 SPKI (or a raw 65-byte point); null if it isn't one. */
export function p256Key(s) {
  const raw = unb64(s);
  if (!raw || raw.length > 200) return null;
  const der = raw.length === 65 && raw[0] === 4 ? Buffer.concat([P256_SPKI_PREFIX, raw]) : raw;
  try {
    const k = createPublicKey({ key: der, format: 'der', type: 'spki' });
    if (k.asymmetricKeyType !== 'ec' || k.asymmetricKeyDetails?.namedCurve !== 'prime256v1') return null;
    return k;
  } catch {
    return null;
  }
}

/** Are these the same P-256 public key (however each is written)? */
function sameKey(a, b) {
  const x = p256Key(a);
  const y = p256Key(b);
  return !!x && !!y && x.export({ type: 'spki', format: 'der' }).equals(y.export({ type: 'spki', format: 'der' }));
}

/** What a phone signs: METHOD\nPATH_AND_QUERY\nt\nn\nhex(sha256(body)). */
export function signedText(method, pathAndQuery, t, n, body) {
  return `${method}\n${pathAndQuery}\n${t}\n${n}\n${sha256(body ?? Buffer.alloc(0)).toString('hex')}`;
}

function scryptAsync(pass, salt) {
  return new Promise((ok, no) => scrypt(pass, salt, 32, SCRYPT, (e, k) => (e ? no(e) : ok(k))));
}

// Home addresses: loopback, private, link-local, and Tailscale (100.64.0.0/10).
const HOME = new BlockList();
for (const [net, bits] of [['127.0.0.0', 8], ['10.0.0.0', 8], ['172.16.0.0', 12], ['192.168.0.0', 16], ['169.254.0.0', 16], ['100.64.0.0', 10]]) HOME.addSubnet(net, bits, 'ipv4');
for (const [net, bits] of [['::1', 128], ['fc00::', 7], ['fe80::', 10]]) HOME.addSubnet(net, bits, 'ipv6');
/** Is this a home (or Tailscale) address? Anything that isn't a plain address counts as not. */
export function isHomeAddress(addr) {
  let a = String(addr ?? '').trim().replace(/^"|"$/g, '');
  const bracket = /^\[([^\]]+)\](?::\d+)?$/.exec(a);
  if (bracket) a = bracket[1];
  else if (/^\d+\.\d+\.\d+\.\d+:\d+$/.test(a)) a = a.replace(/:\d+$/, '');
  a = a.replace(/%.*$/, '');
  const m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(a);
  if (m) a = m[1];
  const v = isIP(a);
  return v === 4 ? HOME.check(a, 'ipv4') : v === 6 ? HOME.check(a, 'ipv6') : false;
}

/** IPv6 addresses written out in full (8 groups of 4 hex digits), or null. */
function ipv6Groups(a) {
  if (isIP(a) !== 6) return null;
  let s = a.toLowerCase().replace(/%.*$/, '');
  const v4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (v4) {
    const o = v4[1].split('.').map(Number);
    s = s.slice(0, -v4[1].length) + ((o[0] << 8) | o[1]).toString(16) + ':' + ((o[2] << 8) | o[3]).toString(16);
  }
  const [head, tail] = s.includes('::') ? s.split('::') : [s, null];
  const h = head ? head.split(':') : [];
  const t = tail ? tail.split(':') : [];
  const groups = tail === null ? h : [...h, ...Array(8 - h.length - t.length).fill('0'), ...t];
  return groups.length === 8 ? groups.map((g) => g.padStart(4, '0')) : null;
}
/**
 * Who a limit (lockout, rate) counts against: the address, or for IPv6 its /64, since anyone
 * with one IPv6 address usually has the whole /64 to pick from.
 */
export function limitKey(ip) {
  const g = ipv6Groups(String(ip ?? ''));
  if (!g || /^0{4}:0{4}:0{4}:0{4}:0{4}:ffff$/.test(g.slice(0, 6).join(':'))) return String(ip ?? '');
  return g.slice(0, 4).join(':') + '::/64';
}

const mask = (ip) => (ip.includes('.') ? ip.replace(/\.\d+$/, '.x') : ip.replace(/:[^:]*:[^:]*$/, ':x'));
const cleanName = (s) =>
  String(s ?? '')
    .replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/g, '')
    .trim()
    .slice(0, 60);

/** Counts things per key in a rolling window. */
function windowCounter(windowMs, now) {
  const m = new Map();
  return {
    hit(k) {
      const t = now();
      let e = m.get(k);
      if (!e || t - e.from > windowMs) m.set(k, (e = { n: 0, from: t }));
      return ++e.n;
    },
    count(k) {
      const e = m.get(k);
      return e && now() - e.from <= windowMs ? e.n : 0;
    },
    reset(k) {
      m.delete(k);
    },
    prune() {
      const t = now();
      for (const [k, e] of m) if (t - e.from > windowMs) m.delete(k);
    },
  };
}

class HttpError extends Error {
  constructor(status, error, message, extra) {
    super(message || error);
    Object.assign(this, { status, error, extra });
  }
}

// ---------- headers ----------

const SECURITY = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
};
/** 0.9.5: the web app's own pages may use the camera (scanning a barcode on an iPhone); nothing else may. */
export const APP_PERMISSIONS = 'camera=(self), microphone=(), geolocation=(), payment=(), usb=()';
/** 0.9.5: the home screen web app's files (vite.server.config.ts in Restock). */
const PWA_ICON = /^pwa\/[a-z0-9-]+\.png$/;
/** For the pages (the web app and the setup page): only this server; wasm for sql.js. */
export const PAGE_CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "worker-src 'self' blob:",
  "manifest-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');
/**
 * 0.9.4: the web app's page may also show product photos, but only from the shops' own picture
 * servers (src/stores/* in the Restock repo), never any https: address (a household member could
 * otherwise plant a "tracking pixel" that reports a browser's address). Adding a shop means adding
 * its image host here. The web loads them with referrerPolicy="no-referrer".
 */
export const IMAGE_HOSTS = [
  'https://*.woolworths.media', // Woolworths (cdn0.woolworths.media/content/wowproductimages/...)
  'https://productimages.coles.com.au', // Coles
  'https://dm.apac.cms.aldi.cx', // Aldi (the product API's assets)
  'https://media.danmurphys.com.au', // Dan Murphy's
  'https://edgmedia.bws.com.au', // BWS
  'https://static.chemistwarehouse.com.au', // Chemist Warehouse
  'https://cdn.shopify.com', // shops on Shopify (smaller pharmacies and bottle shops)
  'https://images.openfoodfacts.org', // barcode look-ups (Open Food Facts' image_small_url)
];
/** 0.9.13: Settings → Feedback sends to Restock's own feedback inbox, only when Send is pressed (never this household's data). */
export const FEEDBACK_HOST = 'https://restock-prices.plenty.family';
export const APP_CSP = PAGE_CSP.replace("img-src 'self' data: blob:", `img-src 'self' data: blob: ${IMAGE_HOSTS.join(' ')}`).replace(
  "connect-src 'self'",
  `connect-src 'self' ${FEEDBACK_HOST}`,
);
/** For the API: nothing it returns is ever a page. */
const API_CSP = "default-src 'none'; frame-ancestors 'none'; sandbox";

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.wasm': 'application/wasm',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
};

const NOT_BUILT = `<!doctype html>
<html lang="en-AU"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Restock server</title><link rel="stylesheet" href="/setup/setup.css"></head>
<body><main class="card"><h1>Restock server</h1>
<p>The server's running, but the Restock web app isn't in this copy of the server yet.</p>
<p>If you built the image yourself, build the web app first (see the README). Your phones can still sync with this server.</p>
</main></body></html>`;

// ---------- the server ----------

/** Builds the server (not listening yet). */
export async function makeServer(cfg) {
  const now = cfg.now || Date.now;
  const log = cfg.quiet ? () => {} : (...a) => console.error(...a);
  const DATA = resolve(cfg.dataDir);
  const FILES = join(DATA, 'files');
  const TMP = join(DATA, 'tmp');
  const TRASH = join(DATA, 'trash'); // outside files/: never listed or served
  mkdirSync(FILES, { recursive: true });
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(TMP, { recursive: true });
  // Where the files really are (the folder itself may be a link); nothing outside it is served or written.
  const REAL_FILES = realpathSync(FILES);
  // 0.9.5: appDir is for tests (a made-up web app); the server always serves public/app/.
  const APP = cfg.appDir ? resolve(cfg.appDir) : join(PUBLIC, 'app');
  const SETUP = join(PUBLIC, 'setup');
  const maxFile = Math.max(1, cfg.maxFileMb) * 1024 * 1024;
  const maxTotal = Math.max(1, cfg.maxTotalMb) * 1024 * 1024;
  const started = new Date(now()).toISOString();

  const st = openState(DATA, TMP, log);
  const S = st.data;

  // ---- activity: who uploaded, fetched or changed what (never contents, never secrets) ----
  const logFile = join(DATA, 'activity.jsonl');
  let activity = [];
  try {
    activity = readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean).slice(-LIMITS.activityKept).map((l) => JSON.parse(l));
  } catch {
    activity = [];
  }
  let lines = activity.length;
  let R = null; // the v3 side (makeV3), once built
  function note(what, fields = {}) {
    // 0.9.4: with household.db open, the activity goes into srv_log (activity.jsonl is v2's).
    if (R?.engine) {
      const { by, ...rest } = fields;
      if (R.merger.logLine('activity', what, by ?? null, Object.keys(rest).length ? rest : null)) return;
    }
    const a = { at: new Date(now()).toISOString(), what, ...fields };
    activity.push(a);
    if (activity.length > LIMITS.activityKept) activity = activity.slice(-LIMITS.activityKept);
    try {
      appendFileSync(logFile, JSON.stringify(a) + '\n', { mode: 0o600 });
      if (++lines > LIMITS.activityKept * 2) {
        writeFileSync(logFile, activity.map((x) => JSON.stringify(x)).join('\n') + '\n', { mode: 0o600 });
        lines = activity.length;
      }
    } catch (e) {
      log('activity log:', e.message);
    }
  }
  /** Phones fetch every few minutes: one line per file and reader an hour is plenty. */
  const fetchNoted = new Map();
  function noteFetch(file, by) {
    const k = file + '|' + by;
    if (now() - (fetchNoted.get(k) ?? -Infinity) < 60 * MIN) return;
    fetchNoted.set(k, now());
    note('fetch', { file, by });
  }

  // A reset asked for by creating DATA_DIR/reset-passphrase (see the README).
  const resetFlag = join(DATA, 'reset-passphrase');
  let wasReset = false;
  if (existsSync(resetFlag)) {
    if (S.account?.webId) S.retiredWebIds.push(S.account.webId);
    S.account = null;
    S.sessions = dict();
    S.sessions3 = dict();
    rmSync(resetFlag, { force: true });
    wasReset = true;
    note('passphrase-reset');
  }
  await st.save();

  // ---- limits ----
  const requests = windowCounter(MIN, now);
  const fails = new Map(); // ip -> { n, from, until }
  const qrMade = windowCounter(10 * MIN, now);
  const scryptUse = windowCounter(MIN, now);
  function lockedFor(ip) {
    const f = fails.get(limitKey(ip));
    return f && f.until > now() ? f.until - now() : 0;
  }
  function failed(ip, what) {
    const t = now();
    const k = limitKey(ip);
    let f = fails.get(k);
    if (!f || t - f.from > LIMITS.lockoutMs) fails.set(k, (f = { n: 0, from: t, until: 0 }));
    f.n++;
    if (f.n >= LIMITS.failsBeforeLockout && !f.until) {
      f.until = t + LIMITS.lockoutMs;
      note('locked-out', { ip: mask(ip), after: what });
    }
  }
  function checkLock(ip) {
    const ms = lockedFor(ip);
    if (ms) throw new HttpError(429, 'locked', 'Too many wrong tries. Try again in 15 minutes.', { retryAfter: Math.ceil(ms / 1000) });
  }

  // ---- short-lived things, kept in memory only ----
  const invites = new Map(); // sha256(invite) -> { expires, used }
  const relays = new Map(); // id -> { kind: 'link'|'qrlogin', expires, owner (session hash) | poll (sha256), answer }
  const nonces = new Map(); // device:n -> seen at
  const pruner = setInterval(() => {
    const t = now();
    for (const [k, v] of invites) if (v.expires < t) invites.delete(k);
    for (const [k, v] of relays) if (v.expires < t) relays.delete(k);
    for (const [k, v] of nonces) if (t - v > LIMITS.nonceMs) nonces.delete(k);
    for (const [k, v] of fails) if (t - v.from > LIMITS.lockoutMs && v.until < t) fails.delete(k);
    for (const [k, v] of fetchNoted) if (t - v > 60 * MIN) fetchNoted.delete(k);
    requests.prune();
    qrMade.prune();
    scryptUse.prune();
    pruneSessions();
  }, MIN);
  pruner.unref();

  // ---- sessions ----
  const COOKIE = 'restock_session';
  const QR_COOKIE = 'restock_qr';
  function sessionLife(s) {
    return s.kind === 'setup' ? LIMITS.setupSessionMs : s.kind === 'phone' ? LIMITS.phoneSessionMs : LIMITS.sessionMs;
  }
  function pruneSessions() {
    const t = now();
    let changed = false;
    for (const [k, s] of Object.entries(S.sessions)) {
      if (t - s.lastUsed > sessionLife(s) || (s.kind === 'setup' && S.account)) {
        delete S.sessions[k];
        changed = true;
      }
    }
    if (changed) st.saveSoon();
  }
  pruneSessions();
  function cookies(req) {
    const out = {};
    for (const part of String(req.headers.cookie || '').split(';')) {
      const i = part.indexOf('=');
      if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
    }
    return out;
  }
  function cookieHeader(name, value, maxAgeSec, req, path = '/') {
    return `${name}=${value}; Path=${path}; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSec}${isHttps(req) ? '; Secure' : ''}`;
  }
  function newSession(req, res, kind, extra = {}) {
    const ids = Object.keys(S.sessions);
    if (ids.length >= LIMITS.maxSessions) {
      ids.sort((a, b) => S.sessions[a].lastUsed - S.sessions[b].lastUsed);
      for (const k of ids.slice(0, ids.length - LIMITS.maxSessions + 1)) delete S.sessions[k];
    }
    const t = token();
    const s = { kind, created: now(), lastUsed: now(), ...extra };
    S.sessions[b64u(sha256(t))] = s;
    res.cookies.push(cookieHeader(COOKIE, t, Math.floor(sessionLife(s) / 1000), req));
    return s;
  }
  function endSessionCookie(req, res) {
    res.cookies.push(cookieHeader(COOKIE, '', 0, req));
  }

  // ---- addresses ----
  /**
   * Are this request's proxy headers to be believed? Only with RESTOCK_TRUST_PROXY, and only when
   * the connection itself comes from home (a tunnel or proxy runs in the house, or in Docker next to
   * the server): someone reaching the port from the internet can't make up their own address.
   */
  function viaProxy(req) {
    return !!cfg.trustProxy && isHomeAddress(req.socket.remoteAddress);
  }
  function clientIp(req) {
    const direct = (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
    if (!viaProxy(req)) return direct;
    if (cfg.trustProxy === 'cloudflare' && req.headers['cf-connecting-ip']) return String(req.headers['cf-connecting-ip']).trim();
    // The last address is the one the proxy added; anything before it the visitor could have made up.
    const h = String(req.headers['x-forwarded-for'] || '').split(',').map((x) => x.trim()).filter(Boolean);
    return h.length ? h[h.length - 1] : direct;
  }
  /**
   * May the first-start login come from here, while the password is still one anyone could guess
   * ("admin", the compose file's "change-me-now": isKnownPassword)?
   * Only from home: the real socket address must be a home one, and so must every address a proxy
   * header names (a tunnel connects from inside the house, so its header says who's really asking).
   * Headers only ever make this stricter; they never let anyone in.
   */
  function fromHome(req) {
    if (!isHomeAddress(req.socket.remoteAddress)) return false;
    const named = [];
    for (const h of ['x-forwarded-for', 'x-real-ip', 'cf-connecting-ip', 'true-client-ip']) {
      if (req.headers[h] !== undefined) named.push(...String(req.headers[h]).split(','));
    }
    if (req.headers.forwarded !== undefined) {
      for (const part of String(req.headers.forwarded).split(/[;,]/)) {
        const m = /^\s*for=(.*)$/i.exec(part);
        if (m) named.push(m[1]);
      }
    }
    return named.map((x) => x.trim()).filter(Boolean).every(isHomeAddress) && homeHost(req);
  }
  /**
   * Was this page opened with an address only a home network has (an IP address, localhost, a
   * one-word or .local/.lan/.home.arpa/.internal/.ts.net name, or RESTOCK_HOME_URL's or
   * RESTOCK_AWAY_URL's host)? A web page elsewhere can point its own name at this server
   * (DNS rebinding): the browser then asks from home, but with that page's name as the Host.
   */
  function homeHost(req) {
    const mine = new Set();
    for (const u of [cfg.homeUrl, cfg.awayUrl]) {
      try {
        if (u) mine.add(new URL(u).hostname.toLowerCase());
      } catch {
        /* not an address */
      }
    }
    const hosts = [req.headers.host, ...String(req.headers['x-forwarded-host'] ?? '').split(',')].map((h) => String(h ?? '').trim()).filter(Boolean);
    if (!hosts.length) return false;
    return hosts.every((h) => {
      const m = /^(\[[^\]]+\]|[^:]+)(?::\d+)?$/.exec(h);
      if (!m) return false;
      const name = m[1].replace(/^\[|\]$/g, '').toLowerCase().replace(/\.$/, '');
      if (isIP(name)) return true;
      return mine.has(name) || name === 'localhost' || !name.includes('.') || /\.(localhost|local|lan|home\.arpa|internal|ts\.net)$/.test(name);
    });
  }
  function isHttps(req) {
    if (req.socket.encrypted) return true;
    if (!viaProxy(req)) return false;
    if (String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase() === 'https') return true;
    if (cfg.trustProxy === 'cloudflare') {
      try {
        return JSON.parse(String(req.headers['cf-visitor'] || '{}')).scheme === 'https';
      } catch {
        return false;
      }
    }
    return false;
  }
  function origin(req) {
    let host = String((viaProxy(req) && req.headers['x-forwarded-host']) || req.headers.host || '').split(',')[0].trim();
    if (!/^[A-Za-z0-9.\-:[\]]{1,255}$/.test(host)) return null;
    return `${isHttps(req) ? 'https' : 'http'}://${host}`;
  }

  // ---- responses ----
  function send(req, res, status, body, type = 'application/json; charset=utf-8', extra = {}) {
    const data = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
    const headers = {
      ...SECURITY,
      'Content-Security-Policy': API_CSP,
      'Cache-Control': 'no-store',
      'Content-Type': type,
      'Content-Length': Buffer.byteLength(data),
      'X-Restock-Time': String(now()),
      ...extra,
    };
    if (res.cookies.length) headers['Set-Cookie'] = res.cookies;
    res.writeHead(status, headers);
    res.end(req.method === 'HEAD' ? undefined : data);
  }
  function sendError(req, res, e) {
    const extra = {};
    if (e.extra?.retryAfter) extra['Retry-After'] = String(e.extra.retryAfter);
    send(req, res, e.status, { error: e.error, ...(e.message && e.message !== e.error ? { message: e.message } : {}), ...(e.extra || {}) }, undefined, extra);
  }

  let inFlight = 0; // bytes of request bodies being held right now
  function readBody(req, max) {
    return new Promise((ok, no) => {
      const len = Number(req.headers['content-length'] || 0);
      if (len > max) {
        req.resume();
        return no(new HttpError(413, 'too-big', `That's bigger than the server takes (${Math.round(max / 1024 / 1024) || 1} MB).`));
      }
      if (inFlight + len > LIMITS.maxInFlightBytes) {
        req.resume();
        return no(new HttpError(503, 'busy', 'The server is busy taking other uploads. Try again in a minute.', { retryAfter: 30 }));
      }
      const parts = [];
      let n = 0;
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        inFlight -= n;
      };
      req.on('data', (c) => {
        if (done) return;
        n += c.length;
        inFlight += c.length;
        if (n > max || inFlight > LIMITS.maxInFlightBytes) {
          finish();
          no(n > max ? new HttpError(413, 'too-big', `That's bigger than the server takes.`) : new HttpError(503, 'busy', 'The server is busy taking other uploads. Try again in a minute.', { retryAfter: 30 }));
          req.destroy();
          return;
        }
        parts.push(c);
      });
      req.on('end', () => {
        finish();
        ok(Buffer.concat(parts));
      });
      req.on('error', (e) => {
        finish();
        no(e);
      });
      req.on('close', finish);
    });
  }
  function json(body) {
    if (!body.length) return {};
    try {
      const v = JSON.parse(body.toString('utf8'));
      if (v && typeof v === 'object' && !Array.isArray(v)) return v;
    } catch {
      /* fall through */
    }
    throw new HttpError(400, 'bad-request', "That request wasn't valid JSON.");
  }

  // ---- who's asking ----

  /** A phone's signed request: checks everything but the body, which is read after. */
  function phoneHeader(req) {
    const h = String(req.headers.authorization || '');
    if (!/^Restock2\s/.test(h)) return null;
    const p = {};
    for (const part of h.slice(8).split(',')) {
      const i = part.indexOf('=');
      if (i > 0) p[part.slice(0, i).trim()] = part.slice(i + 1).trim();
    }
    if (!DEVICE.test(p.d || '') || !/^\d{10,16}$/.test(p.t || '') || !/^[A-Za-z0-9_-]{16,32}={0,2}$/.test(p.n || '') || !p.s) {
      throw new HttpError(401, 'auth', "That request isn't signed properly.");
    }
    const dev = S.devices[p.d];
    if (!dev) {
      if (S.removedDevices.includes(p.d)) throw new HttpError(401, 'removed', 'This phone was removed from the server. Add it again from the web page.');
      throw new HttpError(401, 'auth', "This server doesn't know this phone. Add it from the web page.");
    }
    return { ...p, dev };
  }
  /** A phone's signature, clock and nonce (v2's rules, v3's too). */
  function verifyPhone(req, f, pub, body) {
    const sig = unb64(f.s);
    const key = p256Key(pub);
    const text = Buffer.from(signedText(req.method, req.url, f.t, f.n, body));
    let ok = false;
    if (sig && key) {
      try {
        ok = cryptoVerify('sha256', text, { key, dsaEncoding: sig.length === 64 ? 'ieee-p1363' : 'der' }, sig);
      } catch {
        ok = false;
      }
    }
    if (!ok) throw new HttpError(401, 'auth', "That request's signature doesn't match this phone.");
    if (Math.abs(now() - Number(f.t)) > LIMITS.skewMs) throw new HttpError(401, 'clock', "This phone's clock is off; it'll retry with the server's time.");
    const nk = f.d + ':' + f.n;
    if (nonces.has(nk)) throw new HttpError(401, 'replay', 'That request was already used.');
    nonces.set(nk, now());
  }
  function checkPhone(req, ph, body) {
    const sig = unb64(ph.s);
    const key = p256Key(ph.dev.pub);
    const text = Buffer.from(signedText(req.method, req.url, ph.t, ph.n, body));
    let ok = false;
    if (sig && key) {
      try {
        ok = cryptoVerify('sha256', text, { key, dsaEncoding: sig.length === 64 ? 'ieee-p1363' : 'der' }, sig);
      } catch {
        ok = false;
      }
    }
    if (!ok) throw new HttpError(401, 'auth', "That request's signature doesn't match this phone.");
    if (Math.abs(now() - Number(ph.t)) > LIMITS.skewMs) throw new HttpError(401, 'clock', "This phone's clock is off; it'll retry with the server's time.");
    const nk = ph.d + ':' + ph.n;
    if (nonces.has(nk)) throw new HttpError(401, 'replay', 'That request was already used.');
    nonces.set(nk, now());
    if (now() - (ph.dev.lastSeen || 0) > MIN) {
      ph.dev.lastSeen = now();
      st.saveSoon();
    }
    return { type: 'phone', device: ph.d, by: ph.d };
  }
  function webActor(req, res) {
    const t = cookies(req)[COOKIE];
    if (!t || !/^[A-Za-z0-9_-]{20,64}$/.test(t)) return null;
    const hash = b64u(sha256(t));
    const s = S.sessions[hash];
    if (!s || now() - s.lastUsed > sessionLife(s) || (s.kind === 'setup' && S.account)) {
      if (s) delete S.sessions[hash];
      endSessionCookie(req, res);
      return { type: 'gone' };
    }
    if (now() - s.lastUsed > MIN) {
      s.lastUsed = now();
      st.saveSoon();
    }
    const webId = S.account?.webId ?? null;
    return { type: 'web', hash, session: s, kind: s.kind, webId, by: webId ? 'web-' + webId : 'web' };
  }

  // ---- files ----
  const sizes = new Map(); // name -> size
  let total = 0;
  const versionOf = (s) => `${Math.round(s.mtimeMs)}:${s.size}`;
  async function walk() {
    const out = [];
    async function dir(rel, depth) {
      let ents;
      try {
        ents = await fs.readdir(rel ? join(FILES, rel) : FILES, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of ents) {
        const r = rel ? rel + '/' + e.name : e.name;
        if (e.isDirectory()) {
          if ((depth === 0 && (FOLDERS.includes(e.name) || FOLDERS_V3.includes(e.name))) || (depth === 1 && rel === 'archive' && DEVICE.test(e.name))) await dir(r, depth + 1);
        } else if (e.isFile() && (parseName(r) || parseNameV3(r))) {
          try {
            const s = await fs.stat(join(FILES, r));
            out.push({ name: r, size: s.size, modified: s.mtime.toISOString(), version: versionOf(s), by: S.files[r]?.by ?? null });
          } catch {
            /* removed while listing */
          }
        }
      }
    }
    await dir('', 0);
    out.sort((a, b) => a.name.localeCompare(b.name));
    sizes.clear();
    total = 0;
    for (const f of out) {
      sizes.set(f.name, f.size);
      total += f.size;
    }
    return out;
  }
  await walk();
  // Forget who wrote files that are gone.
  for (const k of Object.keys(S.files)) if (!sizes.has(k)) delete S.files[k];
  // 0.9.4: the mode, on the first start of 0.9.4: a server phones already use keeps their household
  // as it is (v2) until its owner phone hands it over; an empty one is new.
  if (!S.mode) {
    const used = Object.keys(S.devices).length > 0 || [...sizes.keys()].some((n) => parseName(n)?.kind === 'sync');
    S.mode = used ? 'v2' : 'new';
    await st.save();
  }

  /**
   * Is this file really in the files folder? Its folder (archive/<device>/ and so on) mustn't be
   * a link to somewhere else, and the file itself mustn't be a link (whoever can write to the data
   * volume can't make the server hand out or overwrite files outside it).
   */
  async function insideFiles(file) {
    try {
      const dir = await fs.realpath(dirname(file));
      if (dir !== REAL_FILES && !dir.startsWith(REAL_FILES + sep)) return false;
    } catch {
      return false;
    }
    const l = await fs.lstat(file).catch(() => null);
    return !l || !l.isSymbolicLink();
  }

  // ---- the trash: deleted or replaced archive/ and photos/ files, kept LIMITS.trashDays ----
  // A phone deletes its own copy of what it moved to the server, so the server's copy may be the
  // only one: nothing there is ever simply gone. trash/<when>/<name>; see the README.
  let trashBytes = 0;
  let trashCleaned = -Infinity;
  const trashStamp = (t) => new Date(t).toISOString().replace(/:/g, '-'); // 2026-11-09T22-56-00.123Z
  function stampTime(dir) {
    const m = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})\.(\d{3})Z(?:-[0-9a-f]+)?$/.exec(dir);
    return m ? Date.parse(`${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}Z`) : NaN;
  }
  async function sizeOf(path) {
    const l = await fs.lstat(path).catch(() => null);
    if (!l || l.isSymbolicLink()) return 0;
    if (l.isFile()) return l.size;
    if (!l.isDirectory()) return 0;
    let n = 0;
    for (const e of await fs.readdir(path).catch(() => [])) n += await sizeOf(join(path, e));
    return n;
  }
  /** Empties what's been in the trash longer than LIMITS.trashDays (at most once a day unless forced). */
  async function cleanTrash(force = false) {
    if (!force && now() - trashCleaned < DAY) return;
    trashCleaned = now();
    let size = 0;
    for (const e of await fs.readdir(TRASH, { withFileTypes: true }).catch(() => [])) {
      const p = join(TRASH, e.name);
      const t = stampTime(e.name);
      if (!e.isDirectory() || !Number.isFinite(t) || now() - t > LIMITS.trashDays * DAY) {
        await fs.rm(p, { recursive: true, force: true }).catch((err) => log('trash:', err.message));
        if (Number.isFinite(t)) note('trash-emptied', { when: e.name });
      } else size += await sizeOf(p);
    }
    trashBytes = size;
  }
  /** Moves a file to the trash. False if there was nothing to move. */
  async function toTrash(name, file, by, why) {
    const l = await fs.lstat(file).catch(() => null);
    if (!l?.isFile()) return false;
    let dir = join(TRASH, trashStamp(now()));
    if (existsSync(join(dir, ...name.split('/')))) dir += '-' + randomBytes(3).toString('hex');
    const dest = join(dir, ...name.split('/'));
    await fs.mkdir(dirname(dest), { recursive: true });
    await fs.rename(file, dest);
    trashBytes += l.size;
    note('trashed', { file: name, by, size: l.size, why, kept: dir.slice(DATA.length + 1) });
    return true;
  }
  /** 0.9.5 (Data, "Backups"): empties the trash folders made before `cutoff` (ISO; all with none). How many went. */
  async function emptyTrash(cutoff, { dryRun = false } = {}) {
    const before = cutoff ? Date.parse(cutoff) : Infinity;
    let n = 0;
    for (const e of await fs.readdir(TRASH, { withFileTypes: true }).catch(() => [])) {
      const t = stampTime(e.name);
      if (Number.isFinite(t) && t >= before) continue;
      // 0.9.5 (review): a dry run (Delete's Step 1) only counts.
      if (dryRun) {
        n++;
        continue;
      }
      await fs.rm(join(TRASH, e.name), { recursive: true, force: true }).catch((err) => log('trash:', err.message));
      n++;
    }
    if (!dryRun) await cleanTrash(true);
    return n;
  }
  /** 0.9.5: the trash, for the Data page: { folders, files, bytes, oldest (ISO) }. */
  async function trashInfo() {
    let folders = 0;
    let files = 0;
    let oldest = null;
    const count = async (p) => {
      for (const e of await fs.readdir(p, { withFileTypes: true }).catch(() => [])) {
        if (e.isDirectory()) await count(join(p, e.name));
        else if (e.isFile()) files++;
      }
    };
    for (const e of await fs.readdir(TRASH, { withFileTypes: true }).catch(() => [])) {
      const t = stampTime(e.name);
      if (!e.isDirectory() || !Number.isFinite(t)) continue;
      folders++;
      if (oldest === null || t < oldest) oldest = t;
      await count(join(TRASH, e.name));
    }
    return { folders, files, bytes: await sizeOf(TRASH), oldest: oldest === null ? null : new Date(oldest).toISOString() };
  }
  await cleanTrash(true);
  const trashTimer = setInterval(() => void cleanTrash().catch((e) => log('trash:', e.message)), 60 * MIN);
  trashTimer.unref();

  // ---- files: reading, writing and deleting one (v2's rules; v3 calls these too) ----

  /** GET/HEAD of a file the caller may read (ETag, 304, streamed). */
  async function serveFile(req, res, actor, name) {
    const method = req.method;
    const file = join(FILES, ...name.split('/'));
    let fh;
    try {
      if (!(await insideFiles(file))) throw new Error('outside');
      fh = await fs.open(file, fsc.O_RDONLY | (fsc.O_NOFOLLOW ?? 0));
      if (!(await fh.stat()).isFile()) {
        await fh.close();
        throw new Error('not a file');
      }
    } catch {
      throw new HttpError(404, 'not-found', "That file isn't on the server.");
    }
    try {
      const s = await fh.stat();
      const etag = `"${versionOf(s)}"`;
      noteFetch(name, actor.by);
      const headers = {
        ...SECURITY,
        'Content-Security-Policy': API_CSP,
        'Cache-Control': 'no-store',
        'Content-Type': 'application/octet-stream',
        'X-Restock-Time': String(now()),
        'X-Restock-Version': versionOf(s),
        ETag: etag,
        ...(res.cookies.length ? { 'Set-Cookie': res.cookies } : {}),
      };
      if (String(req.headers['if-none-match'] || '') === etag) {
        res.writeHead(304, headers);
        res.end();
        await fh.close();
        return;
      }
      res.writeHead(200, { ...headers, 'Content-Length': s.size });
      if (method === 'HEAD') {
        res.end();
        await fh.close();
        return;
      }
      const stream = fh.createReadStream();
      stream.pipe(res);
      await new Promise((ok) => stream.on('close', ok));
    } catch (e) {
      await fh.close().catch(() => {});
      throw e;
    }
  }

  /** DELETE of a file the caller may write: archive/ and photos/ to the trash; photos only by the phone that put them here. */
  async function deleteFile(actor, name, parsed) {
    const file = join(FILES, ...name.split('/'));
    const there = (await insideFiles(file)) && (await fs.lstat(file).catch(() => null))?.isFile();
    if (!there) throw new HttpError(404, 'not-found', "That file isn't on the server.");
    // A photo can be shared by phones (the same receipt photo): only the phone that put it here
    // deletes it. Another phone asking is letting go of its use of it, which is all it needs (so
    // it's answered 200, as a phone expects), but the file stays for the phone that put it here.
    if (parsed.kind === 'photo' && S.files[name]?.by !== actor.by) {
      note('photo-kept', { file: name, by: actor.by });
      return { deleted: null, kept: name, message: 'Another phone put this photo here, so it stays until that phone deletes it.' };
    }
    try {
      if (parsed.kind === 'archive' || parsed.kind === 'photo') await toTrash(name, file, actor.by, 'deleted');
      else await fs.unlink(file);
    } catch {
      throw new HttpError(404, 'not-found', "That file isn't on the server.");
    }
    total -= sizes.get(name) ?? 0;
    sizes.delete(name);
    delete S.files[name];
    st.saveSoon();
    note('delete', { file: name, by: actor.by });
    return { deleted: name };
  }

  /** PUT of a file the caller may write, its body already checked: caps, the trash for replaced archives and photos, atomic. */
  async function putFile(actor, name, parsed, body) {
    const file = join(FILES, ...name.split('/'));
    const old = sizes.get(name) ?? 0;
    // Someone else's archive or photo replaced by something different: the old one goes to the trash.
    let trashOld = false;
    if ((parsed.kind === 'archive' || parsed.kind === 'photo') && sizes.has(name) && S.files[name]?.by !== actor.by) {
      const was = await fs.readFile(file).catch(() => null);
      trashOld = !!was && !was.equals(body);
    }
    const over = () => total - old + body.length + trashBytes + (trashOld ? old : 0) > maxTotal;
    if (over()) await cleanTrash(); // anything due out of the trash goes first (at most daily)
    if (over()) {
      throw new HttpError(507, 'full', 'The server is full. Free up space or raise RESTOCK_MAX_TOTAL_MB (deleted files stay in the trash for 30 days).');
    }
    total += body.length - old; // held while writing, so two uploads can't both squeeze in
    sizes.set(name, body.length);
    try {
      await fs.mkdir(dirname(file), { recursive: true });
      if (!(await insideFiles(file))) throw new HttpError(409, 'name', "That file's folder on the server isn't a plain folder.");
      if (trashOld) await toTrash(name, file, actor.by, 'replaced by ' + actor.by);
      await atomicWrite(file, body, TMP);
    } catch (e) {
      total -= body.length - old;
      if (old) sizes.set(name, old);
      else sizes.delete(name);
      throw e;
    }
    const s = await fs.stat(file);
    S.files[name] = { by: actor.by };
    st.saveSoon();
    note('upload', { file: name, by: actor.by, size: body.length });
    return { name, size: s.size, modified: s.mtime.toISOString(), version: versionOf(s), by: actor.by };
  }

  /** A file the server writes itself (its own sync file, keys/<device>.bin): synchronous, atomic, counted. */
  function writeServerFile(name, bytes) {
    const file = join(FILES, ...name.split('/'));
    mkdirSync(dirname(file), { recursive: true });
    const old = sizes.get(name) ?? 0;
    atomicWriteSync(file, Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength), TMP);
    total += bytes.byteLength - old;
    sizes.set(name, bytes.byteLength);
    S.files[name] = { by: 'srv-' + S.sid };
    st.saveSoon();
  }
  function deleteServerFile(name) {
    const file = join(FILES, ...name.split('/'));
    rmSync(file, { force: true });
    total -= sizes.get(name) ?? 0;
    sizes.delete(name);
    delete S.files[name];
  }
  /** Moves a file to the trash (Keep data for, starting afresh). False if it wasn't there. */
  async function trashFile(name, by, why) {
    const file = join(FILES, ...name.split('/'));
    if (!(await insideFiles(file))) return false;
    const moved = await toTrash(name, file, by, why).catch(() => false);
    if (moved) {
      total -= sizes.get(name) ?? 0;
      sizes.delete(name);
      delete S.files[name];
      st.saveSoon();
    }
    return moved;
  }

  // ---- handlers ----

  function need(actor, what) {
    if (!actor || actor.type === 'none') throw new HttpError(401, 'auth', 'Sign in first.');
    if (actor.type === 'gone') throw new HttpError(401, 'signed-out', "You've been signed out. Sign in again.");
    if (what === 'phone' && actor.type !== 'phone') throw new HttpError(403, 'forbidden', 'Only a phone can do that.');
    if (what === 'phone') return;
    if (actor.type === 'phone') {
      if (what === 'phone-or-session') return;
      throw new HttpError(403, 'forbidden', 'Do this from the web page.');
    }
    if (what === 'any-session') return;
    if (actor.kind === 'setup') throw new HttpError(403, 'mustChange', 'Set a passphrase first.');
    if (what === 'passphrase' && actor.kind !== 'passphrase') throw new HttpError(403, 'passphrase', 'Sign in with your passphrase to do that.');
  }

  function vaultString(v, required) {
    if (v === null || v === undefined) {
      if (required) throw new HttpError(400, 'bad-request', 'The vault is missing.');
      return null;
    }
    const b = unb64(v);
    if (!b || b.length < 32 || b.length > LIMITS.maxVault || b.subarray(0, 4).toString('latin1') !== 'RSV2') throw new HttpError(400, 'vault', "That isn't a Restock vault.");
    return v;
  }
  function webKeyPair(body) {
    const { webId, webPub } = body;
    if (webId === undefined && webPub === undefined) return null;
    if (!WEB_ID.test(String(webId ?? ''))) throw new HttpError(400, 'webId', 'The webId must be 8-60 letters, numbers, - or _.');
    if (!p256Key(webPub)) throw new HttpError(400, 'webPub', "The webPub isn't a P-256 public key.");
    return { webId, webPub };
  }
  /** Registers the web's id and public key (a new one retires the old; a retired one can't come back). */
  function registerWeb(pair) {
    if (S.retiredWebIds.includes(pair.webId)) throw new HttpError(400, 'webId', 'That webId was retired. Make a new one.');
    if (pair.webId !== S.account.webId) retireWebId(S.account.webId);
    const changed = pair.webId !== S.account.webId || pair.webPub !== S.account.webPub;
    S.account.webId = pair.webId;
    S.account.webPub = pair.webPub;
    return changed;
  }
  function retireWebId(id) {
    if (!id) return;
    if (!S.retiredWebIds.includes(id)) S.retiredWebIds.push(id);
    if (S.retiredWebIds.length > 500) S.retiredWebIds = S.retiredWebIds.slice(-500);
  }
  function relayAnswer(body, actor) {
    if (!p256Key(body.pub)) throw new HttpError(400, 'pub', "The phone's key isn't a P-256 public key.");
    const sealed = unb64(body.sealed);
    if (!sealed || sealed.length < 28 || sealed.length > LIMITS.maxSealed) throw new HttpError(400, 'sealed', "That isn't a sealed answer.");
    return { pub: body.pub, sealed: body.sealed, device: actor.device, deviceName: S.devices[actor.device]?.name ?? null };
  }
  function relay(id, kind) {
    if (!/^[A-Za-z0-9_-]{20,64}$/.test(id)) throw new HttpError(404, 'not-found', "That code isn't on this server.");
    const r = relays.get(id);
    if (!r || r.kind !== kind) throw new HttpError(404, 'not-found', "That code isn't on this server.");
    if (r.expires < now()) {
      relays.delete(id);
      throw new HttpError(410, 'expired', 'That code has expired. Make a new one.');
    }
    return r;
  }
  function makeRelay(kind, extra) {
    if (relays.size >= LIMITS.maxRelays) {
      for (const [k, v] of relays) if (v.expires < now()) relays.delete(k);
      if (relays.size >= LIMITS.maxRelays) throw new HttpError(429, 'busy', 'Too many codes waiting. Try again in a few minutes.');
    }
    const id = token(16);
    const ms = kind === 'link' ? LIMITS.linkMs : LIMITS.qrLoginMs;
    relays.set(id, { kind, expires: now() + ms, answer: null, ...extra });
    return { id, expires: new Date(now() + ms).toISOString(), expiresIn: Math.round(ms / 1000) };
  }
  function signOutPhoneSessions(device) {
    for (const [k, s] of Object.entries(S.sessions)) if (s.kind === 'phone' && s.device === device) delete S.sessions[k];
  }

  async function api(req, res, ip, url) {
    const path = url.pathname;
    const method = req.method;

    if (path === '/api/v2/health' && (method === 'GET' || method === 'HEAD')) return send(req, res, 200, { ok: true, app: 'restock-server', version: VERSION, api: 2 });
    if (path.startsWith('/api/v1/')) throw new HttpError(410, 'gone', 'This server speaks API v2. Update Restock on this phone to 0.9.2 or newer.');
    if (path.startsWith('/api/v3/')) {
      if (!R) throw new HttpError(503, 'core', "This copy of the server was built without the Restock core. Rebuild it (see the README).");
      return R.v3.api(req, res, ip, url);
    }
    if (!path.startsWith('/api/v2/')) throw new HttpError(404, 'not-found', 'Not found.');

    // 0.9.4: once the household lives on the server (v3), phones on v2 are told to update (a
    // 0.9.4 phone then upgrades with its v2 key); a 0.9.3 browser tab still open keeps its session
    // for files; nothing else of v2 is served (no new v2 sign-ins, codes, links or vaults).
    if (S.mode === 'v3' || S.mode === 'released') {
      if (/^Restock2\s/.test(String(req.headers.authorization || ''))) {
        const d = /\bd=([A-Za-z0-9_-]{1,64})/.exec(String(req.headers.authorization))?.[1];
        const dev = d ? S.devices[d] : null;
        if (!dev || (dev.status && dev.status !== 'active')) throw new HttpError(401, 'removed', 'This phone was removed from the server. Add it again from the web page.');
        throw new HttpError(403, 'update', 'Update Restock to keep syncing with your server.', { api: 3 });
      }
      const open =
        (path === '/api/v2/login/salt' && method === 'GET') ||
        (path === '/api/v2/login' && method === 'POST' && !S.account) ||
        path === '/api/v2/logout' ||
        (path === '/api/v2/passphrase' && method === 'POST' && !S.account) ||
        path === '/api/v2/files' ||
        path.startsWith('/api/v2/files/') ||
        (path === '/api/v2/web' && method === 'GET') ||
        (path === '/api/v2/vault' && method === 'GET');
      if (!open) throw new HttpError(409, 'v3', 'The server has moved on to the new Restock web app. Reload this page.', { api: 3 });
    }

    // Who's asking. A phone's header is checked before its body is read; the signature after.
    const isFilePut = method === 'PUT' && path.startsWith('/api/v2/files/');
    const max = isFilePut ? maxFile : LIMITS.maxJson;
    const ph = phoneHeader(req);
    let actor = ph ? null : webActor(req, res) ?? { type: 'none' };
    // A page from another site can't change anything with this browser's session.
    if (actor?.type === 'web' && method !== 'GET' && method !== 'HEAD') {
      const site = String(req.headers['sec-fetch-site'] || '');
      if (site === 'cross-site' || site === 'same-site') throw new HttpError(403, 'forbidden', 'Not from another site.');
      // Over plain http browsers send no Sec-Fetch-Site, and cookies don't keep to one port, so a
      // page on another port of this computer (another app on the same NAS) counts as the same
      // site. A POST from such a page can only be a "simple" one (a form, text/plain): the web
      // app always sends JSON, which another origin can't without the server agreeing first.
      if (method === 'POST' && !/^application\/json(\s*;|$)/i.test(String(req.headers['content-type'] || ''))) {
        throw new HttpError(415, 'forbidden', 'Send JSON (Content-Type: application/json).');
      }
    }
    // Nobody signed in can't send a big file: refused before it's read.
    if (isFilePut && !ph) need(actor, 'phone-or-session');
    const body = method === 'POST' || method === 'PUT' ? await readBody(req, max) : Buffer.alloc(0);
    if (ph) actor = checkPhone(req, ph, body);

    // ---- web login ----
    if (path === '/api/v2/login/salt' && method === 'GET') {
      const user = String(url.searchParams.get('user') ?? '').normalize('NFKC');
      const a = S.account;
      if (a && same(user, a.user)) return send(req, res, 200, { salt: a.salt });
      const len = a ? unb64(a.salt).length : 16;
      const fake = b64u(createHmac('sha256', S.secret).update('salt\n' + user).digest().subarray(0, len));
      // Before a passphrase is set, say so: the page then sends the first-start password instead.
      return send(req, res, 200, a ? { salt: fake } : { salt: fake, setup: true });
    }

    if (path === '/api/v2/login' && method === 'POST') {
      checkLock(ip);
      const b = json(body);
      const user = String(b.user ?? '').normalize('NFKC');
      if (b.password !== undefined) {
        // The first-start login, only while no passphrase has been set, and with the default
        // password only from the home network.
        if (!S.account && isKnownPassword(cfg.password) && !fromHome(req)) {
          note('setup-login-refused', { ip: mask(ip), why: homeHost(req) ? 'default password, not from home' : 'default password, opened with an address that is not a home one' });
          throw new HttpError(403, 'setup-remote', 'Finish setting up Restock server from your home network first (or start it with your own RESTOCK_PASSWORD).');
        }
        const okUser = same(user, cfg.user);
        const okPass = same(String(b.password ?? ''), cfg.password);
        if (S.account || !(okUser & okPass)) {
          failed(ip, 'login');
          note('login-failed', { ip: mask(ip) });
          throw new HttpError(401, 'auth', S.account ? 'Wrong user name or passphrase.' : 'Wrong user name or password.');
        }
        fails.delete(limitKey(ip));
        if (actor.type === 'web') delete S.sessions[actor.hash];
        newSession(req, res, 'setup', { ip: mask(ip) });
        await st.save();
        note('setup-login', { ip: mask(ip) });
        return send(req, res, 200, { mustChange: true, vault: null });
      }
      const auth = unb64(b.auth);
      if (!auth || auth.length !== 32) throw new HttpError(400, 'bad-request', 'The auth key is missing.');
      if (scryptUse.hit('all') > LIMITS.scryptPerMinute) throw new HttpError(429, 'busy', 'The server is busy. Try again in a minute.', { retryAfter: 60 });
      const a = S.account;
      // scrypt runs whatever the user name, so the time doesn't say which part was wrong.
      const hash = await scryptAsync(auth, a ? Buffer.from(a.scrypt.salt, 'base64url') : Buffer.alloc(16));
      const ok = !!a && same(user, a.user) & same(hash, Buffer.from(a.scrypt.hash, 'base64url'));
      if (!ok) {
        failed(ip, 'login');
        note('login-failed', { ip: mask(ip) });
        throw new HttpError(401, 'auth', 'Wrong user name or passphrase.');
      }
      fails.delete(limitKey(ip));
      if (actor.type === 'web') delete S.sessions[actor.hash];
      // 0.9.4: the v3 sign-in's key, learned from the first v2 sign-in after the update.
      if (R && !a.loginKey) a.loginKey = b64u(R.core.loginKeyOf(auth));
      newSession(req, res, 'passphrase', { ip: mask(ip) });
      await st.save();
      note('login', { ip: mask(ip) });
      return send(req, res, 200, { mustChange: false, vault: a.vault ?? null });
    }

    if (path === '/api/v2/logout' && method === 'POST') {
      const b = json(body);
      if (b.everywhere) {
        if (actor.type !== 'web') throw new HttpError(401, 'auth', 'Sign in first.');
        S.sessions = dict();
        relays.clear();
        await st.save();
        note('signed-out-everywhere', { by: actor.by });
      } else if (actor.type === 'web') {
        delete S.sessions[actor.hash];
        await st.save();
      }
      endSessionCookie(req, res);
      return send(req, res, 200, { ok: true });
    }

    if (path === '/api/v2/passphrase' && method === 'POST') {
      // First start: the setup session. After that only a passphrase session (not one signed in
      // with a phone), and only with the current passphrase's authKey: a stolen session cookie
      // can't take the account over.
      need(actor, S.account ? 'passphrase' : 'any-session');
      const b = json(body);
      if (S.account) {
        checkLock(ip);
        const cur = unb64(b.current);
        if (!cur || cur.length !== 32) throw new HttpError(400, 'current', 'Send the current passphrase too.');
        if (scryptUse.hit('all') > LIMITS.scryptPerMinute) throw new HttpError(429, 'busy', 'The server is busy. Try again in a minute.', { retryAfter: 60 });
        const h = await scryptAsync(cur, Buffer.from(S.account.scrypt.salt, 'base64url'));
        if (!same(h, Buffer.from(S.account.scrypt.hash, 'base64url'))) {
          failed(ip, 'passphrase');
          note('passphrase-change-refused', { ip: mask(ip), by: actor.by });
          throw new HttpError(403, 'current', "That isn't the current passphrase.");
        }
      }
      const salt = unb64(b.salt);
      if (!salt || salt.length < 16 || salt.length > 32) throw new HttpError(400, 'bad-request', 'The salt must be 16-32 random bytes.');
      const auth = unb64(b.auth);
      if (!auth || auth.length !== 32) throw new HttpError(400, 'bad-request', 'The auth key must be 32 bytes.');
      const vault = vaultString(b.vault, false);
      const pair = webKeyPair(b);
      if (pair && (S.retiredWebIds.includes(pair.webId) || pair.webId === S.account?.webId)) throw new HttpError(400, 'webId', 'A new passphrase needs a new webId.');
      const sSalt = randomBytes(16);
      const hash = await scryptAsync(auth, sSalt);
      const first = !S.account;
      retireWebId(S.account?.webId);
      S.account = {
        user: S.account?.user ?? cfg.user,
        salt: b.salt,
        scrypt: { alg: 'scrypt', N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, salt: b64u(sSalt), hash: b64u(hash) },
        vault,
        webId: pair?.webId ?? null,
        webPub: pair?.webPub ?? null,
        setAt: S.account?.setAt ?? new Date(now()).toISOString(),
        changedAt: new Date(now()).toISOString(),
        // 0.9.4: what a v3 sign-in proves it knows (HKDF of the authKey); the passphrase never crosses.
        ...(R ? { loginKey: b64u(R.core.loginKeyOf(auth)) } : {}),
      };
      S.sessions3 = dict();
      // Everyone else is signed out; this browser carries on, now with the passphrase, under a new
      // session cookie (whoever saw the setup one gets nothing from it).
      S.sessions = dict();
      res.cookies.length = 0;
      newSession(req, res, 'passphrase', { ip: mask(ip) });
      relays.clear();
      await st.save();
      note(first ? 'passphrase-set' : 'passphrase-changed', { by: S.account.webId ? 'web-' + S.account.webId : 'web' });
      return send(req, res, 200, { ok: true, mustChange: false, webId: S.account.webId });
    }

    if (path === '/api/v2/vault') {
      if (method === 'GET') {
        // Only for opening with the passphrase: a browser signed in with a phone has no use for it.
        need(actor, 'passphrase');
        return send(req, res, 200, { vault: S.account?.vault ?? null });
      }
      if (method === 'PUT') {
        need(actor, 'passphrase');
        const b = json(body);
        const v = vaultString(b.vault, true);
        const pair = webKeyPair(b);
        const changed = pair ? registerWeb(pair) : false;
        S.account.vault = v;
        await st.save();
        note('vault-saved', { by: S.account.webId ? 'web-' + S.account.webId : 'web' });
        if (changed) note('web-key-registered', { by: 'web-' + S.account.webId });
        return send(req, res, 200, { ok: true, webId: S.account.webId });
      }
    }

    if (path === '/api/v2/web') {
      if (method === 'GET') {
        need(actor, 'phone-or-session');
        const a = S.account;
        const out = { webId: a?.webId ?? null, webPub: a?.webPub ?? null, webs: a?.webId && a?.webPub ? [{ webId: a.webId, webPub: a.webPub }] : [] };
        if (actor.type === 'web') {
          out.user = a?.user ?? null;
          out.mustChange = false;
          out.session = { kind: actor.kind, webId: actor.webId, approvedBy: actor.session.device ?? null };
        }
        return send(req, res, 200, out);
      }
      if (method === 'PUT') {
        need(actor, 'passphrase');
        const pair = webKeyPair(json(body));
        if (!pair) throw new HttpError(400, 'bad-request', 'Send webId and webPub.');
        registerWeb(pair);
        await st.save();
        note('web-key-registered', { by: 'web-' + pair.webId });
        return send(req, res, 200, { webId: pair.webId, webPub: pair.webPub });
      }
    }

    // ---- phones ----
    if (path === '/api/v2/invites' && method === 'POST') {
      need(actor, 'session');
      for (const [k, v] of invites) if (v.expires < now()) invites.delete(k);
      if ([...invites.values()].filter((v) => !v.used).length >= LIMITS.maxInvites) throw new HttpError(429, 'busy', 'Too many invites waiting. Use one or wait 10 minutes.');
      const invite = token(32);
      invites.set(b64u(sha256(invite)), { expires: now() + LIMITS.inviteMs, used: false });
      const here = origin(req);
      const home = cfg.homeUrl || here;
      const away = cfg.awayUrl || (here && here !== home ? here : null);
      const p = new URLSearchParams();
      if (home) p.set('h', home);
      if (away) p.set('a', away);
      p.set('i', invite);
      note('invite-made', { by: actor.by });
      return send(req, res, 200, {
        invite,
        expires: new Date(now() + LIMITS.inviteMs).toISOString(),
        expiresIn: LIMITS.inviteMs / 1000,
        home,
        away,
        code: 'restock-server:2?' + p.toString(),
      });
    }

    if (path === '/api/v2/devices') {
      if (method === 'GET') {
        need(actor, 'session');
        const devices = Object.entries(S.devices)
          .map(([device, d]) => {
            const seen = d.lastSeen ? new Date(d.lastSeen).toISOString() : null;
            return { device, name: d.name, added: new Date(d.added).toISOString(), lastSeen: seen, seen };
          })
          .sort((a, b) => a.added.localeCompare(b.added));
        return send(req, res, 200, { devices });
      }
      if (method === 'POST') {
        checkLock(ip);
        const b = json(body);
        const inv = typeof b.invite === 'string' && b.invite.length <= 100 ? invites.get(b64u(sha256(b.invite))) : null;
        if (!inv) {
          failed(ip, 'invite');
          throw new HttpError(401, 'invite', "That code isn't from this server. Make a new one on the web page.");
        }
        if (inv.used) throw new HttpError(410, 'used', 'That code was already used. Make a new one for each phone.');
        if (inv.expires < now()) throw new HttpError(410, 'expired', 'That code has expired. Make a new one on the web page.');
        const device = String(b.device ?? '');
        // 0.9.4: nor srv- or keys- (the server's own file, and v3's keys/ names), as on v3.
        if (!DEVICE.test(device) || reservedDevice(device)) throw new HttpError(400, 'device', "That device id won't work.");
        if (!p256Key(b.pub)) throw new HttpError(400, 'pub', "The phone's key isn't a P-256 public key.");
        const name = cleanName(b.name) || 'Phone';
        const again = !!S.devices[device];
        // A listed phone joins again only with its own key: a new invite can't take over another
        // phone's id (and with it its archive and photos).
        if (again && !sameKey(S.devices[device].pub, b.pub)) {
          throw new HttpError(409, 'device-taken', 'That phone is already on this server. Remove it on the Phones page first, then add it again.');
        }
        if (!again && Object.keys(S.devices).length >= LIMITS.maxDevices) throw new HttpError(507, 'full', 'This server has as many phones as it takes.');
        inv.used = true;
        S.devices[device] = { name, pub: b.pub, added: again ? S.devices[device].added : now(), lastSeen: now() };
        if (S.mode === 'new') S.mode = 'v2';
        S.removedDevices = S.removedDevices.filter((d) => d !== device);
        await st.save();
        note(again ? 'phone-rejoined' : 'phone-added', { by: device, name });
        return send(req, res, 200, { ok: true, device, name, server: { app: 'restock-server', version: VERSION, api: 2 } });
      }
    }

    let m = /^\/api\/v2\/devices\/([^/]+)$/.exec(path);
    if (m && method === 'DELETE') {
      const device = /^[A-Za-z0-9_-]{1,64}$/.test(m[1]) ? m[1] : '';
      need(actor, 'phone-or-session');
      if (actor.type === 'phone' && actor.device !== device) throw new HttpError(403, 'forbidden', 'A phone can only remove itself.');
      if (!S.devices[device]) throw new HttpError(404, 'not-found', "That phone isn't on this server.");
      const name = S.devices[device].name;
      delete S.devices[device];
      S.removedDevices = [...S.removedDevices.filter((d) => d !== device), device].slice(-200);
      signOutPhoneSessions(device);
      for (const k of nonces.keys()) if (k.startsWith(device + ':')) nonces.delete(k);
      await st.save();
      note('phone-removed', { by: actor.by, device, name });
      return send(req, res, 200, { removed: device });
    }

    // ---- linking the household to the web, and signing in with a phone ----
    if (path === '/api/v2/link' && method === 'POST') {
      need(actor, 'passphrase');
      const mine = [...relays.values()].filter((r) => r.owner === actor.hash && r.expires > now());
      if (mine.length >= 3) throw new HttpError(429, 'busy', 'Too many link codes waiting. Use one or wait a few minutes.');
      return send(req, res, 200, makeRelay('link', { owner: actor.hash }));
    }
    if (path === '/api/v2/qrlogin' && method === 'POST') {
      if (!S.account) throw new HttpError(409, 'setup', 'Set up the server first.');
      if (qrMade.hit(limitKey(ip)) > LIMITS.qrLoginsPer10Min) throw new HttpError(429, 'rate', 'Too many sign-in codes. Try again in 10 minutes.', { retryAfter: 600 });
      const poll = token(32);
      const r = makeRelay('qrlogin', { poll: b64u(sha256(poll)) });
      res.cookies.push(cookieHeader(QR_COOKIE, poll, Math.round(LIMITS.qrLoginMs / 1000), req, '/api/v2/qrlogin'));
      return send(req, res, 200, r);
    }

    m = /^\/api\/v2\/(link|qrlogin)\/([^/]+)$/.exec(path);
    if (m) {
      const [, kind, id] = m;
      if (method === 'POST') {
        need(actor, 'phone');
        const r = relay(id, kind);
        if (r.answer) throw new HttpError(409, 'used', 'That code was already used.');
        if (kind === 'qrlogin' && !S.account) throw new HttpError(409, 'setup', 'Set up the server first.');
        r.answer = relayAnswer(json(body), actor);
        note(kind === 'link' ? 'web-linked' : 'web-sign-in-approved', { by: actor.device });
        return send(req, res, 200, { ok: true });
      }
      if (method === 'GET') {
        if (kind === 'link') {
          need(actor, 'passphrase');
          const r = relay(id, kind);
          if (r.owner !== actor.hash) throw new HttpError(404, 'not-found', "That code isn't on this server.");
          if (!r.answer) return send(req, res, 200, { status: 'waiting', pending: true, expires: new Date(r.expires).toISOString() });
          relays.delete(id);
          return send(req, res, 200, { status: 'done', pending: false, ...r.answer });
        }
        // qrlogin: only the browser that asked (it holds the poll cookie) gets the session.
        const r = relay(id, kind);
        const poll = cookies(req)[QR_COOKIE];
        if (!poll || !same(b64u(sha256(poll)), r.poll)) throw new HttpError(404, 'not-found', "That code isn't on this server.");
        if (!r.answer) return send(req, res, 200, { status: 'waiting', pending: true, expires: new Date(r.expires).toISOString() });
        relays.delete(id);
        if (!S.devices[r.answer.device]) throw new HttpError(410, 'expired', 'That phone was removed. Try again.');
        if (actor.type === 'web') delete S.sessions[actor.hash];
        res.cookies.length = 0;
        newSession(req, res, 'phone', { device: r.answer.device, ip: mask(ip) });
        res.cookies.push(cookieHeader(QR_COOKIE, '', 0, req, '/api/v2/qrlogin'));
        await st.save();
        note('web-sign-in-with-phone', { by: r.answer.device, ip: mask(ip) });
        return send(req, res, 200, { status: 'done', pending: false, ...r.answer, mustChange: false, webId: S.account.webId ?? null });
      }
    }

    // ---- files ----
    if (path === '/api/v2/files' && method === 'GET') {
      need(actor, 'phone-or-session');
      return send(req, res, 200, { files: (await walk()).filter((f) => parseName(f.name)) });
    }
    m = /^\/api\/v2\/files\/(.+)$/.exec(path);
    if (m) {
      need(actor, 'phone-or-session');
      let name;
      try {
        name = decodeURIComponent(m[1]);
      } catch {
        name = '';
      }
      const parsed = parseName(name);
      if (!parsed) throw new HttpError(400, 'name', "That isn't a Restock file name.");
      if (method === 'GET' || method === 'HEAD') return serveFile(req, res, actor, name);
      if (method === 'PUT' || method === 'DELETE') {
        if (!canWrite(actor, parsed)) {
          throw new HttpError(403, 'forbidden', actor.type === 'web' ? 'The web page can only write its own file.' : 'A phone can only write its own files.');
        }
        if (method === 'DELETE') return send(req, res, 200, await deleteFile(actor, name, parsed));
        if (!bodyOk(parsed, body)) throw new HttpError(400, 'sealed', parsed.kind === 'keys' ? "That isn't a JSON keys file." : "That isn't a sealed Restock file.");
        const out = await putFile(actor, name, parsed, body);
        if (S.mode === 'new') {
          S.mode = 'v2';
          st.saveSoon();
        }
        // 0.9.4: a 0.9.3 browser's tab still open after the handover: its file is merged like any other.
        if (S.mode === 'v3' && parsed.kind === 'sync') R?.merger.queue(name);
        return send(req, res, 200, out);
      }
      throw new HttpError(405, 'method', 'Not allowed.');
    }

    if (path === '/api/v2/activity' && method === 'GET') {
      need(actor, 'session');
      const limit = Math.min(LIMITS.activityKept, Math.max(1, Number(url.searchParams.get('limit')) || 300));
      const devices = Object.fromEntries(Object.entries(S.devices).map(([k, d]) => [k, d.name]));
      return send(req, res, 200, {
        activity: activity
          .slice(-limit)
          .reverse()
          .map((a) => {
            if (!a.by) return a;
            if (String(a.by).startsWith('web')) return { ...a, who: 'Web page' };
            return { ...a, device: a.by, who: devices[a.by] ?? 'A removed phone' };
          }),
        devices,
        server: { version: VERSION, started, files: sizes.size, bytes: total, trashBytes, maxBytes: maxTotal, maxFileBytes: maxFile },
      });
    }

    throw new HttpError(404, 'not-found', 'Not found.');
  }

  // ---- pages ----
  function redirect(req, res, to) {
    res.writeHead(302, { ...SECURITY, Location: to, 'Cache-Control': 'no-store', 'Content-Length': 0 });
    res.end();
  }
  async function servePage(req, res, root, rel, spa) {
    let name;
    try {
      name = decodeURIComponent(rel);
    } catch {
      return send(req, res, 400, 'Bad address', 'text/plain; charset=utf-8');
    }
    if (name.includes('\0') || name.split('/').some((p) => p.startsWith('.'))) return send(req, res, 404, 'Not found', 'text/plain; charset=utf-8');
    let file = resolve(root, name || 'index.html');
    if (file !== root && !file.startsWith(root + sep)) return send(req, res, 404, 'Not found', 'text/plain; charset=utf-8');
    let s = await fs.stat(file).catch(() => null);
    if (s?.isDirectory()) {
      file = join(file, 'index.html');
      s = await fs.stat(file).catch(() => null);
    }
    if (!s?.isFile()) {
      if (!spa || extname(name)) return send(req, res, 404, 'Not found', 'text/plain; charset=utf-8');
      file = join(root, 'index.html');
      s = await fs.stat(file).catch(() => null);
      if (!s?.isFile()) {
        const h = { 'Content-Security-Policy': APP_CSP, 'Cache-Control': 'no-store' };
        return send(req, res, 503, NOT_BUILT, 'text/html; charset=utf-8', h);
      }
    }
    const ext = extname(file).toLowerCase();
    const immutable = spa && /^assets\//.test(name);
    // 0.9.5: the service worker and the manifest are checked every time (so an update is seen);
    // the home screen icons can be kept for a day.
    const icon = spa && PWA_ICON.test(name);
    res.writeHead(200, {
      ...SECURITY,
      ...(spa ? { 'Permissions-Policy': APP_PERMISSIONS } : {}),
      'Content-Security-Policy': spa ? APP_CSP : PAGE_CSP,
      'Content-Type': TYPES[ext] || 'application/octet-stream',
      'Content-Length': s.size,
      'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : icon ? 'public, max-age=86400' : 'no-cache',
    });
    if (req.method === 'HEAD') return res.end();
    const stream = (await fs.open(file, 'r')).createReadStream();
    stream.pipe(res);
    await new Promise((ok) => stream.on('close', ok));
  }
  async function page(req, res, path) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(req, res, 405, { error: 'method' });
    const ready = !!S.account;
    if (path === '/setup') return redirect(req, res, '/setup/');
    if (path.startsWith('/setup/')) {
      const rel = path.slice('/setup/'.length);
      if (ready && (rel === '' || rel === 'index.html')) return redirect(req, res, '/');
      return servePage(req, res, SETUP, rel, false);
    }
    if (!ready) return redirect(req, res, '/setup/');
    return servePage(req, res, APP, path.slice(1), true);
  }

  async function handle(req, res) {
    res.cookies = [];
    const ip = clientIp(req);
    let url;
    try {
      url = new URL(req.url, 'http://x');
    } catch {
      return send(req, res, 400, { error: 'bad-request' });
    }
    try {
      if (requests.hit(limitKey(ip)) > LIMITS.requestsPerMinute) throw new HttpError(429, 'rate', 'Too many requests. Try again in a minute.', { retryAfter: 60 });
      if (url.pathname.startsWith('/api/')) return await api(req, res, ip, url);
      return await page(req, res, url.pathname);
    } catch (e) {
      if (!(e instanceof HttpError)) throw e;
      if (res.headersSent) return res.destroy();
      if (e.status === 413) res.setHeader('Connection', 'close');
      return sendError(req, res, e);
    }
  }

  // ---- 0.9.4: the v3 side (src/v3/), with the helpers it shares with v2 ----
  const core = await loadCore();
  if ((S.mode === 'v3' || S.mode === 'released') && !core) {
    throw new Error("this server keeps its household itself (v3), but the Restock core (core/restock-core.mjs) isn't in this copy. Rebuild it (see the README).");
  }
  if ((S.mode === 'v3' || S.mode === 'released') && !sqliteModule()) throw new Error(nodeProblem());
  if (core) {
    const v2Session = (req, res) => {
      const a = webActor(req, res);
      if (!a || a.type !== 'web') return a;
      // As v2's checks for a session's POST: not from another site, and only JSON.
      const site = String(req.headers['sec-fetch-site'] || '');
      if (site === 'cross-site' || site === 'same-site') throw new HttpError(403, 'forbidden', 'Not from another site.');
      if (req.method === 'POST' && !/^application\/json(\s*;|$)/i.test(String(req.headers['content-type'] || ''))) throw new HttpError(415, 'forbidden', 'Send JSON (Content-Type: application/json).');
      return a;
    };
    R = {
      core,
      sqlite: sqliteModule(),
      cfg,
      S,
      st,
      now,
      log,
      note,
      HttpError,
      DATA,
      FILES,
      TMP,
      LIMITS,
      VERSION,
      maxFile,
      send,
      readBody,
      json,
      walk,
      serveFile,
      putFile,
      deleteFile,
      writeServerFile,
      deleteServerFile,
      trashFile,
      emptyTrash,
      trashInfo,
      listFileNames: () => [...sizes.keys()],
      hasFile: (name) => sizes.has(name),
      verifyPhone,
      nonces,
      forgetNonces: (device) => {
        for (const k of nonces.keys()) if (k.startsWith(device + ':')) nonces.delete(k);
      },
      failed,
      clearFails: (ip) => fails.delete(limitKey(ip)),
      checkLock,
      scryptUse,
      qrMade,
      limitKey,
      mask,
      p256Key,
      sameKey,
      same,
      sha256,
      isHomeAddress,
      cleanName,
      origin,
      v2Session,
      endV2Sessions: () => {
        S.sessions = dict();
        relays.clear();
      },
      // A 0.9.3 browser signed in with this phone (v2's cookie session) goes with it.
      endV2PhoneSessions: signOutPhoneSessions,
      async setPassphrase(salt, auth) {
        const sSalt = randomBytes(16);
        const hash = await scryptAsync(auth, sSalt);
        S.account = {
          ...S.account,
          salt,
          scrypt: { alg: 'scrypt', N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, salt: b64u(sSalt), hash: b64u(hash) },
          loginKey: b64u(core.loginKeyOf(auth)),
          changedAt: new Date(now()).toISOString(),
        };
      },
      sendStream(req, res, stream, headers) {
        res.writeHead(200, { ...SECURITY, 'Content-Security-Policy': API_CSP, 'Cache-Control': 'no-store', 'X-Restock-Time': String(now()), ...headers });
        return new Promise((ok) => {
          stream.on('error', (e) => {
            log('stream:', e.message);
            res.destroy();
            ok();
          });
          res.on('close', ok);
          stream.pipe(res);
        });
      },
    };
    R.v3 = await makeV3(R);
  }

  // Slow and idle connections (0.9.4 review). No endpoint holds an answer back (Sign in with a phone
  // and link codes are polled, each poll answered at once), so these only ever cut a client that
  // stopped sending. A request's headers must arrive within headersTimeout and all of it (a 32 MB
  // upload over a slow mobile connection) within requestTimeout; a kept-alive connection with nothing
  // asked goes after keepAliveTimeout, and one where nothing at all moves either way (an answer too)
  // after idleTimeout. The checks run every connectionsCheckingInterval.
  const T = { ...TIMEOUTS, ...(cfg.timeouts ?? {}) };
  const server = createServer(
    { headersTimeout: T.headersMs, requestTimeout: T.requestMs, keepAliveTimeout: T.keepAliveMs, connectionsCheckingInterval: T.checkMs },
    (req, res) => {
      handle(req, res).catch((e) => {
        log(e?.stack || String(e));
        if (!res.headersSent) sendError(req, res, new HttpError(500, 'server', 'Something went wrong on the server.'));
        else res.destroy();
      });
    },
  );
  server.headersTimeout = T.headersMs;
  server.requestTimeout = T.requestMs;
  server.keepAliveTimeout = T.keepAliveMs;
  server.timeout = T.idleMs;
  server.on('close', () => {
    clearInterval(pruner);
    clearInterval(trashTimer);
    R?.v3.close();
  });

  return {
    server,
    flush: () => st.flush(),
    state: S,
    v3: R,
    wasReset,
    dataDir: DATA,
    appBuilt: () => existsSync(join(APP, 'index.html')),
  };
}

// Run directly: start listening.
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  // What the server writes is for its own user only (household.db can be read: it isn't sealed).
  process.umask(0o077);
  const problem = nodeProblem();
  if (problem) {
    console.error(problem + ` This is Node ${process.versions.node}.`);
    process.exit(1);
  }
  const cfg = config();
  try {
    mkdirSync(cfg.dataDir, { recursive: true });
    accessSync(cfg.dataDir, fsc.W_OK);
  } catch {
    console.error(`Restock server can't write to ${cfg.dataDir}.`);
    console.error('If it is a folder on this computer, let user 1000 write to it:  sudo chown -R 1000:1000 <that folder>');
    process.exit(1);
  }
  const s = await makeServer(cfg).catch((e) => {
    console.error('Restock server could not start: ' + e.message);
    process.exit(1);
  });
  s.server.listen(cfg.port, cfg.host, () => {
    const url = `http://localhost:${cfg.port}`;
    console.log(`Restock server ${VERSION} is running on port ${cfg.port} (data in ${cfg.dataDir}).`);
    console.log('');
    if (s.wasReset) console.log('  The passphrase was reset. Phones are still connected; link the web page with a phone again after you sign in.');
    if (!s.state.account) {
      console.log(`  Open ${url} (or this computer's address, e.g. http://192.168.1.10:${cfg.port}) in a browser.`);
      console.log(`  Log in with ${cfg.user} / your RESTOCK_PASSWORD, then set a passphrase.`);
      if (cfg.password === 'admin') {
        console.log('  (No RESTOCK_PASSWORD was set, so it is "admin". Set your passphrase straight away.)');
        console.log('  With the "admin" password, this first login only works from your home network or Tailscale.');
      } else if (isKnownPassword(cfg.password)) {
        console.log(`  RESTOCK_PASSWORD is still "${cfg.password}", which anyone could guess, so this first login only works`);
        console.log('  from your home network or Tailscale. Set your passphrase straight away.');
      }
    } else {
      console.log(`  Open ${url} (or this computer's address) and sign in with your passphrase.`);
    }
    if (!s.appBuilt()) console.log('  Note: the web app is not built into this copy (public/app/ is missing). Phones can still sync.');
    if (!s.v3) console.log('  Note: the Restock core is not in this copy (core/ is missing), so it can only keep a 0.9.3 household.');
    else if (s.state.mode === 'v2') console.log('  This server keeps a 0.9.3 household. Hand it to the server from the owner phone (Restock 0.9.4).');
    else if (s.state.mode === 'new' && s.state.account) console.log('  Next: open the web page and Set up this server.');
    console.log('');
  });
  const stop = () => {
    s.server.close();
    s.flush().finally(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}
