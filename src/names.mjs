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
