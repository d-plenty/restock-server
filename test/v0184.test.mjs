// 0.18.4: each phone's backup on the server. Phones keep their whole backup here, sealed to the
// household's backup key (whose private half only opens with the passphrase); the web page downloads
// one, and a phone that replaces a lost one restores it and takes the lost one off. And an admin
// phone can change the passphrase.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { house, addPhone, core, PASS, ITER } from './helpers.mjs';
import { derive } from './client.mjs';

const SEALED = 'application/x-restock-sealed';

async function sealed(t, p, method, path, obj) {
  const key = Buffer.from(p.serverKeys[String(p.keyv)], 'base64url');
  const body = obj === undefined ? undefined : Buffer.from(core.sealRsf1(key, obj));
  const auth = p.authHeader(method, path, body);
  const headers = { ...p.headers, Authorization: auth, 'X-Restock-Seal': 'rsf1', ...(body ? { 'Content-Type': SEALED } : {}) };
  const r = await fetch(t.base + path, { method, body, headers });
  const raw = Buffer.from(await r.arrayBuffer());
  if (!String(r.headers.get('content-type')).startsWith(SEALED)) return { status: r.status, body: raw.length ? JSON.parse(raw.toString('utf8')) : {} };
  const out = core.openWithAny(p.serverKeys, raw).msg;
  delete out.reqN;
  return { status: r.status, body: out };
}

/** The passphrase's vault key, as the web page and a phone work it out. */
async function vault(t, pass = PASS) {
  const ch = await (await fetch(`${t.base}/api/v3/login/challenge?user=admin`)).json();
  return derive(pass, ch.salt, ITER).vaultKey;
}

/** Phone backups turned on from the web page: the key made there, its private half sealed with the passphrase. */
async function backupsOn(t) {
  const v = await vault(t);
  const k = core.newBackupKey(new Uint8Array(v));
  const r = await t.web.put('/api/v3/backupkey', { ...k, confirm: await t.web.confirm() });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return k;
}

const backupOf = (p, json) => ({ format: 'restock-phone-backup', v: 1, device: p.device, label: p.name, at: new Date().toISOString(), json });

