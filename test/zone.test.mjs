// 0.9.5 (final review): one time zone (TZ) for the Data tab's months and days and for the night's
// Auto delete, worked out with Intl (src/zone.mjs), not SQLite's 'localtime' or the process's own
// local time (a container without TZ is on UTC; Alpine may have no tzdata).

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { serverZone, dayIn, monthIn, hourIn, wallTime } from '../src/zone.mjs';
import { config } from '../src/server.mjs';
import { house, addPhone, ent, line, rows, SHARE_ALL } from './helpers.mjs';

const BNE = 'Australia/Brisbane';
// 9:30 am on 1 November in Brisbane (UTC+10, no daylight saving) is still 31 October in UTC.
const NINE_THIRTY_ON_THE_1ST = Date.parse('2026-10-31T23:30:00.000Z');

describe('the zone', () => {
  test('TZ when Node knows it, else the local zone, else UTC', () => {
    assert.equal(serverZone({ TZ: BNE }), BNE);
    assert.equal(serverZone({ TZ: ':Australia/Perth' }), 'Australia/Perth');
    const local = serverZone({});
    assert.equal(serverZone({ TZ: 'Not/AZone' }), local);
    assert.equal(serverZone({ TZ: '' }), local);
    assert.equal(config({ TZ: BNE }).timeZone, BNE);
  });

  test('days, months and hours in the zone', () => {
    assert.equal(dayIn(NINE_THIRTY_ON_THE_1ST, BNE), '2026-11-01');
    assert.equal(monthIn(NINE_THIRTY_ON_THE_1ST, BNE), '2026-11');
    assert.equal(monthIn(NINE_THIRTY_ON_THE_1ST, 'UTC'), '2026-10');
    assert.equal(hourIn(NINE_THIRTY_ON_THE_1ST, BNE), 9);
    assert.equal(new Date(wallTime(BNE, 2026, 11, 1)).toISOString(), '2026-10-31T14:00:00.000Z');
    // Daylight saving: Sydney is UTC+11 in November, UTC+10 in June.
    assert.equal(new Date(wallTime('Australia/Sydney', 2026, 11, 1)).toISOString(), '2026-10-31T13:00:00.000Z');
    assert.equal(new Date(wallTime('Australia/Sydney', 2026, 6, 1)).toISOString(), '2026-05-31T14:00:00.000Z');
    // Months run over into the next or last year.
    assert.equal(new Date(wallTime(BNE, 2026, 13, 1)).toISOString(), '2026-12-31T14:00:00.000Z');
    assert.equal(new Date(wallTime(BNE, 2026, 0, 1)).toISOString(), '2025-11-30T14:00:00.000Z');
  });

  test('no SQLite localtime, and no process-local dates, in the Data code', () => {
    const src = readFileSync(new URL('../src/v3/data.mjs', import.meta.url), 'utf8');
    assert.doesNotMatch(src, /'localtime'/);
    assert.doesNotMatch(src, /\.get(FullYear|Month|Date|Day|Hours)\(\)/);
    assert.doesNotMatch(readFileSync(new URL('../src/v3/merge.mjs', import.meta.url), 'utf8'), /\.getHours\(\)/);
  });
});

describe('with TZ=Australia/Brisbane', () => {
  /** A house set up now, then its clock moved to `ms` (the phone follows the server's time). */
  async function brisbaneAt(ms) {
    const clock = { shift: 0 };
    const t = await house({ clock, timeZone: BNE });
    const a = await addPhone(t, 'A');
    clock.shift = ms - Date.now();
    const send = async (entries) => {
      const r = await a.putOwn(a.file(entries.map((e) => ({ ...e, device: a.device })), { shares: SHARE_ALL }));
      assert.equal(r.status, 200, JSON.stringify(r.body));
      t.settle();
    };
    return { t, send, clock };
  }

  test('a tick at 9:30 am on the 1st counts in that month', async () => {
    const { t, send } = await brisbaneAt(NINE_THIRTY_ON_THE_1ST);
    await send([ent('list_entries', 'l1', 1, 'x', line('l1', 'Bread', { checked: 1, checked_at: t.now(), price: 4, chain: 'aldi' }))]);
    assert.equal(rows(t, 'SELECT COUNT(*) AS n FROM srv_spend')[0].n, 1);
    const s = t.R.data.stats('1');
    assert.deepEqual(
      s.spending.months.map((m) => [m.month, m.count, m.total]),
      [['2026-11', 1, 4]],
    );
    // Three months back: September, October, November (from 1 September in Brisbane).
    const s3 = t.R.data.stats('3');
    assert.deepEqual(
      s3.spending.months.map((m) => m.month),
      ['2026-09', '2026-10', '2026-11'],
    );
    assert.equal(s3.from, '2026-08-31T14:00:00.000Z');
  });

  test('Auto delete runs at 3 am in the zone', async () => {
    // 5 am in Brisbane: the first run (as soon after a start).
    const five = Date.parse('2026-11-04T19:00:00.000Z');
    const { t, clock } = await brisbaneAt(five);
    t.state.settings.keepMonths = 1;
    await t.R.merger.daily(true);
    const raw = t.R.merger.raw();
    const old = (n) => raw.prepare("INSERT INTO srv_spend (entry_id, checked_at, at, text, qty, src) VALUES (?, ?, ?, 'Tea', 1, 'none')").run(n, five - 90 * 86_400_000, new Date(five - 90 * 86_400_000).toISOString());
    old('gone');
    const left = () => rows(t, "SELECT COUNT(*) AS n FROM srv_spend WHERE entry_id = 'gone'")[0].n;
    // 2 am the next night (21 hours on): not yet.
    clock.shift += 21 * 3_600_000;
    assert.equal(hourIn(t.now(), BNE), 2);
    await t.R.merger.daily();
    assert.equal(left(), 1);
    // 3 am in Brisbane (17:00 UTC): now.
    clock.shift += 3_600_000;
    assert.equal(hourIn(t.now(), BNE), 3);
    await t.R.merger.daily();
    assert.equal(left(), 0);
  });
});
