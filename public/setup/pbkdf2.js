// PBKDF2-HMAC-SHA256 in plain JavaScript, for browsers that open the server over plain http
// (a home address like http://192.168.1.10:8787 isn't a "secure context", so crypto.subtle is
// missing there). Uses crypto.subtle when it's available. Checked against Node's in the tests.

const K = Int32Array.from([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);
const IV = Int32Array.from([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
const W = new Int32Array(64);

function compress(H, M, out) {
  for (let i = 0; i < 16; i++) W[i] = M[i];
  for (let i = 16; i < 64; i++) {
    const a = W[i - 15];
    const b = W[i - 2];
    const s0 = ((a >>> 7) | (a << 25)) ^ ((a >>> 18) | (a << 14)) ^ (a >>> 3);
    const s1 = ((b >>> 17) | (b << 15)) ^ ((b >>> 19) | (b << 13)) ^ (b >>> 10);
    W[i] = (W[i - 16] + s0 + W[i - 7] + s1) | 0;
  }
  let a = H[0], b = H[1], c = H[2], d = H[3], e = H[4], f = H[5], g = H[6], h = H[7];
  for (let i = 0; i < 64; i++) {
    const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
    const t1 = (h + S1 + ((e & f) ^ (~e & g)) + K[i] + W[i]) | 0;
    const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
    const t2 = (S0 + ((a & b) ^ (a & c) ^ (b & c))) | 0;
    h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
  }
  out[0] = (H[0] + a) | 0; out[1] = (H[1] + b) | 0; out[2] = (H[2] + c) | 0; out[3] = (H[3] + d) | 0;
  out[4] = (H[4] + e) | 0; out[5] = (H[5] + f) | 0; out[6] = (H[6] + g) | 0; out[7] = (H[7] + h) | 0;
}

/** SHA-256 of `bytes`, carrying on from `state` after `prefixLen` bytes already hashed (a multiple of 64). */
function hashFrom(state, bytes, prefixLen, out) {
  const len = bytes.length;
  const padded = new Uint8Array(Math.ceil((len + 9) / 64) * 64);
  padded.set(bytes);
  padded[len] = 0x80;
  const bits = (prefixLen + len) * 8;
  const dv = new DataView(padded.buffer);
  dv.setUint32(padded.length - 8, Math.floor(bits / 2 ** 32));
  dv.setUint32(padded.length - 4, bits >>> 0);
  const H = Int32Array.from(state);
  const M = new Int32Array(16);
  for (let off = 0; off < padded.length; off += 64) {
    for (let i = 0; i < 16; i++) M[i] = dv.getInt32(off + i * 4);
    compress(H, M, H);
  }
  out.set(H);
  return out;
}
const words = (bytes) => {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return Int32Array.from({ length: bytes.length / 4 }, (_, i) => dv.getInt32(i * 4));
};
const bytesOf = (w) => {
  const out = new Uint8Array(w.length * 4);
  const dv = new DataView(out.buffer);
  w.forEach((x, i) => dv.setInt32(i * 4, x));
  return out;
};

export function sha256(bytes) {
  return bytesOf(hashFrom(IV, bytes, 0, new Int32Array(8)));
}

/** PBKDF2-HMAC-SHA256 in plain JavaScript. */
export function pbkdf2Js(password, salt, iterations, dkLen) {
  let key = password.length > 64 ? sha256(password) : password;
  const ipad = new Uint8Array(64).fill(0x36);
  const opad = new Uint8Array(64).fill(0x5c);
  for (let i = 0; i < key.length; i++) {
    ipad[i] ^= key[i];
    opad[i] ^= key[i];
  }
  const IS = new Int32Array(8);
  const OS = new Int32Array(8);
  compress(IV, words(ipad), IS);
  compress(IV, words(opad), OS);
  const blocks = Math.ceil(dkLen / 32);
  const out = new Uint8Array(blocks * 32);
  const M = new Int32Array(16);
  M[8] = 0x80000000 | 0;
  M[15] = (64 + 32) * 8;
  const U = new Int32Array(8);
  const T = new Int32Array(8);
  const inner = new Int32Array(8);
  for (let b = 1; b <= blocks; b++) {
    const msg = new Uint8Array(salt.length + 4);
    msg.set(salt);
    new DataView(msg.buffer).setUint32(salt.length, b);
    hashFrom(IS, msg, 64, inner);
    M.set(inner, 0);
    compress(OS, M, U);
    T.set(U);
    for (let j = 1; j < iterations; j++) {
      M.set(U, 0);
      compress(IS, M, inner);
      M.set(inner, 0);
      compress(OS, M, U);
      for (let k = 0; k < 8; k++) T[k] ^= U[k];
    }
    out.set(bytesOf(T), (b - 1) * 32);
  }
  return out.slice(0, dkLen);
}

/** PBKDF2-HMAC-SHA256: crypto.subtle if this page has it, otherwise the plain version. */
export async function pbkdf2(password, salt, iterations, dkLen) {
  const subtle = globalThis.crypto?.subtle;
  if (subtle) {
    try {
      const key = await subtle.importKey('raw', password, 'PBKDF2', false, ['deriveBits']);
      return new Uint8Array(await subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, dkLen * 8));
    } catch {
      /* fall back */
    }
  }
  return pbkdf2Js(password, salt, iterations, dkLen);
}