describe('0.18.4: phone backups', () => {
  test('turned on with the passphrase; phones get the public half only', async () => {
    const t = await house();
    const p = await addPhone(t, "Sarah's iPhone");
    assert.deepEqual((await sealed(t, p, 'GET', '/api/v3/backupkey')).body, {});
    // The passphrase again, and nothing odd.
    assert.equal((await t.web.put('/api/v3/backupkey', { pub: 'x', sealed: 'y', confirm: await t.web.confirm() })).status, 400);
    assert.equal((await t.web.put('/api/v3/backupkey', { ...core.newBackupKey(new Uint8Array(32)) })).status, 403);
    const k = await backupsOn(t);
    const got = (await sealed(t, p, 'GET', '/api/v3/backupkey')).body;
    assert.equal(got.pub, k.pub);
    assert.equal(got.sealed, undefined);
    // Once on, it isn't made again by accident (old backups would no longer open).
    assert.equal((await t.web.put('/api/v3/backupkey', { ...k, confirm: await t.web.confirm() })).status, 409);
    // And the private half only opens with the passphrase.
    assert.ok(core.openBackupKey(new Uint8Array(await vault(t)), k.sealed).length === 32);
    const wrong = new Uint8Array(await vault(t, 'not the passphrase at all'));
    assert.throws(() => core.openBackupKey(wrong, k.sealed), /passphrase/);
  });

  test("a phone keeps its own backup; nobody else's phone reads it, and syncing doesn't list it", async () => {
    const t = await house();
    const a = await addPhone(t, "Declan's iPhone");
    const b = await addPhone(t, "Sarah's iPhone");
    const k = await backupsOn(t);
    const bytes = Buffer.from(core.sealPhoneBackup(k.pub, backupOf(a, '{"format":"restock-backup"}')));
    assert.equal((await a.req('PUT', `/api/v3/files/backups/${a.device}.bin`, { body: bytes })).status, 200);
    // Not someone else's, and only sealed ones.
    assert.equal((await b.req('PUT', `/api/v3/files/backups/${a.device}.bin`, { body: bytes })).status, 403);
    assert.equal((await a.req('PUT', `/api/v3/files/backups/${a.device}.bin`, { body: Buffer.from('not sealed, not sealed, not sealed, not') })).status, 400);
    assert.equal((await b.getFile(`backups/${a.device}.bin`)).status, 404);
    assert.equal((await a.getFile(`backups/${a.device}.bin`)).status, 200);
    const list = await sealed(t, a, 'GET', '/api/v3/files');
    assert.ok(!list.body.files.some((f) => f.name.startsWith('backups/')));
    // The phones list says when, and how big.
    const phones = (await t.web.get('/api/v3/phones')).body.phones;
    assert.equal(phones.find((x) => x.device === a.device).backup.size, bytes.length);
    assert.equal(phones.find((x) => x.device === b.device).backup, null);
  });

  test('the web page downloads one with the passphrase, once, and opens it with the passphrase', async () => {
    const t = await house();
    const a = await addPhone(t, "Declan's iPhone");
    const k = await backupsOn(t);
    await a.req('PUT', `/api/v3/files/backups/${a.device}.bin`, { body: Buffer.from(core.sealPhoneBackup(k.pub, backupOf(a, '{"hello":1}'))) });
    assert.equal((await t.web.post('/api/v3/phone-backup/' + a.device, {})).status, 403);
    const r = await t.web.post('/api/v3/phone-backup/' + a.device, { confirm: await t.web.confirm() });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const file = await t.web.req('GET', `/api/v3/phone-backup/${a.device}?t=${r.body.token}`);
    assert.equal(file.status, 200);
    const priv = core.openBackupKey(new Uint8Array(await vault(t)), r.body.key.sealed);
    assert.equal(core.openPhoneBackup(priv, new Uint8Array(file.body)).json, '{"hello":1}');
    // Once only.
    assert.equal((await t.web.req('GET', `/api/v3/phone-backup/${a.device}?t=${r.body.token}`)).status, 403);
    assert.equal((await t.web.post('/api/v3/phone-backup/nobody', { confirm: await t.web.confirm() })).status, 404);
  });

  test('a new phone that replaces a lost one: same role, its backup, and the lost one taken off', async () => {
    const t = await house();
    const lost = await addPhone(t, "Declan's old iPhone");
    assert.equal((await t.web.req('PATCH', '/api/v3/phones/' + lost.device, { json: { role: 'admin' } })).status, 200);
    const other = await addPhone(t, 'Spare');
    const k = await backupsOn(t);
    await lost.req('PUT', `/api/v3/files/backups/${lost.device}.bin`, { body: Buffer.from(core.sealPhoneBackup(k.pub, backupOf(lost, '{"mine":true}'))) });
    // Nothing to restore for an ordinary phone.
    assert.deepEqual((await sealed(t, other, 'GET', '/api/v3/restore')).body, {});
    const c = await t.web.post('/api/v3/phones', { label: "Declan's new iPhone", replaces: lost.device });
    assert.equal(c.status, 200, JSON.stringify(c.body));
    assert.equal(c.body.role, 'admin');
    const fresh = t.phone3({ name: 'New' });
    assert.equal((await fresh.join(c.body.code)).status, 200);
    const info = (await sealed(t, fresh, 'GET', '/api/v3/restore')).body;
    assert.equal(info.from, lost.device);
    assert.equal(info.label, "Declan's old iPhone");
    assert.ok(info.backup.size > 0);
    assert.ok(info.key.sealed && info.key.salt);
    const got = await fresh.getFile(`backups/${lost.device}.bin`);
    assert.equal(got.status, 200);
    const v = derive(PASS, info.key.salt, ITER).vaultKey;
    assert.equal(core.openPhoneBackup(core.openBackupKey(new Uint8Array(v), info.key.sealed), new Uint8Array(got.body)).json, '{"mine":true}');
    // Restored: the lost one is off the server, and the new one is the admin.
    assert.equal((await sealed(t, fresh, 'POST', '/api/v3/restore', {})).status, 200);
    const phones = (await t.web.get('/api/v3/phones')).body.phones;
    assert.equal(phones.find((x) => x.device === lost.device).status, 'removed');
    assert.equal(phones.find((x) => x.device === fresh.device).role, 'admin');
    assert.equal((await fresh.getFile(`backups/${lost.device}.bin`)).status, 404);
    assert.equal((await sealed(t, fresh, 'POST', '/api/v3/restore', {})).status, 409);
  });

  test('changing the passphrase brings the backup key along (from the web page and from an admin phone)', async () => {
    const t = await house();
    const a = await addPhone(t, "Declan's iPhone");
    a.headers['X-Restock-App'] = '0.18.4';
    assert.equal((await t.web.req('PATCH', '/api/v3/phones/' + a.device, { json: { role: 'admin' } })).status, 200);
    await backupsOn(t);
    const ch = (await sealed(t, a, 'GET', '/api/v3/confirm/challenge')).body;
    const proof = core.loginProof(t.web.loginKey, ch.c, 'phone:' + a.device);
    const NEW = 'paper boat moon river';
    const salt = Buffer.from(core.random(16)).toString('base64url');
    const next = derive(NEW, salt, ITER);
    // Without the key resealed: turned down, nothing changed.
    const no = await sealed(t, a, 'POST', '/api/v3/passphrase', { c: ch.c, proof, salt, auth: next.auth });
    assert.equal(no.status, 400);
    assert.equal(no.body.error, 'backup-key');
    // With it: changed, and the key opens with the new passphrase only.
    const full = (await sealed(t, a, 'GET', '/api/v3/backupkey')).body;
    const priv = core.openBackupKey(new Uint8Array(await vault(t)), full.sealed);
    const ch2 = (await sealed(t, a, 'GET', '/api/v3/confirm/challenge')).body;
    const ok = await sealed(t, a, 'POST', '/api/v3/passphrase', { c: ch2.c, proof: core.loginProof(t.web.loginKey, ch2.c, 'phone:' + a.device), salt, auth: next.auth, backupSealed: core.sealBackupKey(new Uint8Array(next.vaultKey), priv) });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    const after = (await sealed(t, a, 'GET', '/api/v3/backupkey')).body;
    assert.deepEqual(Buffer.from(core.openBackupKey(new Uint8Array(derive(NEW, salt, ITER).vaultKey), after.sealed)), Buffer.from(priv));
    // Every browser was signed out, and the new passphrase signs in.
    assert.equal((await t.web.get('/api/v3/phones')).status, 401);
    const w = t.web3();
    assert.equal((await w.login('admin', NEW, ITER)).status, 200);
  });

  test("a user phone can't change the passphrase", async () => {
    const t = await house();
    const u = await addPhone(t, 'Kid');
    const ch = await sealed(t, u, 'GET', '/api/v3/confirm/challenge');
    assert.equal(ch.status, 403);
    assert.equal((await sealed(t, u, 'POST', '/api/v3/passphrase', { c: 'x', proof: 'y', salt: 'z', auth: 'w' })).status, 403);
  });
});
