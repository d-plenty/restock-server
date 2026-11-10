// Shared by the v3 tests: servers on temp folders, a house that's set up, phones that join, a 0.9.3
// household (v2) for the handover, and a few entry makers.

import { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { makeServer, config } from '../src/server.mjs';
import { Browser, Phone, V3Phone, V3Browser, core, b64u, codeFields } from './client.mjs';

export const ITER = 1000;
export const PASS = 'kettle orbit lemon fence';
const servers = [];
after(async () => {
  for (const s of servers.splice(0)) {
    try {
      s.server.close();
      await s.flush();
    } catch {
      /* closed */
    }
    rmSync(s.dir, { recursive: true, force: true });
  }
});

let ipN = 1;
export const freshIp = () => `10.9.${Math.floor(ipN / 250)}.${ipN++ % 250}`;

/** A server on a folder (a temp one by default), with a clock the test can move. */
export async function start(over = {}, dir = mkdtempSync(join(tmpdir(), 'restock-v3-')), { keepDir = false } = {}) {
  const clock = over.clock ?? { shift: 0 };
  const now = () => Date.now() + clock.shift;
  const s = await makeServer({ ...config({}), dataDir: dir, quiet: true, trustProxy: true, now, mergeDelayMs: 5, haAfterMergeMs: 5, ...over });
  await new Promise((r) => s.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${s.server.address().port}`;
  const entry = { ...s, dir, base, clock, now, keepDir };
  servers.push(entry);
  return {
    ...entry,
    R: s.v3,
    browser: (o = {}) => new Browser(base, { ip: freshIp(), ...o }),
    web3: (o = {}) => new V3Browser(base, { ip: freshIp(), ...o }),
    phone: (o = {}) => new Phone(base, { ip: freshIp(), clock: now, ...o }),
    phone3: (o = {}) => new V3Phone(base, { ip: freshIp(), clock: now, ...o }),
    settle: () => s.v3.merger.settle(),
  };
}
/** Stops a server, keeping its folder (to start another on it). */
export async function stop(t) {
  t.server.close();
  await t.flush();
  t.R?.v3.close();
  const i = servers.findIndex((x) => x.server === t.server);
  if (i >= 0) servers.splice(i, 1);
}
export function forget(dir) {
  rmSync(dir, { recursive: true, force: true });
}

/** A fresh 0.9.4 server, set up as a house, with a signed-in v3 browser. */
export async function house(over = {}, { name = 'Declan and Sarah' } = {}) {
  const t = await start(over);
  const setup = t.browser();
  await setup.setup({ passphrase: PASS, iterations: ITER });
  const web = t.web3();
  const l = await web.login('admin', PASS, ITER);
  assert.equal(l.status, 200, JSON.stringify(l.body));
  const s = await web.post('/api/v3/setup', { name });
  assert.equal(s.status, 200, JSON.stringify(s.body));
  assert.equal(s.sealed, true);
  web.gift = s.body;
  return { ...t, web, sid: t.state.sid };
}

/** Adds a phone with an Add a phone code. */
export async function addPhone(t, label = 'Phone', o = {}) {
  const p = t.phone3({ name: label + ' (own name)', ...o });
  const c = await t.web.post('/api/v3/phones', { label });
  assert.equal(c.status, 200, JSON.stringify(c.body));
  const j = await p.join(c.body.code);
  assert.equal(j.status, 200, JSON.stringify(j.body));
  return p;
}

// ---------- entries ----------

export const ent = (tbl, pk, stamp, device, row, more = {}) => ({ tbl, pk, stamp, device, deleted: !row, created: more.created ?? stamp, ...(row ? { row } : {}), ...more });
export const item = (id, section = 'pantry', name = id) => ({ id, name, created_at: '2026-11-01T00:00:00.000Z', section });
export const line = (id, text, more = {}) => ({ id, text, checked: 0, qty: 1, created_at: '2026-11-01T00:00:00.000Z', section: 'pantry', ...more });
export const SHARE_PANTRY = { tabs: ['pantry'], receipts: false, cards: false };
export const SHARE_ALL = { tabs: ['pantry', 'keg', 'pharmacy'], receipts: true, cards: false };

/** Rows of household.db. */
export const rows = (t, sql, ...args) => t.R.merger.raw().prepare(sql).all(...args).map((r) => ({ ...r }));

// ---------- a 0.9.3 household on a v2 server, for the handover ----------

/**
 * A server in v2 mode with a 0.9.3-style household: the owner phone (owner key, household key,
 * its file with the signed owner rows), another member phone, and a signed-in v2 browser.
 */
export async function v2Household(over = {}, dir) {
  const t = await start(over, dir);
  const web = t.browser();
  await web.setup({ passphrase: PASS, iterations: ITER });
  const l = await web.login('admin', PASS, ITER);
  assert.equal(l.status, 200);
  const hh = { key: randomBytes(32), keyv: 1, owner: core.newJavaKeyPair(), hid: 'hid' + b64u(randomBytes(6)) };
  hh.serverKey = core.serverKeyOf(hh.key);
  const owner = t.phone3({ name: 'Declan' });
  const other = t.phone3({ name: 'Sarah' });
  for (const p of [owner, other]) {
    const inv = (await web.post('/api/v2/invites')).body;
    assert.equal((await Phone.prototype.join.call(p, inv.invite)).status, 200);
  }
  const sign = (e) => ({ ...e, sig: core.signWithPkcs8(hh.owner.priv, core.signedText(e)) });
  const now = Date.now();
  let n = 0;
  const hhEntry = (k, v) => sign(ent('household', k, now - 100000 + n++, owner.device, { k, v }));
  const entries = [
    hhEntry('owner_pub', hh.owner.pub),
    hhEntry('owner', owner.device),
    hhEntry('name', 'The Plenty house'),
    hhEntry('hid', hh.hid),
    hhEntry('tabs', 'pantry'),
    hhEntry('receipts', '0'),
    hhEntry('member:' + owner.device, JSON.stringify({ name: 'Declan', pub: owner.my.pub })),
    hhEntry('member:' + other.device, JSON.stringify({ name: 'Sarah', pub: other.my.pub })),
    ent('items', 'i-milk', now - 5000, owner.device, item('i-milk', 'pantry', 'Milk')),
    ent('list_entries', 'l-milk', now - 5000, owner.device, line('l-milk', 'Milk', { item_id: 'i-milk' })),
  ];
  const ownFile = { format: 'restock-sync', v: 1, device: owner.device, name: 'Declan', keyv: 1, at: new Date().toISOString(), top: entries.length, seen: {}, entries };
  const put = await owner.req('PUT', `/api/v2/files/restock-sync-${owner.device}.bin`, { body: Buffer.from(core.sealRsf1(hh.serverKey, ownFile)) });
  assert.equal(put.status, 200, JSON.stringify(put.body));
  const otherFile = { format: 'restock-sync', v: 1, device: other.device, name: 'Sarah', keyv: 1, at: new Date().toISOString(), top: 1, seen: {}, entries: [ent('items', 'i-bread', now - 4000, other.device, item('i-bread', 'pantry', 'Bread'))] };
  assert.equal((await other.req('PUT', `/api/v2/files/restock-sync-${other.device}.bin`, { body: Buffer.from(core.sealRsf1(hh.serverKey, otherFile)) })).status, 200);
  return { ...t, web, hh, owner, other, sign };
}

/** The owner phone's handover payload (RSH3), sealed to the code's kex key with its token. */
export function handoverBody(code, hh, owner, { key = hh.key, ownerKey = hh.owner, ha } = {}) {
  const f = codeFields(code);
  const e = core.newEcdhKey();
  const payload = {
    format: 'restock-handover',
    v: 3,
    key: b64u(key),
    keyv: hh.keyv,
    serverKeys: { [hh.keyv]: b64u(hh.serverKey) },
    owner_priv: ownerKey.priv,
    owner_pubkey: ownerKey.pub,
    owner_secrets: { other: b64u(randomBytes(32)) },
    secret: b64u(randomBytes(32)),
    recovery: core.base32(randomBytes(20)),
    recovery_saved: true,
    hid: hh.hid,
    name: 'The Plenty house',
    ...(ha ? { ha } : {}),
  };
  const sealed = core.sealHandover(core.handoverKey(e.priv, core.unb64(f.k), core.unb64(f.t)), payload);
  return { token: f.t, kex: f.k, json: { epub: b64u(e.pub), sealed: b64u(sealed) } };
}

export { core, b64u, codeFields, Browser, Phone, V3Phone, V3Browser };
