// 0.15.0: a phone's signed requests (Restock2, docs/server-protocol.md) and the security review's
// checks on files, on the house's routes: these were checked on the 0.9.3 household's routes, which
// are gone. And a server still keeping a 0.9.3 household (v2) says what to do, on every request,
// and serves nothing else.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LIMITS, OLD_HOUSEHOLD } from '../src/server.mjs';
import { addPhone, house, start, stop } from './helpers.mjs';
import { V3Phone } from './client.mjs';

const FILES = '/api/v3/files';

describe('a phone’s signed requests', () => {
  test('a bad, replayed, or altered request is refused', async () => {
    const t = await house();
    const p = await addPhone(t, 'Declan');
    assert.equal((await p.get(FILES)).status, 200);
    const h = p.authHeader('GET', FILES, undefined);
    assert.equal((await p.req('GET', FILES, { header: h })).status, 200);
    const replay = await p.req('GET', FILES, { header: h });
    assert.equal(replay.status, 401);
    assert.equal(replay.body.error, 'replay');
    // Signed for another path, another method.
    assert.equal((await p.req('GET', '/api/v3/phones', { header: p.authHeader('GET', FILES) })).status, 401);
    assert.equal((await p.req('DELETE', `${FILES}/x`, { header: p.authHeader('GET', `${FILES}/x`) })).status, 401);
    // The query is signed too.
    assert.equal((await p.req('GET', `${FILES}?x=1`, { header: p.authHeader('GET', `${FILES}?x=2`) })).status, 401);
    // Another phone's key, garbage, and an unknown phone.
    const other = t.phone3({ device: p.device });
    assert.equal((await other.get(FILES)).status, 401);
    assert.equal((await p.req('GET', FILES, { header: 'Restock2 d=' + p.device + ', t=1, n=x, s=y' })).status, 401);
    assert.equal((await p.req('GET', FILES, { header: 'Bearer abc' })).status, 401);
    const stranger = await t.phone3().get(FILES);
    assert.equal(stranger.status, 401);
  });

  test("clock skew: 401 clock with the server's time, and the retry works", async () => {
    const t = await house();
    const p = await addPhone(t, 'Declan');
    const ahead = p.authHeader('GET', FILES, undefined, { t: t.now() + LIMITS.skewMs + 60_000 });
    const r = await p.req('GET', FILES, { header: ahead });
    assert.equal(r.status, 401);
    assert.equal(r.body.error, 'clock');
    assert.ok(Math.abs(Number(r.headers.get('x-restock-time')) - t.now()) < 5000);
    // A phone whose clock is 20 minutes slow: the client retries once with the offset.
    const slow = new V3Phone(t.base, { device: p.device, clock: () => t.now() - 20 * 60_000 });
    slow.keys = p.keys;
    assert.equal((await slow.get(FILES)).status, 200);
    assert.ok(slow.skew > 19 * 60_000);
    // Within 5 minutes is fine without a retry.
    assert.equal((await p.req('GET', FILES, { header: p.authHeader('GET', FILES, undefined, { t: t.now() - 4 * 60_000 }) })).status, 200);
  });

  test('a nonce is remembered for the whole clock window', async () => {
    const t = await house();
    const p = await addPhone(t, 'Declan');
    const h = p.authHeader('GET', FILES, undefined, { t: t.now() + 4 * 60_000 });
    assert.equal((await p.req('GET', FILES, { header: h })).status, 200);
    t.clock.shift += 8 * 60_000; // still within 5 minutes of the signed time
    assert.equal((await p.req('GET', FILES, { header: h })).status, 401);
  });
});

