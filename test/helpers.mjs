// Shared by the v3 tests: servers on temp folders, a house that's set up, phones that join, and a
// few entry makers.

import { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

export { core, b64u, codeFields, Browser, Phone, V3Phone, V3Browser };
