// Which files the server keeps, who may write each one, and what each must look like.
// Anything not matched here is refused (docs/server-protocol.md, "Files").

export const DEVICE = /^[A-Za-z0-9_-]{1,64}$/;
export const WEB_ID = /^[A-Za-z0-9_-]{8,60}$/;

const SYNC = /^restock-sync-([A-Za-z0-9_-]{1,64})\.bin$/;
const KEYS = /^restock-sync-keys-([A-Za-z0-9_-]{1,64})\.json$/;
const ARCHIVE = /^archive\/([A-Za-z0-9_-]{1,64})\/(\d{4}-(?:0[1-9]|1[0-2]))\.bin$/;
const PHOTO = /^photos\/([0-9a-f]{64})\.bin$/;
const WEBKEYS = /^webkeys\/([A-Za-z0-9_-]{8,60})\.bin$/;

/** { name, kind, owner } for an allowed name, or null. */
export function parseName(name) {
  if (typeof name !== 'string' || name.length > 200) return null;
  let m;
  if ((m = KEYS.exec(name))) return { name, kind: 'keys', owner: null };
  if ((m = SYNC.exec(name))) return { name, kind: 'sync', owner: m[1] };
  if ((m = ARCHIVE.exec(name))) return { name, kind: 'archive', owner: m[1] };
  if ((m = PHOTO.exec(name))) return { name, kind: 'photo', owner: null };
  if ((m = WEBKEYS.exec(name))) return { name, kind: 'webkeys', owner: m[1] };
  return null;
}

/** The folders that can hold files, for listing (relative to the files folder). */
export const FOLDERS = ['archive', 'photos', 'webkeys'];

/**
 * May this writer change this file?
 * - a phone: its own sync file and archive, any rekey file, photos and webkeys.
 * - a web session: only restock-sync-web-<its webId>.bin.
 */
export function canWrite(actor, parsed) {
  if (!actor || !parsed) return false;
  if (actor.type === 'web') return parsed.kind === 'sync' && !!actor.webId && parsed.owner === 'web-' + actor.webId;
  if (actor.type === 'phone') {
    if (parsed.kind === 'sync' || parsed.kind === 'archive') return parsed.owner === actor.device;
    return parsed.kind === 'keys' || parsed.kind === 'photo' || parsed.kind === 'webkeys';
  }
  return false;
}

/** Is this body what a file of that kind must be? Sealed (RSF1/RSE2) or, for .json, a JSON object. */
export function bodyOk(parsed, body) {
  if (parsed.kind === 'keys') {
    if (body.length === 0 || body[0] !== 0x7b) return false;
    try {
      const v = JSON.parse(body.toString('utf8'));
      return v !== null && typeof v === 'object' && !Array.isArray(v);
    } catch {
      return false;
    }
  }
  // magic (4) + nonce (12) + GCM tag (16) at the very least
  if (body.length < 32) return false;
  const magic = body.subarray(0, 4).toString('latin1');
  return parsed.kind === 'webkeys' ? magic === 'RSE2' : magic === 'RSF1';
}

// ---------- 0.9.4, protocol v3 (docs/server-protocol.md "v3") ----------
// v2's names, less restock-sync-keys-*.json and webkeys/, plus keys/<device>.bin (the server writes
// those, one per phone, and only that phone may read its own). restock-sync-srv-<sid>.bin is the
// server's own file: nobody else writes it.

const KEYSFILE = /^keys\/([A-Za-z0-9_-]{1,64})\.bin$/;

/** { name, kind, owner } for a name a v3 server allows, or null. kind: sync | archive | photo | keysfile. */
export function parseNameV3(name) {
  if (typeof name !== 'string' || name.length > 200) return null;
  if (KEYS.test(name) || WEBKEYS.test(name)) return null;
  let m;
  if ((m = SYNC.exec(name))) return m[1].startsWith('keys-') ? null : { name, kind: 'sync', owner: m[1] };
  if ((m = ARCHIVE.exec(name))) return { name, kind: 'archive', owner: m[1] };
  if ((m = PHOTO.exec(name))) return { name, kind: 'photo', owner: null };
  if ((m = KEYSFILE.exec(name))) return { name, kind: 'keysfile', owner: m[1] };
  return null;
}

/** Folders a v3 server lists (v2's, and keys/). */
export const FOLDERS_V3 = ['archive', 'photos', 'keys'];

/** Device ids a phone can't have on a v3 server: the server's own, browsers', and the keys file's prefix. */
export const reservedDevice = (d) => /^(srv|web|keys)-/i.test(String(d ?? ''));

/**
 * May this writer change this file on a v3 server?
 * - a phone: its own sync file and archive, and photos (never keys/, never the server's file).
 * - a browser session: only restock-sync-<its webId device>.bin.
 */
export function canWriteV3(actor, parsed) {
  if (!actor || !parsed) return false;
  if (parsed.kind === 'keysfile') return false;
  if (actor.type === 'web3' || actor.type === 'web') return parsed.kind === 'sync' && !!actor.webDevice && parsed.owner === actor.webDevice;
  if (actor.type === 'phone') {
    if (parsed.kind === 'sync' || parsed.kind === 'archive') return parsed.owner === actor.device && !reservedDevice(actor.device);
    return parsed.kind === 'photo';
  }
  return false;
}

/** May this reader see this file on a v3 server? keys/<device>.bin only its phone; the rest anyone signed in. */
export function canReadV3(actor, parsed) {
  if (!actor || !parsed) return false;
  if (parsed.kind === 'keysfile') return actor.type === 'phone' && parsed.owner === actor.device;
  return true;
}

/** A v3 body: RSF1 for every .bin a phone or browser writes (the server writes keys/ itself). */
export function bodyOkV3(parsed, body) {
  if (body.length < 32) return false;
  return body.subarray(0, 4).toString('latin1') === (parsed.kind === 'keysfile' ? 'RSE3' : 'RSF1');
}
