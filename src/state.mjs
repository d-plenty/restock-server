// The server's own small state (DATA_DIR/state.json), written atomically.
// What's in it: the web user (salt and scrypt hash of the authKey, never the passphrase), the
// sealed vault, the web's public key, the phones' public keys, signed-in sessions (hashes of the
// cookies only), who last wrote each file, and a random secret used for fake login salts.
// 0.9.4: also the mode, the server's id, the house, the login key (v3 sign-in), v3 browser
// sessions (with their session keys) and "Keep data for". Household keys are in keys.json.

import { promises as fs, readFileSync, existsSync, openSync, writeSync, fsyncSync, closeSync, renameSync, rmSync } from 'node:fs';
import { join, basename } from 'node:path';
import { randomBytes } from 'node:crypto';

/** Writes a file so a crash leaves either the old one or the new one, never half of each. */
export async function atomicWrite(path, data, tmpDir) {
  const tmp = join(tmpDir, basename(path) + '.' + randomBytes(6).toString('hex') + '.tmp');
  const fh = await fs.open(tmp, 'wx', 0o600);
  try {
    await fh.writeFile(data);
    await fh.sync();
  } finally {
    await fh.close();
  }
  try {
    await fs.rename(tmp, path);
  } catch (e) {
    await fs.rm(tmp, { force: true });
    throw e;
  }
}

/** The same, synchronously (keys.json, and the handover's steps, whose order must hold through a crash). */
export function atomicWriteSync(path, data, tmpDir) {
  const tmp = join(tmpDir, basename(path) + '.' + randomBytes(6).toString('hex') + '.tmp');
  const fd = openSync(tmp, 'wx', 0o600);
  try {
    writeSync(fd, typeof data === 'string' ? Buffer.from(data) : data);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(tmp, path);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

function fresh() {
  return {
    v: 2,
    secret: randomBytes(32).toString('base64url'),
    account: null,
    retiredWebIds: [],
    devices: {},
    removedDevices: [],
    sessions: {},
    files: {},
    // 0.9.4 (v3): mode ("new" | "v2" | "v3" | "released"), set on the first start of 0.9.4; the
    // server's id (srv-<sid>); the house; Keep data for; browser sessions (v3, keyed by the hash of
    // the session id; each holds its session key).
    sessions3: {},
    // 0.9.5: Auto delete (0.9.4's Keep data for, same key) is off on a new server; an existing
    // state.json keeps what it has (0.9.4 servers wrote 12 or the admin's choice).
    settings: { keepMonths: null },
  };
}

/** A plain key/value object without a prototype (JSON.stringify writes it as usual). */
export function dict(from) {
  const out = Object.create(null);
  if (from && typeof from === 'object' && !Array.isArray(from)) for (const [k, v] of Object.entries(from)) out[k] = v;
  return out;
}

export function openState(dataDir, tmpDir, log = console.error) {
  const file = join(dataDir, 'state.json');
  let data;
  if (existsSync(file)) {
    try {
      data = JSON.parse(readFileSync(file, 'utf8'));
    } catch {
      throw new Error(`${file} is damaged. Restore it from a backup, or move it away to start again (phones will need adding again).`);
    }
  } else {
    data = fresh();
  }
  data = { ...fresh(), ...data, v: 2 };
  // Keyed by ids that come from outside (device ids, file names): no prototype, so an id like
  // "__proto__" or "constructor" is just a key.
  for (const k of ['devices', 'sessions', 'files', 'sessions3']) data[k] = dict(data[k]);
  if (!data.settings || typeof data.settings !== 'object') data.settings = { keepMonths: 12 };
  if (typeof data.secret !== 'string' || data.secret.length < 32) data.secret = randomBytes(32).toString('base64url');

  let chain = Promise.resolve();
  let timer = null;
  function save() {
    if (timer) clearTimeout(timer);
    timer = null;
    const text = JSON.stringify(data);
    chain = chain.then(() => atomicWrite(file, text, tmpDir)).catch((e) => log('saving state:', e.message));
    return chain;
  }
  function saveSoon() {
    if (timer) return;
    timer = setTimeout(save, 3000);
    timer.unref?.();
  }
  const flush = () => (timer ? save() : chain);
  return { data, save, saveSoon, flush, file };
}
