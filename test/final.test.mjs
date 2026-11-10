// 0.9.4 final fixes: "Also take what this phone shared off the server" takes back only what that
// phone made; the passphrase again before the dangerous admin actions; other phones' receipt photos;
// slow and idle connections.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { connect } from 'node:net';
import { randomBytes, createHash } from 'node:crypto';
import { start, house, addPhone, ent, item, line, rows, core, SHARE_ALL, SHARE_PANTRY } from './helpers.mjs';
import { TIMEOUTS } from '../src/server.mjs';

const KEG = { tabs: ['pantry', 'keg'], receipts: false, cards: false };
const origin = (t, pk) => rows(t, "SELECT origin FROM sync_log WHERE tbl = 'items' AND pk = ?", pk)[0]?.origin ?? null;
const has = (t, id) => rows(t, 'SELECT id FROM items WHERE id = ?', id).length === 1;

describe('take back only what this phone made (0.9.4 final fixes)', () => {
  test("a phone's plain deletes of a tab it stopped sharing take back its own records, never other people's, nor ones whose maker isn't known", async () => {
    const t = await house();
    const a = await addPhone(t, 'A');
    const b = await addPhone(t, 'B');
    const now = Date.now();
    // B makes a Keg item; A makes one; A changes B's (so A is the last to change it).
    await b.putOwn(b.file([ent('items', 'b-keg', now - 9000, b.device, item('b-keg', 'keg', 'Cider'))], { shares: KEG }));
    t.settle();
    await a.putOwn(
      a.file(
        [
          ent('items', 'a-keg', now - 8000, a.device, item('a-keg', 'keg', 'Pale ale'), { origin: a.device }),
          ent('items', 'b-keg', now - 7000, a.device, item('b-keg', 'keg', 'Cider (dry)'), { created: now - 9000, origin: b.device }),
          // Changed since it was made, and no origin sent: who made it isn't known.
          ent('items', 'u-keg', now - 6000, a.device, item('u-keg', 'keg', 'Stout'), { created: now - 6500 }),
          // A claims to have made a record someone else changed last: not believed.
          ent('items', 'x-keg', now - 6000, b.device, item('x-keg', 'keg', 'Porter'), { origin: a.device }),
        ],
        { shares: KEG },
      ),
    );
    t.settle();
    assert.equal(origin(t, 'a-keg'), a.device);
    assert.equal(origin(t, 'b-keg'), b.device, 'made by B (stamp = created in its file), kept through A changing it');
    assert.equal(origin(t, 'u-keg'), null);
    assert.equal(origin(t, 'x-keg'), null);
    // A turns Keg off with "Also take what this phone shared off the server": plain deletes for all four.
    const del = (pk) => ent('items', pk, now - 1000, a.device, null, { created: 0 });
    await a.putOwn(a.file(['a-keg', 'b-keg', 'u-keg', 'x-keg'].map(del), { shares: SHARE_PANTRY }));
    t.settle();
    assert.equal(has(t, 'a-keg'), false, "A's own goes");
    assert.equal(has(t, 'b-keg'), true, "B's stays, though A changed it last");
    assert.equal(has(t, 'u-keg'), true, 'one whose maker is unknown stays');
    assert.equal(has(t, 'x-keg'), true);
    // The server passes only that delete on, in its own file.
    const own = await b.serverFile(t.sid);
    const dels = own.entries.filter((x) => x.tbl === 'items' && x.deleted).map((x) => x.pk);
    assert.deepEqual(dels, ['a-keg']);
    // And says who made what it carries.
    assert.equal(own.entries.find((x) => x.pk === 'b-keg').origin, b.device);
  });

  test("review: an ordinary delete on a tab the phone shares is taken whoever made the record (only take-back is limited)", async () => {
    const t = await house();
    const a = await addPhone(t, 'A');
    const b = await addPhone(t, 'B');
    const now = Date.now();
    // B adds a list line and a Keg item; one more whose maker isn't known (changed since it was made).
    await b.putOwn(
      b.file(
        [
          ent('list_entries', 'l-b', now - 9000, b.device, line('l-b', 'Milk')),
          ent('items', 'k-b', now - 9000, b.device, item('k-b', 'keg', 'Cider')),
          ent('items', 'u-b', now - 8000, b.device, item('u-b', 'pantry', 'Tea'), { created: now - 8500 }),
        ],
        { shares: KEG },
      ),
    );
    t.settle();
    assert.equal(origin(t, 'u-b'), null);
    // A, sharing pantry and Keg, deletes all three: an everyday delete, so they go.
    const del = (tbl, pk) => ent(tbl, pk, now - 1000, a.device, null, { created: 0 });
    await a.putOwn(a.file([del('list_entries', 'l-b'), del('items', 'k-b'), del('items', 'u-b')], { shares: KEG }));
    t.settle();
    assert.equal(rows(t, "SELECT id FROM list_entries WHERE id = 'l-b'").length, 0, "someone else's list line");
    assert.equal(has(t, 'k-b'), false, "someone else's Keg item");
    assert.equal(has(t, 'u-b'), false, 'one whose maker is unknown');
    const own = await b.serverFile(t.sid);
    assert.deepEqual(own.entries.filter((x) => x.deleted && x.device === a.device).map((x) => x.pk).sort(), ['k-b', 'l-b', 'u-b']);
  });

  test('a record made again (a newer created) takes its new maker; a delete keeps the old one', async () => {
    const t = await house();
    const a = await addPhone(t, 'A');
    const b = await addPhone(t, 'B');
    const now = Date.now();
    await a.putOwn(a.file([ent('items', 'i1', now - 9000, a.device, item('i1'))], { shares: SHARE_ALL }));
    t.settle();
    await b.putOwn(b.file([ent('items', 'i1', now - 8000, b.device, null, { created: now - 9000 })], { shares: SHARE_ALL }));
    t.settle();
    assert.equal(has(t, 'i1'), false);
    assert.equal(origin(t, 'i1'), a.device);
    await b.putOwn(b.file([ent('items', 'i1', now - 7000, b.device, item('i1'))], { shares: SHARE_ALL }));
    t.settle();
    assert.equal(has(t, 'i1'), true);
    assert.equal(origin(t, 'i1'), b.device);
  });
});

