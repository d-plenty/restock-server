// 0.9.4 (D15): the encrypted backup download, and scripts/restore.mjs.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { house, addPhone, ent, item, SHARE_PANTRY, start, stop, rows, ITER, PASS } from './helpers.mjs';
import { restoreInto, backupNameOk } from '../src/v3/backup.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BACKUP_PASS = 'saucepan meadow lantern quiet';

describe('the backup', () => {
  test('download (sealed passphrase), restore into an empty folder, and the server starts on it', async () => {
    const t = await house();
    const a = await addPhone(t, 'A');
    await a.putOwn(a.file([ent('items', 'i-milk', Date.now(), a.device, item('i-milk', 'pantry', 'Milk'))], { shares: SHARE_PANTRY }));
    t.settle();
    // Plain JSON (the passphrase in the clear) and weak passphrases are refused.
    assert.equal((await t.web.post('/api/v3/backup', { passphrase: BACKUP_PASS })).status, 400);
    assert.equal((await t.web.req('POST', '/api/v3/backup', { sealed: { passphrase: 'short' } })).status, 400);
    // The sign-in passphrase again (0.9.4 review): without it, or with a wrong one, no backup.
    assert.equal((await t.web.req('POST', '/api/v3/backup', { sealed: { passphrase: BACKUP_PASS } })).status, 403);
    assert.equal((await t.web.req('POST', '/api/v3/backup', { sealed: { passphrase: BACKUP_PASS, confirm: await t.web.confirm(Buffer.alloc(32, 1)) } })).status, 403);
    const r = await t.web.req('POST', '/api/v3/backup', { sealed: { passphrase: BACKUP_PASS, confirm: await t.web.confirm() } });
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-disposition'), /attachment; filename="restock-server-\d{4}-\d{2}-\d{2}\.rsb"/);
    const bytes = r.body;
    assert.equal(bytes.subarray(0, 4).toString(), 'RSB3');
    // Nothing readable in it: not the household name, not the keys.
    assert.ok(!bytes.includes(Buffer.from('Declan and Sarah')));
    assert.ok(!bytes.includes(Buffer.from(t.R.keys.data.kex.priv)));
    const dir = mkdtempSync(join(tmpdir(), 'restock-backup-'));
    const file = join(dir, 'b.rsb');
    writeFileSync(file, bytes);
    // A wrong passphrase writes nothing.
    await assert.rejects(restoreInto(file, 'wrong wrong wrong wrong', join(dir, 'bad')), /passphrase/);
    assert.ok(!existsSync(join(dir, 'bad')) || readdirSync(join(dir, 'bad')).length === 0);
    // The restore script.
    const out = spawnSync(process.execPath, [join(ROOT, 'scripts/restore.mjs'), file, join(dir, 'data')], { env: { ...process.env, RESTOCK_BACKUP_PASSPHRASE: BACKUP_PASS }, encoding: 'utf8' });
    assert.equal(out.status, 0, out.stderr);
    assert.ok(existsSync(join(dir, 'data', 'household.db')));
    assert.ok(existsSync(join(dir, 'data', 'files', `restock-sync-${a.device}.bin`)));
    const st = JSON.parse(readFileSync(join(dir, 'data', 'state.json'), 'utf8'));
    assert.deepEqual(st.sessions3, {});
    // Not into a folder that has things in it.
    const again = spawnSync(process.execPath, [join(ROOT, 'scripts/restore.mjs'), file, join(dir, 'data')], { env: { ...process.env, RESTOCK_BACKUP_PASSPHRASE: BACKUP_PASS }, encoding: 'utf8' });
    assert.notEqual(again.status, 0);
    // A server on the restored folder: the same house, the phone still on it, the data there.
    await stop(t);
    const t2 = await start({}, join(dir, 'data'));
    assert.equal(t2.state.mode, 'v3');
    assert.equal(rows(t2, "SELECT name FROM items WHERE id = 'i-milk'")[0].name, 'Milk');
    a.base = t2.base;
    assert.equal((await a.get('/api/v3/files')).status, 200);
    const w = t2.web3();
    assert.equal((await w.login('admin', PASS, ITER)).status, 200);
    await stop(t2);
    rmSync(dir, { recursive: true, force: true });
  });

  test('restore takes only what belongs in a backup', () => {
    for (const n of ['state.json', 'keys.json', 'household.db', 'files/restock-sync-a1.bin', 'files/archive/a1/2026-01.bin', 'files/keys/a1.bin']) assert.equal(backupNameOk(n), true, n);
    for (const n of ['../x', 'files/../../etc/passwd', '/etc/passwd', 'files/x.sh', 'src/server.mjs', 'files/', 'files//x']) assert.equal(backupNameOk(n), false, n);
  });
});
