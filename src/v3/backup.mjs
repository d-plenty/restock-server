// 0.9.4 (D15): the server's encrypted backup. A tar of state.json (without sessions), keys.json,
// household.db (a consistent copy) and files/, gzipped, then sealed with a key made from a backup
// passphrase typed at download: scrypt → AES-256-GCM. It leaves the server for a laptop's Downloads
// folder, and the server's own data isn't sealed at rest (D1), so the file is.
//
// File: "RSB3" + 2-byte length + header JSON { v: 1, kdf: "scrypt", N, r, p, salt } + 12-byte nonce +
// AES-256-GCM(gzip(tar)) + 16-byte tag; the associated data is everything before the nonce.
// Restore with: node scripts/restore.mjs <backup> <empty data folder>.

import { createCipheriv, createDecipheriv, randomBytes, scrypt } from 'node:crypto';
import { createGzip, createGunzip } from 'node:zlib';
import { Transform, PassThrough, Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createReadStream, promises as fs } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { parseName, parseNameV3 } from '../names.mjs';

export const MAGIC = 'RSB3';
// N = 2^17, r = 8 (128 MB, OWASP's scrypt minimum): the file holds the owner key, every household key,
// the recovery key and the Home Assistant token, and leaves the server. Older backups name their own N.
export const KDF = { N: 131072, r: 8, p: 1 };
const MAXMEM = 256 * 1024 * 1024;

function keyOf(passphrase, salt, { N, r, p }) {
  return new Promise((ok, no) => scrypt(Buffer.from(String(passphrase).normalize('NFKC')), salt, 32, { N, r, p, maxmem: MAXMEM }, (e, k) => (e ? no(e) : ok(k))));
}

// ---------- tar (ustar), just what's needed ----------

function octal(n, len) {
  return Buffer.from(n.toString(8).padStart(len - 1, '0') + '\0', 'latin1');
}
function tarHeader(name, size, mtime) {
  const h = Buffer.alloc(512);
  let prefix = '';
  let base = name;
  if (Buffer.byteLength(name) > 100) {
    const i = name.lastIndexOf('/', name.length - 1);
    prefix = name.slice(0, i);
    base = name.slice(i + 1);
    if (Buffer.byteLength(base) > 100 || Buffer.byteLength(prefix) > 155) throw new Error('name too long for tar: ' + name);
  }
  h.write(base, 0, 100, 'utf8');
  octal(0o600, 8).copy(h, 100);
  octal(0, 8).copy(h, 108);
  octal(0, 8).copy(h, 116);
  octal(size, 12).copy(h, 124);
  octal(Math.floor(mtime / 1000), 12).copy(h, 136);
  h.fill(0x20, 148, 156);
  h.write('0', 156, 1, 'latin1');
  h.write('ustar\0', 257, 6, 'latin1');
  h.write('00', 263, 2, 'latin1');
  h.write(prefix, 345, 155, 'utf8');
  let sum = 0;
  for (const b of h) sum += b;
  Buffer.from(sum.toString(8).padStart(6, '0') + '\0 ', 'latin1').copy(h, 148);
  return h;
}

/** A tar of `entries` ({ name, data } or { name, path }), as a stream. */
export function tarStream(entries) {
  return Readable.from(
    (async function* () {
      for (const e of entries) {
        let data = e.data;
        let mtime = e.mtime ?? Date.now();
        if (!data) {
          try {
            data = await fs.readFile(e.path);
            mtime = (await fs.stat(e.path)).mtimeMs;
          } catch {
            continue; // gone meanwhile
          }
        }
        yield tarHeader(e.name, data.length, mtime);
        yield data;
        const pad = (512 - (data.length % 512)) % 512;
        if (pad) yield Buffer.alloc(pad);
      }
      yield Buffer.alloc(1024);
    })(),
    { objectMode: false },
  );
}

/** Reads a tar stream: calls onEntry(name, data) for each file. */
function untar(onEntry) {
  let buf = Buffer.alloc(0);
  let want = null; // { name, size, pad }
  let ended = false;
  return new Writable({
    async write(chunk, _enc, done) {
      buf = Buffer.concat([buf, chunk]);
      try {
        for (;;) {
          if (ended) break;
          if (!want) {
            if (buf.length < 512) break;
            const h = buf.subarray(0, 512);
            buf = buf.subarray(512);
            if (h.every((b) => b === 0)) {
              ended = true;
              break;
            }
            const str = (a, b) => h.subarray(a, b).toString('utf8').replace(/\0.*$/s, '');
            const size = parseInt(str(124, 136).trim() || '0', 8);
            const type = str(156, 157) || '0';
            const prefix = str(345, 500);
            const name = (prefix ? prefix + '/' : '') + str(0, 100);
            if (!Number.isFinite(size) || size < 0 || size > 64 * 1024 * 1024) throw new Error('a tar entry is too big');
            want = { name, size, pad: (512 - (size % 512)) % 512, type };
          }
          if (buf.length < want.size + want.pad) break;
          const data = Buffer.from(buf.subarray(0, want.size));
          buf = buf.subarray(want.size + want.pad);
          const w = want;
          want = null;
          if (w.type === '0') await onEntry(w.name, data);
          else throw new Error('only plain files belong in a Restock backup');
        }
        done();
      } catch (e) {
        done(e);
      }
    },
  });
}

