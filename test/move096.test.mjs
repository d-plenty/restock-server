// 0.9.6: "Move to" another list (the app's src/lib/moveLine.ts) through the server. A move is
// ordinary list changes, nothing new for the server to know: between Groceries and General the line
// itself changes (the same id); across tabs (to or from Keg or Health) a new line on the new list and
// a delete of the old one, so a phone that shares only the groceries sees it go (no stale copy), and
// its own older file never brings it back. Home Assistant on the server takes a line moved to Keg
// off its list and never moves it back.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { startFakeHa } from './fake-ha.mjs';
import { house, addPhone, ent, line, rows, SHARE_PANTRY, SHARE_ALL, b64u, stop } from './helpers.mjs';

const TOKEN = 'eyJhbGciOiJIUzI1NiJ9.' + b64u(randomBytes(24));
const linesOf = (t) => rows(t, 'SELECT id, text, section, qty, checked FROM list_entries ORDER BY id');
const listEntries = (f) => f.entries.filter((x) => x.tbl === 'list_entries');

describe('Move to another list, through the server', () => {
  test('across tabs: the old line goes for everyone, the new one is on Keg with its amount; a groceries-only phone’s older file doesn’t bring it back', async () => {
    const t = await house();
    const a = await addPhone(t, 'A');
    const g = await addPhone(t, 'Groceries only');
    const t1 = Date.now() - 10_000;
    const ice = line('l1', 'Ice', { qty: 3 });
    await a.putOwn(a.file([ent('list_entries', 'l1', t1, a.device, ice)], { shares: SHARE_ALL }));
    t.settle();
    // The groceries phone got it, and its own file has it (as it had it then).
    await g.putOwn(g.file([ent('list_entries', 'l1', t1, a.device, ice)], { shares: SHARE_PANTRY }));
    t.settle();
    const t2 = t1 + 5_000;
    await a.putOwn(
      a.file([ent('list_entries', 'l1', t2, a.device, null, { created: t1 }), ent('list_entries', 'l1k', t2, a.device, line('l1k', 'Ice', { qty: 3, section: 'keg' }))], { shares: SHARE_ALL }),
    );
    t.settle();
    assert.deepEqual(linesOf(t), [{ id: 'l1k', text: 'Ice', section: 'keg', qty: 3, checked: 0 }]);
    // What every phone reads: the delete of the old line, and the new one on Keg (a groceries-only phone passes it over).
    const file = await g.serverFile(t.sid);
    const got = new Map(listEntries(file).map((x) => [x.pk, x]));
    assert.equal(got.get('l1')?.deleted, true);
    assert.equal(got.get('l1k')?.row?.section, 'keg');
    // The groceries phone's file again, still with the old line: it doesn't come back.
    await g.putOwn(g.file([ent('list_entries', 'l1', t1, a.device, ice)], { shares: SHARE_PANTRY }));
    t.settle();
    assert.deepEqual(linesOf(t), [{ id: 'l1k', text: 'Ice', section: 'keg', qty: 3, checked: 0 }]);
    // Undo on A: the new line off, the old one made again with its own id.
    const t3 = t2 + 5_000;
    await a.putOwn(a.file([ent('list_entries', 'l1', t3, a.device, ice, { created: t3 }), ent('list_entries', 'l1k', t3, a.device, null, { created: t2 })], { shares: SHARE_ALL }));
    t.settle();
    assert.deepEqual(linesOf(t), [{ id: 'l1', text: 'Ice', section: 'pantry', qty: 3, checked: 0 }]);
    await stop(t);
  });

  test('Groceries to General: the same line changes, from a phone sharing only the groceries too', async () => {
    const t = await house();
    const g = await addPhone(t, 'Groceries only');
    const t1 = Date.now() - 10_000;
    await g.putOwn(g.file([ent('list_entries', 'l2', t1, g.device, line('l2', 'Tape', { qty: 2 }))], { shares: SHARE_PANTRY }));
    t.settle();
    await g.putOwn(g.file([ent('list_entries', 'l2', t1 + 1000, g.device, line('l2', 'Tape', { qty: 2, section: 'general' }), { created: t1 })], { shares: SHARE_PANTRY }));
    t.settle();
    assert.deepEqual(linesOf(t), [{ id: 'l2', text: 'Tape', section: 'general', qty: 2, checked: 0 }]);
    await stop(t);
  });

  test('Home Assistant on the server: a line moved to Keg goes off its list, and its rounds never move it back', async () => {
    const ha = await startFakeHa({ token: TOKEN });
    const t = await house({ haEveryMs: 3_600_000 });
    try {
      const a = await addPhone(t, 'A');
      const t1 = Date.now() - 10_000;
      await a.putOwn(a.file([ent('list_entries', 'l1', t1, a.device, line('l1', 'Ice'))], { shares: SHARE_ALL }));
      t.settle();
      await t.web.req('PUT', '/api/v3/homeassistant', { sealed: { address: ha.url, entity: 'todo.shopping_list', enabled: true, token: TOKEN } });
      await t.web.post('/api/v3/homeassistant/sync', {});
      assert.deepEqual(
        ha.lists['todo.shopping_list'].map((x) => x.summary),
        ['Ice'],
      );
      const t2 = t1 + 5_000;
      await a.putOwn(a.file([ent('list_entries', 'l1', t2, a.device, null, { created: t1 }), ent('list_entries', 'l1k', t2, a.device, line('l1k', 'Ice', { section: 'keg' }))], { shares: SHARE_ALL }));
      t.settle();
      await t.web.post('/api/v3/homeassistant/sync', {});
      await t.web.post('/api/v3/homeassistant/sync', {});
      assert.deepEqual(ha.lists['todo.shopping_list'], []);
      assert.deepEqual(linesOf(t), [{ id: 'l1k', text: 'Ice', section: 'keg', qty: 1, checked: 0 }]);
    } finally {
      await ha.close();
      await stop(t);
    }
  });
});
