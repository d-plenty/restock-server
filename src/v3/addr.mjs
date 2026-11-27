// 0.18.3: the server's two addresses, at home and away from home, as phones get them (the `server`
// row and every join code). Phones only use http:// for an address at home (a home or Tailscale
// address, or a name only a home network has), so an away address is always https://.
//
// Before 0.18.3 the server learnt them from the address its page was opened with, scheme and all. Behind
// a Cloudflare tunnel (or any proxy) the request arrives as plain http, so the away address came out as
// http://restock-server.example.com, and a phone scanning the code was told "Restock only uses http://
// for a server at home". It also made the address the page was set up with the home one, whatever it was.

import { isIP } from 'node:net';

/** A host name (no port) that only a home network has: an IP address, localhost, one word, or .local and the like. */
export function homeName(host, isHomeAddress) {
  const name = String(host ?? '').trim().replace(/^\[|\]$/g, '').toLowerCase().replace(/\.$/, '');
  if (!name) return false;
  if (isIP(name)) return isHomeAddress(name);
  return name === 'localhost' || !name.includes('.') || /\.(localhost|local|lan|home\.arpa|internal|ts\.net)$/.test(name);
}

const loopName = (host) => /^(localhost|127\.|::1$)/.test(String(host ?? '').replace(/^\[|\]$/g, ''));

/**
 * An address typed on the web page or an admin phone, tidied (no trailing slash, nothing after the
 * host's path), or { error } in words. `where` is 'home' or 'away'. An empty one is null (none).
 */
export function cleanAddress(typed, where, isHomeAddress) {
  let t = String(typed ?? '').trim();
  if (!t) return { value: null };
  if (t.length > 300) return { error: 'That address is too long.' };
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(t)) t = (where === 'away' ? 'https://' : 'http://') + t;
  let u;
  try {
    u = new URL(t);
  } catch {
    return { error: "That doesn't look like a web address." };
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return { error: 'Use an http:// or https:// address.' };
  if (u.username || u.password) return { error: 'Leave out the "name@" part.' };
  if (u.search || u.hash) return { error: 'Leave out anything after a "?" or "#".' };
  const home = homeName(u.hostname, isHomeAddress);
  if (where === 'away' && u.protocol === 'http:') {
    return { error: home ? "That's an address at home: put it in At home. Away from home needs an https:// address." : 'Away from home needs an https:// address (phones only use http:// at home).' };
  }
  if (where === 'home' && u.protocol === 'http:' && !home) {
    return { error: "Phones only use http:// for an address at home (like 192.168.1.20, a .local name or Tailscale). Put this one in Away from home, with https://." };
  }
  const path = u.pathname.replace(/\/+$/, '');
  return { value: `${u.protocol}//${u.host}${path}` };
}

/**
 * Where an address the page was opened with belongs: { home } (loopback too, with loop: true) or
 * { away }, or null for one that isn't an address. `https` is whether the request was https (as far as
 * the server can tell). An away address is always https: Cloudflare and other tunnels pass plain http on.
 */
export function placeOf(origin, isHomeAddress) {
  let u;
  try {
    u = new URL(String(origin ?? ''));
  } catch {
    return null;
  }
  if (!u.hostname) return null;
  // Loopback (the page opened on the server's own computer): only phones on that computer get there,
  // so it's a home address of last resort (kept only while there's no better one).
  if (loopName(u.hostname)) return { home: `${u.protocol}//${u.host}`, loop: true };
  if (homeName(u.hostname, isHomeAddress)) return { home: `${u.protocol}//${u.host}` };
  return { away: `https://${u.hostname}${u.port && u.port !== '80' && u.port !== '443' ? ':' + u.port : ''}` };
}

/**
 * Puts right an address kept before 0.18.3: an http:// away address, or a home one that isn't at
 * home (both learnt from a tunnel). Returns the house's { home, away } as they should be, and whether
 * that changed anything.
 */
export function repairAddresses(house, isHomeAddress) {
  let { home = '', away = null } = house ?? {};
  let changed = false;
  const fix = (a) => {
    const p = placeOf(a, isHomeAddress);
    return p;
  };
  if (away && /^http:\/\//i.test(away)) {
    const p = fix(away);
    if (p?.away) away = p.away;
    else if (p?.home && !home) {
      home = p.home;
      away = null;
    } else away = null;
    changed = true;
  }
  if (home && /^http:\/\//i.test(home)) {
    const p = fix(home);
    if (p?.away) {
      if (!away) away = p.away;
      home = '';
      changed = true;
    }
  }
  return { home, away, changed };
}