describe('the passphrase again before the dangerous admin actions (0.9.4 final fixes)', () => {
  test('the recovery key and Remove need a fresh passphrase proof; a wrong or reused one is refused', async () => {
    const t = await house();
    const p = await addPhone(t, 'A');
    const g = await t.web.get('/api/v3/recovery');
    assert.equal(g.status, 200);
    assert.equal(g.body.recovery, undefined, 'GET only says whether it was saved');
    const none = await t.web.post('/api/v3/recovery', { confirm: {} });
    assert.equal(none.status, 403);
    assert.equal(none.body.error, 'confirm');
    const bad = await t.web.post('/api/v3/recovery', { confirm: await t.web.confirm(randomBytes(32)) });
    assert.equal(bad.status, 403);
    assert.equal(bad.body.error, 'current');
    const confirm = await t.web.confirm();
    const ok = await t.web.post('/api/v3/recovery', { confirm });
    assert.equal(ok.status, 200);
    assert.match(ok.body.recovery, /^[A-Z2-7]{4}(-[A-Z2-7]{4}){7}$/);
    assert.equal((await t.web.post('/api/v3/recovery', { confirm })).status, 403, 'a challenge is good once');
    // A proof made for another session doesn't count here.
    const other = t.web3();
    await other.login('admin', 'kettle orbit lemon fence', 1000);
    const theirs = await other.confirm();
    assert.equal((await t.web.post('/api/v3/recovery', { confirm: theirs })).status, 403);
    // Review: a name sent with a shorter Keep data for isn't saved when the passphrase is refused.
    const was = t.state.house.name;
    const both = await t.web.put('/api/v3/settings', { name: 'Somewhere else', keepMonths: 3 });
    assert.equal(both.status, 403);
    assert.equal(t.state.house.name, was);
    assert.notEqual(t.R.engine.householdValue('name'), 'Somewhere else');
    // Remove: without the passphrase nothing happens.
    const r0 = await t.web.req('DELETE', '/api/v3/phones/' + p.device);
    assert.equal(r0.status, 403);
    assert.equal(r0.body.error, 'confirm');
    assert.equal(t.state.devices[p.device].status ?? 'active', 'active');
    assert.equal((await t.web.removePhone(p.device)).status, 200);
    assert.equal(t.state.devices[p.device].status, 'removed');
  });
});

