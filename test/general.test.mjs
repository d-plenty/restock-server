// 0.9.5: the General shopping list on the server (list_entries.section 'general'): it goes with the
// groceries (a phone sharing groceries shares it), Home Assistant's voice adds that match nothing go
// there (and ones that match a Keg or Health item go on that list), and after an update the server
// reads every phone's file again once, for General lines a 0.9.4 server passed over.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { startFakeHa } from './fake-ha.mjs';
import { house, addPhone, ent, item, line, rows, SHARE_PANTRY, SHARE_ALL, core, b64u, stop, start } from './helpers.mjs';

const TOKEN = 'eyJhbGciOiJIUzI1NiJ9.' + b64u(randomBytes(24));
const SHARE_KEG = { tabs: ['keg'], receipts: false, cards: false };
const linesOf = (t) => rows(t, 'SELECT id, text, item_id, section, checked FROM list_entries ORDER BY text');

describe('the General list on the server', () => {
  test('a General line goes with the groceries: kept from a phone sharing them, in the server file, not from one sharing only Keg', async () => {
    const t = await house();
    const a = await addPhone(t, 'A');
    const k = await addPhone(t, 'Keg only');
    const now = Date.now();
    await a.putOwn(
      a.file([ent('list_entries', 'a-gen', now, a.device, line('a-gen', 'Chopsticks', { section: 'general' })), ent('list_entries', 'a-milk', now, a.device, line('a-milk', 'Milk'))], {
        shares: SHARE_PANTRY,
      }),
    );
    await k.putOwn(k.file([ent('list_entries', 'k-gen', now, k.device, line('k-gen', 'Batteries', { section: 'general' }))], { shares: SHARE_KEG }));
    t.settle();
    const got = linesOf(t);
    assert.deepEqual(
      got.map((l) => [l.id, l.section]),
      [
        ['a-gen', 'general'],
        ['a-milk', 'pantry'],
      ],
    );
    const reader = await addPhone(t, 'Reader');
    const own = await reader.serverFile(t.sid);
    const gen = own.entries.find((x) => x.tbl === 'list_entries' && x.pk === 'a-gen');
    assert.equal(gen?.row?.section, 'general');
    await stop(t);
  });

  test('Home Assistant: what matches nothing goes on General, a Keg item on Keg, the pantry first; all still both ways', async () => {
    const ha = await startFakeHa({ token: TOKEN });
    const t = await house({ haEveryMs: 3_600_000 });
    try {
      const a = await addPhone(t, 'A');
      const now = Date.now();
      await a.putOwn(
        a.file(
          [
            ent('items', 'g-milk', now, a.device, item('g-milk', 'pantry', 'Milk')),
            ent('items', 'k-milk', now, a.device, item('k-milk', 'keg', 'Milk')),
            ent('items', 'k-ale', now, a.device, item('k-ale', 'keg', 'Pale ale')),
            ent('list_entries', 'a-bat', now, a.device, line('a-bat', 'Batteries', { section: 'general' })),
          ],
          { shares: SHARE_ALL },
        ),
      );
      t.settle();
      await t.web.req('PUT', '/api/v3/homeassistant', { sealed: { address: ha.url, entity: 'todo.shopping_list', enabled: true, token: TOKEN } });
      ha.say('Chopsticks');
      ha.say('pale ale');
      ha.say('2 milk');
      const uids = ha.lists['todo.shopping_list'].map((x) => x.uid);
      const s = await t.web.post('/api/v3/homeassistant/sync', {});
      assert.equal(s.body.ok, true, JSON.stringify(s.body));
      const id = (u) => core.haLineId('todo.shopping_list', u);
      const byId = new Map(linesOf(t).map((l) => [l.id, l]));
      assert.deepEqual([byId.get(id(uids[0]))?.section, byId.get(id(uids[0]))?.item_id], ['general', null]);
      assert.deepEqual([byId.get(id(uids[1]))?.section, byId.get(id(uids[1]))?.item_id], ['keg', 'k-ale']);
      assert.deepEqual([byId.get(id(uids[2]))?.section, byId.get(id(uids[2]))?.item_id], ['pantry', 'g-milk']);
      // The General line added on a phone went to Home Assistant too.
      assert.ok(ha.lists['todo.shopping_list'].some((x) => x.summary === 'Batteries'));
      // Ticked in Home Assistant: ticked here, on General and on Keg.
      for (const x of ha.lists['todo.shopping_list']) if (x.uid === uids[0] || x.uid === uids[1]) x.status = 'completed';
      await t.web.post('/api/v3/homeassistant/sync', {});
      const after = new Map(linesOf(t).map((l) => [l.id, l]));
      assert.equal(after.get(id(uids[0])).checked, 1);
      assert.equal(after.get(id(uids[1])).checked, 1);
      // Taken off in Home Assistant: off General here too.
      ha.lists['todo.shopping_list'] = ha.lists['todo.shopping_list'].filter((x) => x.uid !== uids[0]);
      await t.web.post('/api/v3/homeassistant/sync', {});
      assert.equal(linesOf(t).some((l) => l.id === id(uids[0])), false);
    } finally {
      await ha.close();
      await stop(t);
    }
  });

  test('after an update the phones’ files are read again once, for General lines a 0.9.4 server passed over', async () => {
    const t = await house();
    const a = await addPhone(t, 'A');
    const now = Date.now();
    await a.putOwn(a.file([ent('list_entries', 'a-gen', now, a.device, line('a-gen', 'Chopsticks', { section: 'general' }))], { shares: SHARE_PANTRY }));
    t.settle();
    assert.equal(rows(t, "SELECT COUNT(*) AS n FROM list_entries WHERE id = 'a-gen'")[0].n, 1);
    // As a 0.9.4 server left it: the file read (folder_seen), the General line passed over, no lists_v.
    const raw = t.R.merger.raw();
    raw.exec("INSERT OR REPLACE INTO sync_meta (key, value) VALUES ('applying', '1')");
    raw.exec("DELETE FROM list_entries WHERE id = 'a-gen'");
    raw.exec("DELETE FROM sync_log WHERE tbl = 'list_entries' AND pk = 'a-gen'");
    raw.exec("DELETE FROM sync_meta WHERE key IN ('applying', 'lists_v')");
    const dir = t.dir;
    await stop(t);
    const t2 = await start({}, dir);
    assert.deepEqual(
      rows(t2, "SELECT id, section FROM list_entries WHERE id = 'a-gen'").map((r) => [r.id, r.section]),
      [['a-gen', 'general']],
    );
    assert.equal(rows(t2, "SELECT value FROM sync_meta WHERE key = 'lists_v'")[0].value, '95');
    await stop(t2);
  });
});
