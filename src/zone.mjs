// 0.9.5 (final review): the server's time zone, for its months, days and specials weeks (the Data
// tab) and for when Auto delete runs at night (the 3 o'clock hour). One zone for all of it, worked
// out in JavaScript with Intl (Node's own time zone data), never with SQLite's 'localtime' (which
// needs the system's tzdata, and a container without TZ is on UTC).
//
// The zone is TZ (compose.yaml, the Home Assistant app sets it), else what Node takes as local,
// else UTC.

const valid = (z) => {
  if (typeof z !== 'string' || !z.trim() || z.length > 64) return false;
  try {
    new Intl.DateTimeFormat('en-AU', { timeZone: z.trim() });
    return true;
  } catch {
    return false;
  }
};

/** The zone to use: `TZ` if it's one Node knows ("Australia/Brisbane"), else Node's local zone, else UTC. */
export function serverZone(env = process.env) {
  // A leading ":" (":Australia/Brisbane") is allowed in TZ; Intl doesn't take it.
  const tz = typeof env.TZ === 'string' ? env.TZ.trim().replace(/^:/, '') : '';
  if (valid(tz)) return tz;
  const local = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return valid(local) ? local : 'UTC';
}

const formats = new Map();
function format(zone) {
  let f = formats.get(zone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric', weekday: 'short' });
    formats.set(zone, f);
  }
  return f;
}
const WEEKDAYS = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** The wall clock in `zone` at `ms`: { y, m (1–12), d, h, min, s, wd (0 = Sunday) }. */
export function partsIn(ms, zone) {
  const out = {};
  for (const p of format(zone).formatToParts(new Date(ms))) out[p.type] = p.value;
  return { y: Number(out.year), m: Number(out.month), d: Number(out.day), h: Number(out.hour) % 24, min: Number(out.minute), s: Number(out.second), wd: WEEKDAYS[out.weekday] ?? 0 };
}

/** How far `zone` is ahead of UTC at `ms`, in ms. */
function offsetAt(ms, zone) {
  const p = partsIn(ms, zone);
  return Date.UTC(p.y, p.m - 1, p.d, p.h, p.min, p.s) - Math.floor(ms / 1000) * 1000;
}

/** The moment (ms) a wall-clock time happens in `zone` (month may run over: 13 is next January, 0 last December). */
export function wallTime(zone, y, m, d = 1, h = 0) {
  const guess = Date.UTC(y, m - 1, d, h);
  let t = guess - offsetAt(guess, zone);
  // Once more, for a change of offset (daylight saving) between the guess and the answer.
  t = guess - offsetAt(t, zone);
  return t;
}

const pad = (n) => String(n).padStart(2, '0');
/** yyyy-mm-dd in `zone`. */
export const dayIn = (ms, zone) => {
  const p = partsIn(ms, zone);
  return `${p.y}-${pad(p.m)}-${pad(p.d)}`;
};
/** yyyy-mm in `zone`. */
export const monthIn = (ms, zone) => {
  const p = partsIn(ms, zone);
  return `${p.y}-${pad(p.m)}`;
};
/** The hour (0–23) in `zone`. */
export const hourIn = (ms, zone) => partsIn(ms, zone).h;
