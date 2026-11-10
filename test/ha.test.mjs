// 0.9.4: Home Assistant on the server (docs/server-v3-design.md section 9), against a pretend Home
// Assistant: the core's syncRound over household.db, no doubles with deterministic line ids, and the
// token never in any answer or log.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { startFakeHa } from './fake-ha.mjs';
import { house, addPhone, ent, line, rows, SHARE_PANTRY, core, b64u, stop, start } from './helpers.mjs';

const TOKEN = 'eyJhbGciOiJIUzI1NiJ9.' + b64u(randomBytes(24));

async function withHa(o = {}) {
  const ha = await startFakeHa({ token: TOKEN });
  const t = await house({ haEveryMs: 3_600_000, ...o });
  return { t, ha };
}
const lines = (t) => rows(t, 'SELECT id, text, checked FROM list_entries ORDER BY id');

describe('Home Assistant on the server', () => {
  test('set up from the web (token only sealed, never answered), then both ways', async () => {
    const { t, ha } = await withHa();
    try {
      // The token in plain JSON is refused.
      assert.equal((await t.web.put('/api/v3/homeassistant', { address: ha.url, entity: 'todo.shopping_list', enabled: true, token: TOKEN })).status, 400);
      const test1 = await t.web.req('POST', '/api/v3/homeassistant/test', { sealed: { address: ha.url, token: TOKEN } });
      assert.equal(test1.body.ok, true, JSON.stringify(test1.body));
      assert.deepEqual(test1.body.lists.map((l) => l.entity).sort(), ['todo.groceries', 'todo.shopping_list']);
      assert.equal((await t.web.req('POST', '/api/v3/homeassistant/test', { sealed: { address: ha.url, token: 'wrong-token-12345' } })).body.ok, false);
      const put = await t.web.req('PUT', '/api/v3/homeassistant', { sealed: { address: ha.url, entity: 'todo.shopping_list', enabled: true, token: TOKEN } });
      assert.equal(put.status, 200, JSON.stringify(put.body));
      assert.equal(put.body.hasToken, true);
      assert.equal(put.body.token, undefined);
      // Turned on from the web: the server names itself as the household's Home Assistant runner,
      // as its own change, in its own file (the old HA phone deletes its token and stops on it).
      assert.equal(JSON.parse(rows(t, "SELECT v FROM household_settings WHERE k = 'ha:phone'")[0].v), 'srv-' + t.sid);
      assert.equal(rows(t, "SELECT device FROM sync_log WHERE tbl = 'household_settings' AND pk = 'ha:phone'")[0].device, 'srv-' + t.sid);
      {
        const p0 = await addPhone(t, 'Reader');
        const row = (await p0.serverFile(t.sid)).entries.find((x) => x.pk === 'ha:phone');
        assert.deepEqual([JSON.parse(row.row.v), row.device, !!row.deleted], ['srv-' + t.sid, 'srv-' + t.sid, false]);
      }
      // "Okay Nabu, add milk": it comes onto the list with a line id made from the item.
      ha.say('Milk');
      const uid = ha.lists['todo.shopping_list'][0].uid;
      const s = await t.web.post('/api/v3/homeassistant/sync', {});
      assert.equal(s.body.ok, true, JSON.stringify(s.body));
      assert.deepEqual(lines(t).map((l) => [l.id, l.text]), [[core.haLineId('todo.shopping_list', uid), 'Milk']]);
      // The server's file carries it to the phones.
      const a = await addPhone(t, 'A');
      const own = await a.serverFile(t.sid);
      assert.ok(own.entries.find((x) => x.tbl === 'list_entries' && x.pk === core.haLineId('todo.shopping_list', uid)));
      // A phone adds bread: 4 seconds (here, 5 ms) after the merge, it's on Home Assistant's list.
      await a.putOwn(a.file([ent('list_entries', 'l-bread', Date.now(), a.device, line('l-bread', 'Bread'))], { shares: SHARE_PANTRY }));
      t.settle();
      for (let i = 0; i < 100 && !ha.lists['todo.shopping_list'].some((x) => x.summary === 'Bread'); i++) await new Promise((r) => setTimeout(r, 20));
      assert.ok(ha.lists['todo.shopping_list'].some((x) => x.summary === 'Bread'));
      // Ticked in Home Assistant → ticked here.
      ha.lists['todo.shopping_list'].find((x) => x.summary === 'Milk').status = 'completed';
      await t.web.post('/api/v3/homeassistant/sync', {});
      assert.equal(lines(t).find((l) => l.text === 'Milk').checked, 1);
      // The token is in no answer, no log, no state file, nowhere but keys.json.
      const answers = [await t.web.get('/api/v3/homeassistant'), await t.web.get('/api/v3/activity'), await t.web.get('/api/v3/logs'), await t.web.get('/api/v3/settings'), await t.web.get('/api/v3/session')];
      for (const r of answers) assert.ok(!JSON.stringify(r.body).includes(TOKEN));
      assert.ok(!readFileSync(join(t.dir, 'state.json'), 'utf8').includes(TOKEN));
      assert.ok(!rows(t, 'SELECT * FROM srv_log').some((r) => JSON.stringify(r).includes(TOKEN)));
      assert.ok(!rows(t, 'SELECT * FROM kv').some((r) => JSON.stringify(r).includes(TOKEN)));
      for (const f of readdirSync(join(t.dir, 'files'))) if (f.endsWith('.bin')) assert.ok(!readFileSync(join(t.dir, 'files', f)).includes(Buffer.from(TOKEN)));
      assert.ok(readFileSync(join(t.dir, 'keys.json'), 'utf8').includes(TOKEN));
      // A wrong token: in words, no token in them.
      await t.web.req('PUT', '/api/v3/homeassistant', { sealed: { token: 'another-wrong-token' } });
      const bad = await t.web.post('/api/v3/homeassistant/sync', {});
      assert.equal(bad.body.ok, false);
      assert.match(bad.body.message, /token/);
      assert.ok(!JSON.stringify((await t.web.get('/api/v3/logs')).body).includes('another-wrong-token'));
    } finally {
      await ha.close();
    }
  });

  test('no doubles: a line a phone already made from the same Home Assistant item is paired, not added again', async () => {
    const { t, ha } = await withHa();
    try {
      ha.say('Eggs');
      const uid = ha.lists['todo.shopping_list'][0].uid;
      const id = core.haLineId('todo.shopping_list', uid);
      // A 0.9.4 phone ran Home Assistant before the server did and synced the line it made.
      const a = await addPhone(t, 'A');
      await a.putOwn(a.file([ent('list_entries', id, Date.now(), a.device, line(id, 'Eggs'))], { shares: SHARE_PANTRY }));
      t.settle();
      await t.web.req('PUT', '/api/v3/homeassistant', { sealed: { address: ha.url, entity: 'todo.shopping_list', enabled: true, token: TOKEN } });
      await t.web.post('/api/v3/homeassistant/sync', {});
      await t.web.post('/api/v3/homeassistant/sync', {});
      assert.equal(lines(t).length, 1);
      assert.equal(ha.lists['todo.shopping_list'].length, 1);
    } finally {
      await ha.close();
    }
  });

  test('one runner: not while a 0.9.3 phone still runs it, until the admin says it is off there; off lets go', async () => {
    const { t, ha } = await withHa();
    try {
      const a = await addPhone(t, 'Old phone');
      // As if this phone were a 0.9.3 one on the server (api 2), named as the household's runner.
      t.state.devices[a.device].api = 2;
      t.R.merger.raw().prepare('INSERT OR REPLACE INTO household_settings (k, v) VALUES (?, ?)').run('ha:phone', JSON.stringify(a.device));
      await t.web.req('PUT', '/api/v3/homeassistant', { sealed: { address: ha.url, entity: 'todo.shopping_list', enabled: true, token: TOKEN } });
      ha.say('Milk');
      const r = await t.web.post('/api/v3/homeassistant/sync', {});
      assert.equal(r.body.ok, false);
      assert.match(r.body.message, /still runs on Old phone/);
      const v = (await t.web.get('/api/v3/homeassistant')).body;
      assert.equal(v.phone, a.device);
      assert.equal(v.phoneApi, 2);
      // Still the 0.9.3 phone's row while the server is held back.
      assert.equal(JSON.parse(rows(t, "SELECT v FROM household_settings WHERE k = 'ha:phone'")[0].v), a.device);
      // "It's off on Old phone": taken over at once (the row stops that phone), then it runs.
      await t.web.put('/api/v3/homeassistant', { offOn: a.device });
      assert.equal(JSON.parse(rows(t, "SELECT v FROM household_settings WHERE k = 'ha:phone'")[0].v), 'srv-' + t.sid);
      assert.equal((await t.web.post('/api/v3/homeassistant/sync', {})).body.ok, true);
      // Turned off: it lets go (a delete, in the server's file).
      await t.web.put('/api/v3/homeassistant', { enabled: false });
      assert.equal(rows(t, "SELECT v FROM household_settings WHERE k = 'ha:phone'").length, 0);
      const reader = await addPhone(t, 'Reader');
      const gone = (await reader.serverFile(t.sid)).entries.find((x) => x.pk === 'ha:phone');
      assert.equal(gone.deleted, true);
    } finally {
      await ha.close();
    }
  });

  test("a phone's upgrade brings its Home Assistant, sealed to the server (taken only if the server has none)", async () => {
    const { t, ha } = await withHa();
    try {
      const a = await addPhone(t, 'A');
      t.state.devices[a.device].api = 2;
      const a2 = await addPhone(t, 'A2');
      // Only the phone the household says runs Home Assistant (ha:phone) brings it: another
      // member's isn't taken (it could point the server's requests anywhere).
      t.R.merger.raw().prepare('INSERT OR REPLACE INTO household_settings (k, v) VALUES (?, ?)').run('ha:phone', JSON.stringify(a.device));
      const not = await a2.upgrade(t.R.house.kexPub(), { address: 'http://10.0.0.7:8123', entity: 'todo.shopping_list', enabled: true, token: 'not-the-ha-phone-0123', state: null });
      assert.equal(not.status, 200, JSON.stringify(not.body));
      assert.equal(not.body.ha, undefined);
      assert.equal(t.R.keys.data.ha?.token, undefined);
      const r = await a.upgrade(t.R.house.kexPub(), { address: ha.url, entity: 'todo.shopping_list', enabled: true, token: TOKEN, state: { pairs: [], pick: [] } });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(r.body.ha, true);
      assert.equal(t.R.keys.data.ha.token, TOKEN);
      assert.equal((await t.web.get('/api/v3/homeassistant')).body.enabled, true);
      // Moved from that phone: the row names the server now.
      assert.equal(JSON.parse(rows(t, "SELECT v FROM household_settings WHERE k = 'ha:phone'")[0].v), 'srv-' + t.sid);
      // A second phone's can't replace it.
      const b = await addPhone(t, 'B');
      t.state.devices[b.device].api = 2;
      const r2 = await b.upgrade(t.R.house.kexPub(), { address: 'http://10.0.0.9:8123', entity: 'todo.groceries', enabled: true, token: 'other-token-0123456789', state: null });
      assert.equal(r2.body.ha, undefined);
      assert.equal(t.R.keys.data.ha.token, TOKEN);
    } finally {
      await ha.close();
    }
  });

  test('plain http only to an address at home', async () => {
    const t = await house();
    await t.web.req('PUT', '/api/v3/homeassistant', { sealed: { address: 'http://203.0.113.9:8123', entity: 'todo.shopping_list', enabled: true, token: TOKEN } });
    const r = await t.web.post('/api/v3/homeassistant/sync', {});
    assert.equal(r.body.ok, false);
    assert.match(r.body.message, /https/);
    void stop;
    void start;
  });
});