describe('security review, on the house’s files', () => {
  test('an upload from nobody is refused before its body is read', async () => {
    const t = await house();
    const status = await new Promise((ok, no) => {
      const req = request(t.base + '/api/v3/files/restock-sync-abc.bin', { method: 'PUT', headers: { 'Content-Length': 30 * 1024 * 1024 } }, (r) => {
        r.resume();
        ok(r.statusCode);
        req.destroy();
      });
      req.on('error', () => {});
      req.flushHeaders();
      setTimeout(() => no(new Error('the server waited for the 30 MB body')), 3000);
    });
    assert.equal(status, 401);
  });

  test('bodies held in memory at once are capped', async () => {
    const t = await house();
    const p = await addPhone(t, 'Declan');
    const was = LIMITS.maxInFlightBytes;
    LIMITS.maxInFlightBytes = 1000;
    try {
      const r = await p.putOwn(p.file([], { big: randomBytes(3000).toString('base64') }));
      assert.equal(r.status, 503);
      assert.equal(r.body.error, 'busy');
    } finally {
      LIMITS.maxInFlightBytes = was;
    }
    assert.equal((await p.putOwn(p.file([]))).status, 200, 'and released after');
  });

  test('device ids like __proto__ and constructor are only names', async () => {
    const t = await house();
    for (const id of ['constructor', 'toString', 'hasOwnProperty']) {
      const r = await t.phone3({ device: id }).get(FILES);
      assert.equal(r.status, 401, id);
    }
    const p = await addPhone(t, 'Odd', { device: '__proto__' });
    assert.equal((await p.get(FILES)).status, 200);
    assert.equal(Object.getPrototypeOf(t.state.devices), null);
    await t.flush();
    assert.ok(JSON.parse(readFileSync(join(t.dir, 'state.json'), 'utf8')).devices.__proto__?.pub, 'saved as an ordinary key');
    // ...and it comes back after a restart.
    await stop(t);
    const u = await start({}, t.dir);
    const again = u.phone3({ device: '__proto__' });
    again.keys = p.keys;
    assert.equal((await again.get(FILES)).status, 200);
  });

  test('links in the data volume: never followed out of the files folder', async () => {
    const t = await house();
    const p = await addPhone(t, 'Declan');
    const outside = mkdtempSync(join(tmpdir(), 'restock-outside-'));
    writeFileSync(join(outside, 'secret.txt'), 'NOT-FOR-YOU-' + 'x'.repeat(40));
    try {
      const hex = 'a'.repeat(64);
      mkdirSync(join(t.dir, 'files', 'photos'), { recursive: true });
      symlinkSync(join(outside, 'secret.txt'), join(t.dir, 'files', 'photos', hex + '.bin'));
      assert.equal((await p.get(`${FILES}/photos/${hex}.bin`)).status, 404);
      // A linked folder: nothing is written through it.
      mkdirSync(join(t.dir, 'files', 'archive'), { recursive: true });
      symlinkSync(outside, join(t.dir, 'files', 'archive', p.device));
      const w = await p.req('PUT', `${FILES}/archive/${p.device}/2026-01.bin`, { body: p.sealFor({ format: 'restock-archive', entries: [] }) });
      assert.notEqual(w.status, 200);
      assert.deepEqual(readdirSync(outside), ['secret.txt']);
      await p.req('DELETE', `${FILES}/photos/${hex}.bin`);
      assert.ok(existsSync(join(outside, 'secret.txt')));
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe('0.15.0: a server still keeping a 0.9.3 household', () => {
  test('is found at start, says what to do on every request, and serves nothing else', async () => {
    // A 0.9.3 server's data folder: a phone's sync file, and no mode yet.
    const dir = mkdtempSync(join(tmpdir(), 'restock-old-'));
    mkdirSync(join(dir, 'files'), { recursive: true });
    writeFileSync(join(dir, 'files', 'restock-sync-p0123456789ab.bin'), Buffer.from('RSF1 sealed'));
    const t = await start({}, dir);
    assert.equal(t.state.mode, 'v2');
    const h = await t.browser().get('/api/v3/health');
    assert.equal(h.status, 200);
    assert.equal(h.body.mode, 'v2');
    for (const [m, p] of [
      ['GET', '/api/v2/files'],
      ['GET', '/api/v2/login/salt?user=admin'],
      ['POST', '/api/v2/login'],
      ['GET', '/api/v3/login/challenge?user=admin'],
      ['POST', '/api/v3/setup'],
      ['POST', '/api/v3/join'],
      ['POST', '/api/v3/handover'],
    ]) {
      const r = await t.browser().req(m, p, { json: m === 'GET' ? undefined : {} });
      assert.equal(r.status, 409, `${m} ${p}`);
      assert.equal(r.body.error, 'old-household', `${m} ${p}`);
      assert.equal(r.body.message, OLD_HOUSEHOLD);
    }
    assert.match(OLD_HOUSEHOLD, /0\.14\.1/);
  });

  test("a fresh server never becomes one: the 0.9.3 household's routes are gone", async () => {
    const t = await start();
    assert.equal(t.state.mode, 'new');
    const p = t.phone();
    for (const [m, path] of [
      ['GET', '/api/v2/files'],
      ['PUT', `/api/v2/files/restock-sync-${p.device}.bin`],
      ['POST', '/api/v2/invites'],
      ['GET', '/api/v2/devices'],
      ['POST', '/api/v2/link'],
      ['POST', '/api/v2/qrlogin'],
      ['GET', '/api/v2/activity'],
    ])
      assert.equal((await t.browser().req(m, path, { json: m === 'GET' ? undefined : {} })).status, 404, `${m} ${path}`);
    assert.ok([401, 404].includes((await p.join('x'.repeat(30))).status));
    assert.equal(t.state.mode, 'new');
  });
});
