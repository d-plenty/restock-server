// 0.9.4: the Restock core (core/restock-core.mjs, built from the Restock repo at the same tag as the
// web app: npm run build:server-core). It has the merge engine, the v3 crypto, household settings and
// Home Assistant's sync, so the server runs exactly the code the web app and (ported) the phones do.
// Loaded when it's there; a server without it still runs v2 (and a fresh one), never v3.

import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const CORE_FILE = resolve(process.env.RESTOCK_CORE || join(HERE, '..', '..', 'core', 'restock-core.mjs'));

let loaded;
/** The core module, or null when it isn't built (or isn't protocol 3). */
export async function loadCore() {
  if (loaded !== undefined) return loaded;
  if (!existsSync(CORE_FILE)) return (loaded = null);
  try {
    const m = await import(pathToFileURL(CORE_FILE).href);
    loaded = m?.CORE?.protocol === 3 ? m : null;
  } catch (e) {
    console.error('Restock server: the core (' + CORE_FILE + ') could not be loaded: ' + e.message);
    loaded = null;
  }
  return loaded;
}

/** Bytes for Node: a Buffer over the same memory. */
export const buf = (u8) => Buffer.from(u8.buffer, u8.byteOffset, u8.byteLength);