/** Is this a name a Restock backup may hold? */
export function backupNameOk(name) {
  if (typeof name !== 'string' || name.includes('\0') || name.includes('\\') || name.split('/').some((p) => p === '..' || p === '.' || p === '')) return false;
  if (name === 'state.json' || name === 'keys.json' || name === 'household.db') return true;
  if (!name.startsWith('files/')) return false;
  const rel = name.slice(6);
  return !!(parseName(rel) || parseNameV3(rel));
}

// ---------- sealing ----------

/** The encrypted backup of `entries` with `passphrase`, as a stream. */
export async function backupStream(entries, passphrase) {
  const salt = randomBytes(16);
  const header = Buffer.from(JSON.stringify({ v: 1, kdf: 'scrypt', ...KDF, salt: salt.toString('base64url') }));
  const len = Buffer.alloc(2);
  len.writeUInt16BE(header.length);
  const aad = Buffer.concat([Buffer.from(MAGIC), len, header]);
  const key = await keyOf(passphrase, salt, KDF);
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(aad);
  const out = new PassThrough();
  out.write(aad);
  out.write(nonce);
  const seal = new Transform({
    transform(chunk, _e, done) {
      done(null, cipher.update(chunk));
    },
    flush(done) {
      const last = cipher.final();
      done(null, Buffer.concat([last, cipher.getAuthTag()]));
    },
  });
  pipeline(tarStream(entries), createGzip(), seal, out).catch((e) => out.destroy(e));
  return out;
}

/**
 * Opens a backup file and calls onEntry(name, data) for each file in it. Throws "passphrase" when
 * it doesn't open; nothing it read may be trusted until this resolves (the tag is checked last).
 */
export async function readBackupFile(file, passphrase, onEntry) {
  const fh = await fs.open(file, 'r');
  let size, aad, header, tag;
  try {
    size = (await fh.stat()).size;
    const head = Buffer.alloc(Math.min(size, 6 + 65535));
    await fh.read(head, 0, head.length, 0);
    if (head.subarray(0, 4).toString('latin1') !== MAGIC) throw new Error("That isn't a Restock server backup.");
    const hl = head.readUInt16BE(4);
    header = JSON.parse(head.subarray(6, 6 + hl).toString('utf8'));
    aad = head.subarray(0, 6 + hl);
    tag = Buffer.alloc(16);
    await fh.read(tag, 0, 16, size - 16);
  } finally {
    await fh.close();
  }
  if (header.v !== 1 || header.kdf !== 'scrypt') throw new Error('This backup is from a newer Restock server.');
  const params = { N: Number(header.N), r: Number(header.r), p: Number(header.p) };
  if (!(params.N >= 1024 && params.N <= 1 << 20 && params.r >= 1 && params.r <= 16 && params.p >= 1 && params.p <= 4)) throw new Error('This backup is damaged.');
  const key = await keyOf(passphrase, Buffer.from(String(header.salt), 'base64url'), params);
  const start = aad.length;
  const nonce = Buffer.alloc(12);
  const fh2 = await fs.open(file, 'r');
  await fh2.read(nonce, 0, 12, start);
  await fh2.close();
  const decipher = createDecipheriv('aes-256-gcm', key, nonce);
  decipher.setAAD(aad);
  decipher.setAuthTag(tag);
  try {
    await pipeline(createReadStream(file, { start: start + 12, end: size - 17 }), decipher, createGunzip(), untar(onEntry));
  } catch (e) {
    if (/auth|unable to authenticate|incorrect header|invalid|unexpected end/i.test(String(e?.message))) throw Object.assign(new Error("That backup passphrase doesn't open this backup."), { code: 'passphrase' });
    throw e;
  }
}

/** Restores a backup into an empty folder: written to a folder beside it first, moved in only when it all opened. */
export async function restoreInto(file, passphrase, target) {
  const dest = resolve(target);
  const there = await fs.readdir(dest).catch(() => null);
  if (there && there.length) throw new Error(`${dest} isn't empty. Restore into a new, empty folder.`);
  const work = dest + '.restoring-' + randomBytes(4).toString('hex');
  await fs.mkdir(work, { recursive: true, mode: 0o700 });
  const names = [];
  try {
    await readBackupFile(file, passphrase, async (name, data) => {
      if (!backupNameOk(name)) throw new Error('This backup holds a file that doesn\'t belong in one: ' + JSON.stringify(name.slice(0, 80)));
      const out = resolve(work, ...name.split('/'));
      if (!out.startsWith(work + sep)) throw new Error('bad name');
      await fs.mkdir(dirname(out), { recursive: true });
      await fs.writeFile(out, data, { mode: 0o600 });
      names.push(name);
    });
    if (!names.includes('state.json') || !names.includes('keys.json')) throw new Error('This backup is missing the server\'s own files.');
    await fs.mkdir(dest, { recursive: true });
    for (const e of await fs.readdir(work)) await fs.rename(join(work, e), join(dest, e));
    await fs.rm(work, { recursive: true, force: true });
  } catch (e) {
    await fs.rm(work, { recursive: true, force: true });
    throw e;
  }
  return names;
}