describe("other phones' receipt photos (0.9.4 final fixes)", () => {
  const photoOf = (p, bytes, sha = createHash('sha256').update(bytes).digest('hex'), data = bytes) =>
    p.sealFor({ format: 'restock-photo', v: 1, keyv: p.keyv, sha256: sha, type: 'image/jpeg', data: Buffer.from(data).toString('base64') });
  const shaOf = (b) => createHash('sha256').update(b).digest('hex');

  test("a photo must be the one its name says; another phone's file can't repoint a photo path; a photo that isn't there isn't noted", async () => {
    const t = await house();
    const a = await addPhone(t, 'A');
    const b = await addPhone(t, 'B');
    const one = randomBytes(300);
    const two = randomBytes(300);
    const put = (p, sha, body) => p.req('PUT', `/api/v3/files/photos/${sha}.bin`, { body });
    // Another photo under this name, a name that doesn't match what's inside, or not sealed with the household's key.
    let r = await put(b, shaOf(one), photoOf(b, two));
    assert.equal(r.status, 400);
    assert.equal(r.body.error, 'photo');
    r = await put(b, shaOf(one), photoOf(b, one, shaOf(one), two));
    assert.equal(r.status, 400);
    r = await put(b, shaOf(one), Buffer.concat([Buffer.from('RSF1'), randomBytes(64)]));
    assert.equal(r.status, 400);
    // The real ones.
    assert.equal((await put(a, shaOf(one), photoOf(a, one))).status, 200);
    assert.equal((await put(b, shaOf(two), photoOf(b, two))).status, 200);
    // Replacing A's photo with different bytes of the same photo (another seal) is still the same photo.
    assert.equal((await put(b, shaOf(one), photoOf(b, one))).status, 200);
    const photoRow = (path) => rows(t, 'SELECT sha, device FROM srv_photos WHERE path = ?', path)[0];
    await a.putOwn(a.file([], { shares: SHARE_PANTRY, photos: { 'receipts/r1.jpg': shaOf(one), 'receipts/gone.jpg': 'f'.repeat(64) } }));
    t.settle();
    assert.deepEqual({ ...photoRow('receipts/r1.jpg') }, { sha: shaOf(one), device: a.device });
    assert.equal(photoRow('receipts/gone.jpg'), undefined, "a photo that isn't on the server isn't noted");
    // B's file points A's path at B's photo: passed over.
    await b.putOwn(b.file([], { shares: SHARE_PANTRY, photos: { 'receipts/r1.jpg': shaOf(two) } }));
    t.settle();
    assert.equal(photoRow('receipts/r1.jpg').sha, shaOf(one));
    // A itself may change its own.
    await a.putOwn(a.file([], { shares: SHARE_PANTRY, photos: { 'receipts/r1.jpg': shaOf(two) }, at: new Date(Date.now() + 1000).toISOString() }));
    t.settle();
    assert.equal(photoRow('receipts/r1.jpg').sha, shaOf(two));
  });
});

describe('slow and idle connections (0.9.4 final fixes)', () => {
  /** A raw connection: writes `text`, resolves with what came back and how long until it closed. */
  function raw(base, text, waitMs = 5000) {
    const u = new URL(base);
    return new Promise((ok, no) => {
      const s = connect(Number(u.port), u.hostname);
      const t0 = Date.now();
      let got = '';
      s.on('data', (c) => (got += c));
      s.on('close', () => ok({ got, ms: Date.now() - t0 }));
      s.on('error', no);
      s.setTimeout(waitMs, () => {
        s.destroy();
        ok({ got, ms: Date.now() - t0, open: true });
      });
      s.write(text);
    });
  }

  test('the http server has limits on headers, whole requests, kept-alive and idle connections', async () => {
    const t = await start();
    assert.equal(t.server.headersTimeout, TIMEOUTS.headersMs);
    assert.equal(t.server.requestTimeout, TIMEOUTS.requestMs);
    assert.equal(t.server.keepAliveTimeout, TIMEOUTS.keepAliveMs);
    assert.equal(t.server.timeout, TIMEOUTS.idleMs);
    assert.ok(TIMEOUTS.headersMs > TIMEOUTS.keepAliveMs && TIMEOUTS.requestMs >= 5 * 60_000 && TIMEOUTS.idleMs >= 60_000);
  });

  test('a client that stops sending its headers, or its body, is cut off; a kept-alive one with nothing to ask goes; quick answers (the sign-in poll) are untouched', async () => {
    const t = await start({ timeouts: { headersMs: 400, requestMs: 800, keepAliveMs: 300, idleMs: 5000, checkMs: 100 } });
    const half = await raw(t.base, 'GET /api/v3/health HTTP/1.1\r\nHost: x\r\n');
    assert.ok(!half.open, 'closed');
    assert.ok(half.ms < 3000, `${half.ms} ms`);
    assert.match(half.got, /^HTTP\/1\.1 408/);
    const body = await raw(t.base, 'POST /api/v3/qrlogin HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n{"ep');
    assert.ok(!body.open, 'closed');
    assert.ok(body.ms < 4000, `${body.ms} ms`);
    const kept = await raw(t.base, 'GET /api/v3/health HTTP/1.1\r\nHost: x\r\nConnection: keep-alive\r\n\r\n');
    assert.ok(!kept.open, 'closed after the answer');
    assert.match(kept.got, /^HTTP\/1\.1 200/);
    assert.ok(kept.ms < 3000, `${kept.ms} ms`);
    // A poll is answered at once, so the limits never get in its way.
    const r = await fetch(t.base + '/api/v3/qrlogin/' + 'x'.repeat(43));
    assert.ok(r.status < 500);
  });
});
