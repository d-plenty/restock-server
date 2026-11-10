// 0.9.4 (protocol v3): the server as the household's owner. keys.json (the server's kex key, the owner
// key, the household keys and serverKeys, the phones' secrets, the recovery key, Home Assistant), the
// household record (signed rows through the engine's writeHousehold), joining (invite, member, upgrade,
// bring), Remove with a rekey, Leave, and the handover from an owner phone, with its crash recovery.
// docs/server-v3-design.md sections 4 and 7; the bytes are docs/server-protocol.md "v3".

import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { generateKeyPairSync, randomBytes, createPublicKey } from 'node:crypto';
import { atomicWriteSync } from '../state.mjs';

const b64u = (b) => Buffer.from(b).toString('base64url');
const DAY = 24 * 3600 * 1000;
const OLD_KEY_LIFE_MS = 60 * DAY; // SyncHousehold.OLD_KEY_LIFE_MS
export const SERVER_MEMBER_NAME = 'Restock server';
/** 0.9.5: Auto delete's months: a whole number 1–120 (null is off). */
export const autoDeleteOk = (m) => Number.isInteger(m) && m >= 1 && m <= 120;
const ALL_TABS = 'pantry,keg,pharmacy';

/** A P-256 ECDH key pair for the server: raw private key and SPKI public key, base64url. */
function newKex() {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  return { priv: privateKey.export({ format: 'jwk' }).d, pub: b64u(publicKey.export({ type: 'spki', format: 'der' })) };
}

/** The parts of keys.json a household brings (a handover's, cleared when it's rolled back). */
const HOUSE_PARTS = ['owner', 'hid', 'keyv', 'keys', 'serverKeys', 'oldkey', 'oldkey_until', 'secrets', 'recovery', 'recoverySaved', 'ha', 'handoverPending'];

/**
 * DATA_DIR/keys.json (0600, written atomically and synchronously): everything secret the server
 * holds for the house. Never logged, never in an answer (nothing here is ever passed to send()).
 */
export function openKeys(dataDir, tmpDir) {
  const file = join(dataDir, 'keys.json');
  let data = {};
  if (existsSync(file)) {
    try {
      data = JSON.parse(readFileSync(file, 'utf8'));
    } catch {
      throw new Error(`${file} is damaged. Restore it from a backup (it holds the household's keys).`);
    }
  }
  if (!data || typeof data !== 'object') data = {};
  data.v = 1;
  let made = false;
  if (!data.kex?.priv || !data.kex?.pub) {
    data.kex = newKex();
    made = true;
  }
  const save = () => atomicWriteSync(file, JSON.stringify(data), tmpDir);
  if (made) save();
  return {
    data,
    file,
    save,
    /** Forgets the household's parts (a handover rolled back, a house started afresh); keeps the kex key. */
    clearHouse() {
      for (const k of HOUSE_PARTS) delete data[k];
      save();
    },
    hasHouse: () => !!data.owner?.priv && !!data.keyv,
  };
}

export function makeHouse(R) {
  const { core, S, keys, now } = R;
  const K = keys.data;
  const sid = () => S.sid;
  const me = () => 'srv-' + S.sid;

  const currentKey = () => K.keys?.[String(K.keyv)];
  const kexPriv = () => Buffer.from(K.kex.priv, 'base64url');
  const kexPub = () => K.kex.pub;

  function home() {
    return R.cfg.homeUrl || S.house?.home || '';
  }
  function away() {
    return R.cfg.awayUrl || S.house?.away || null;
  }
  /**
   * Auto delete (0.9.5; 0.9.4's "Keep data for", same stored key settings.keepMonths): null (off) or a
   * whole number of months 1–120. A value that isn't one (a damaged state.json) stays 0.9.4's 12.
   */
  function keepMonths() {
    const k = S.settings?.keepMonths;
    return k === null ? null : autoDeleteOk(k) ? k : 12;
  }
  /** The Auto delete cut-off now (keepCutoff's arithmetic, for any whole number of months), or null. */
  function cutoff(t = now()) {
    const k = keepMonths();
    return k === null ? null : new Date(t - k * core.MONTH_MS).toISOString();
  }
  // 0.9.5: `resend` (ms) is "Ask phones to resend": 0.9.5 phones resend everything once per new value;
  // 0.9.4 phones' parseServerRow passes over the extra field.
  const serverRowValue = () => {
    const row = { v: 3, sid: sid(), home: home(), away: away(), kex: kexPub(), keepMonths: keepMonths() };
    if (Number.isFinite(S.house?.resendAt)) row.resend = S.house.resendAt;
    return JSON.stringify(row);
  };

  /** The recovery copy (0.9.0's format), sealed with the recovery key. */
  function recoveryRow() {
    const copy = { secrets: { ...(K.secrets ?? {}) }, owner_priv: K.owner.priv, owner_pubkey: K.owner.pub, key: currentKey(), keyv: String(K.keyv) };
    if (K.oldkey && K.oldkey_until && Number(K.oldkey_until) > now()) {
      copy.oldkey = K.oldkey;
      copy.oldkey_until = String(K.oldkey_until);
    }
    return core.sealRecovery(core.unbase32(K.recovery), copy);
  }
  function resealRecovery() {
    if (!K.recovery) K.recovery = core.base32(randomBytes(core.RECOVERY_BYTES));
    R.engine.writeHousehold('recovery', recoveryRow());
  }

  /** member:<device> = { name, pub }, signed by the server. */
  function memberRow(device) {
    const v = R.engine.householdValue('member:' + device);
    if (!v) return null;
    try {
      const m = JSON.parse(v);
      return m && typeof m === 'object' ? m : null;
    } catch {
      return null;
    }
  }
  function signMember(device, name, pub) {
    R.engine.writeHousehold('member:' + device, JSON.stringify(pub ? { name, pub } : { name }));
  }

  /**
   * The household rows a house always has: the server is the owner, the `server` row, and (D10, once
   * no 0.9.3 phone is left: widen) everything shared. `wide: false` keeps the household's own tabs and
   * receipts (a brought household: they come with its owner phone's file).
   */
  function signHouseRows(name, { wide = true } = {}) {
    const e = R.engine;
    e.writeHousehold('owner_pub', K.owner.pub);
    e.writeHousehold('hid', K.hid);
    e.writeHousehold('name', name);
    // owner before server, so a 0.9.3 phone takes `server` in as the owner's (legacyAllowed).
    e.writeHousehold('owner', me());
    if (wide) {
      e.writeHousehold('tabs', ALL_TABS);
      e.writeHousehold('receipts', '1');
    }
    signMember(me(), SERVER_MEMBER_NAME, K.owner.pub);
    e.writeHousehold('server', serverRowValue());
    resealRecovery();
  }

  /** Re-signs the `server` row when home, away, the kex key or Keep data for changed. */
  function refreshServerRow() {
    if (!R.engine) return false;
    const now = R.engine.householdValue('server');
    const want = serverRowValue();
    if (now === want) return false;
    R.engine.writeHousehold('server', want);
    return true;
  }

  function newHouseholdKeys() {
    const owner = core.newJavaKeyPair();
    const key = b64u(randomBytes(32));
    K.owner = { priv: owner.priv, pub: owner.pub };
    K.hid = b64u(randomBytes(9));
    K.keyv = 1;
    K.keys = { 1: key };
    K.serverKeys = { 1: b64u(core.serverKeyOf(Buffer.from(key, 'base64url'))) };
    K.secrets = {};
    K.recovery = core.base32(randomBytes(core.RECOVERY_BYTES));
    K.recoverySaved = false;
    delete K.oldkey;
    delete K.oldkey_until;
  }

  /** Set up this server: a new household with the server as its owner (SyncHousehold.create's rows). */
  async function create(name, origin, by) {
    newHouseholdKeys();
    keys.save();
    S.house = { name, home: R.cfg.homeUrl || origin || '', away: R.cfg.awayUrl || null, created: new Date(now()).toISOString(), seeded: false };
    // 0.9.5 (review): the browsers signed in with no household yet (and the one setting it up) are of this one.
    R.web?.joinHouse(by);
    await R.openDb({ fresh: true });
    signHouseRows(name);
    // 0.9.5: what was noted while there was no household.db (Delete everything on this server) goes in srv_log.
    R.moveActivity();
    S.mode = 'v3';
    await R.st.save();
    R.writeOwn();
    R.note('house-made', { name });
  }

  /** The join answer (RSJ3), sealed to the phone's kex key with its `n`. */
  function joinGift(device, label, seed, secret) {
    return {
      format: 'restock-join',
      v: 3,
      device,
      label,
      seed,
      household: { name: S.house.name, hid: K.hid, sid: sid(), owner_pub: K.owner.pub },
      keyv: K.keyv,
      keys: { ...K.keys },
      serverKeys: { ...K.serverKeys },
      secret,
      server: { home: home(), away: away(), keepMonths: keepMonths() },
    };
  }
  function sealGift(device, phoneKex, n, gift) {
    const key = core.joinKey(kexPriv(), Buffer.from(phoneKex, 'base64url'), n);
    return b64u(core.sealJoin(key, device, gift));
  }

  /** Registers (or re-registers) a phone that joined, and signs its member row. */
  function admit(device, { name, pub, kex, myPub, label }) {
    const was = S.devices[device];
    S.devices[device] = {
      name,
      pub,
      kex,
      myPub: myPub ?? was?.myPub ?? null,
      label,
      added: was && was.status === 'active' ? was.added : now(),
      lastSeen: now(),
      status: 'active',
      statusAt: now(),
      api: 3,
    };
    S.removedDevices = (S.removedDevices ?? []).filter((d) => d !== device);
    if (!K.secrets) K.secrets = {};
    if (!K.secrets[device]) K.secrets[device] = b64u(randomBytes(32));
    keys.save();
    const pubForRow = myPub ?? memberRow(device)?.pub ?? null;
    signMember(device, label, pubForRow);
    // A phone that was removed and is added again: it's a member again.
    if (R.engine.householdValue('removed:' + device) !== null) R.engine.writeHousehold('removed:' + device, null);
    resealRecovery();
    return K.secrets[device];
  }

  /** Writes keys/<device>.bin for every active phone with a kex key (after a rekey). */
  function writeKeysFiles() {
    for (const [device, d] of Object.entries(S.devices)) {
      if (d.status !== 'active' || !d.kex) continue;
      const key = core.keysFileKey(kexPriv(), Buffer.from(d.kex, 'base64url'));
      R.writeServerFile(`keys/${device}.bin`, core.sealKeysFile(key, device, { keyv: K.keyv, keys: { ...K.keys } }));
    }
  }

  /** Remove (D6): the server refuses it, the household gets a new key, its member row goes. Nothing is deleted. */
  function remove(device) {
    const d = S.devices[device];
    const old = currentKey();
    const key = b64u(randomBytes(32));
    K.oldkey = old;
    K.oldkey_until = now() + OLD_KEY_LIFE_MS;
    K.keyv = Number(K.keyv) + 1;
    K.keys = { ...K.keys, [K.keyv]: key };
    K.serverKeys = { ...K.serverKeys, [K.keyv]: b64u(core.serverKeyOf(Buffer.from(key, 'base64url'))) };
    if (K.secrets) delete K.secrets[device];
    keys.save();
    d.status = 'removed';
    d.statusAt = now();
    const e = R.engine;
    e.writeHousehold('member:' + device, null);
    e.writeHousehold('removed:' + device, String(now()));
    e.db.exec('DELETE FROM sync_peers WHERE device = ?', [device]);
    resealRecovery();
    R.deleteServerFile(`keys/${device}.bin`);
    writeKeysFiles();
    R.writeOwn();
  }

  /** Leave: the phone goes (status left), its member row with it; no rekey (D6). */
  function leave(device) {
    const d = S.devices[device];
    d.status = 'left';
    d.statusAt = now();
    if (K.secrets) delete K.secrets[device];
    keys.save();
    R.engine.writeHousehold('member:' + device, null);
    resealRecovery();
    R.deleteServerFile(`keys/${device}.bin`);
    R.writeOwn();
  }

  // ---------- handover (section 7) ----------

  /**
   * Checks a handover (or a bring) payload before anything changes. `ownFile`: the sender's own
   * sync file's bytes (a handover: the key must open it, and its owner_pub and owner rows must be the
   * sender's and signed by the owner key), or null (a bring: the phone's household isn't here yet).
   */
  function checkPayload(p, sender, ownFile) {
    const fail = (why) => {
      const e = new Error(why);
      e.handover = true;
      throw e;
    };
    if (!p || p.format !== 'restock-handover' || p.v !== 3) fail('not a handover');
    const keyv = Number(p.keyv);
    if (!Number.isInteger(keyv) || keyv < 1 || keyv > 100000) fail('keyv');
    let key;
    try {
      key = core.unb64(String(p.key));
    } catch {
      fail('key');
    }
    if (key.length !== 32) fail('key');
    let ownerPub;
    try {
      const priv = core.privOfPkcs8(core.unb64(String(p.owner_priv)));
      ownerPub = b64u(core.publicOf(priv));
    } catch {
      fail('owner_priv');
    }
    const claimed = (() => {
      try {
        return b64u(createPublicKey({ key: Buffer.from(core.unb64(String(p.owner_pubkey))), format: 'der', type: 'spki' }).export({ type: 'spki', format: 'der' }));
      } catch {
        return null;
      }
    })();
    if (!claimed || claimed !== ownerPub) fail('owner key pair');
    const serverKeys = {};
    for (const [v, k] of Object.entries(p.serverKeys && typeof p.serverKeys === 'object' ? p.serverKeys : {})) {
      if (!/^\d{1,6}$/.test(v)) continue;
      try {
        const b = core.unb64(String(k));
        if (b.length === 32) serverKeys[String(Number(v))] = b64u(b);
      } catch {
        /* passed over */
      }
    }
    serverKeys[String(keyv)] = b64u(core.serverKeyOf(key));
    if (ownFile) {
      let msg;
      try {
        msg = core.openRsf1(Buffer.from(serverKeys[String(keyv)], 'base64url'), ownFile);
      } catch {
        fail("the key doesn't open the owner phone's file");
      }
      const hh = (Array.isArray(msg.entries) ? msg.entries : []).filter((x) => x && x.tbl === 'household');
      const row = (pk) => hh.find((x) => x.pk === pk && !x.deleted && x.row);
      const op = row('owner_pub');
      const ow = row('owner');
      if (!op || String(op.row.v) !== ownerPub || !op.sig || !core.verifySig(ownerPub, core.signedText(op), String(op.sig))) fail('owner_pub');
      if (!ow || String(ow.row.v) !== sender || !ow.sig || !core.verifySig(ownerPub, core.signedText(ow), String(ow.sig))) fail('owner');
      if (msg.device !== sender) fail('device');
    }
    const secrets = {};
    for (const [d, s] of Object.entries(p.owner_secrets && typeof p.owner_secrets === 'object' ? p.owner_secrets : {})) {
      if (/^[A-Za-z0-9_-]{1,64}$/.test(d) && typeof s === 'string' && s.length <= 100) secrets[d] = s;
    }
    if (typeof p.secret === 'string' && p.secret.length <= 100) secrets[sender] = p.secret;
    let recovery = null;
    if (typeof p.recovery === 'string') {
      try {
        const r = core.unbase32(p.recovery.replace(/[^A-Za-z0-9]/g, ''));
        if (r.length === core.RECOVERY_BYTES) recovery = core.base32(r);
      } catch {
        recovery = null;
      }
    }
    const hid = typeof p.hid === 'string' && /^[A-Za-z0-9_-]{4,40}$/.test(p.hid) ? p.hid : b64u(randomBytes(9));
    const name = String(p.name ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 60) || 'Our house';
    let ha = null;
    if (p.ha && typeof p.ha === 'object') ha = R.ha.cleanPayload(p.ha);
    const oldkey = typeof p.oldkey === 'string' && p.oldkey.length <= 100 ? p.oldkey : null;
    const oldUntil = Number(p.oldkey_until);
    return {
      keyv,
      key: b64u(key),
      serverKeys,
      ownerPriv: String(p.owner_priv),
      ownerPub,
      secrets,
      recovery,
      recoverySaved: p.recovery_saved === true || p.recovery_saved === '1',
      hid,
      name,
      ha,
      oldkey: oldkey && Number.isFinite(oldUntil) && oldUntil > now() ? { key: oldkey, until: oldUntil } : null,
    };
  }

  function takeKeys(c) {
    K.owner = { priv: c.ownerPriv, pub: c.ownerPub };
    K.hid = c.hid;
    K.keyv = c.keyv;
    // A phone has no older household keys, only their serverKeys (server_filekeys): neither does the server.
    K.keys = { [c.keyv]: c.key };
    K.serverKeys = c.serverKeys;
    K.secrets = c.secrets;
    K.recovery = c.recovery ?? core.base32(randomBytes(core.RECOVERY_BYTES));
    K.recoverySaved = c.recovery ? c.recoverySaved : false;
    if (c.oldkey) {
      K.oldkey = c.oldkey.key;
      K.oldkey_until = c.oldkey.until;
    } else {
      delete K.oldkey;
      delete K.oldkey_until;
    }
    if (c.ha) K.ha = c.ha;
  }

  const crash = (point) => {
    if (process.env.RESTOCK_TEST_CRASH === point) {
      R.log('RESTOCK_TEST_CRASH: stopping ' + point);
      process.exit(70);
    }
  };

  /** The handover's commit (section 7, step 5): (a) keys, (b) household.db, (c) mode, (d) done. */
  async function commitHandover(c, sender) {
    // (a)
    takeKeys(c);
    K.handoverPending = true;
    keys.save();
    crash('after-keys');
    // (b): every sync file and archive, read as a new device, then the server's own changes.
    S.house = { name: c.name, home: R.cfg.homeUrl || S.house?.home || '', away: R.cfg.awayUrl || null, created: new Date(now()).toISOString(), seeded: true };
    R.web?.joinHouse(null);
    await R.openDb({ fresh: true, name: c.name, ownerPub: c.ownerPub });
    R.mergeEverything({ first: 'restock-sync-' + sender + '.bin' });
    const e = R.engine;
    // The household's own tabs and receipts stay as they were while any member is still on 0.9.3
    // (it follows them, so widening now would make it share Keg, Pharmacy or receipts): widen().
    S.house.narrow = { since: new Date(now()).toISOString() };
    e.db.transaction(() => {
      e.writeHousehold('owner', me());
      signMember(me(), SERVER_MEMBER_NAME, K.owner.pub);
      e.writeHousehold('server', serverRowValue());
      if (e.householdValue('hid') === null) e.writeHousehold('hid', K.hid);
      for (const r of e.db.query("SELECT k FROM household WHERE k LIKE 'handover:%'")) e.writeHousehold(String(r.k), null);
      resealRecovery();
    });
    if (K.ha) R.ha.tookOver(c.ha?.state);
    crash('after-db');
    // (c): every v2 phone stays, with api 2 (they upgrade with POST /api/v3/upgrade).
    for (const [id, d] of Object.entries(S.devices)) {
      // A phone the household removed while it was a phone household: on the server, never in the house.
      if (e.householdValue('removed:' + id) !== null && (d.status ?? 'active') === 'active') {
        d.status = 'removed';
        d.statusAt = now();
      }
      if (!d.status) {
        d.status = 'active';
        d.statusAt = now();
      }
      if (!d.api) d.api = 2;
      if (!d.label) d.label = memberRowName(d) ?? d.name;
    }
    S.mode = 'v3';
    await R.st.save();
    crash('after-mode');
    // (d)
    finishHandover();
  }
  function memberRowName(d) {
    for (const [id, x] of Object.entries(S.devices)) if (x === d) return memberRow(id)?.name ?? null;
    return null;
  }
  function finishHandover() {
    delete K.handoverPending;
    keys.save();
    R.writeOwn();
    R.moveActivity();
    R.note('handover-done', { name: S.house?.name });
  }

  /** On start: a handover that stopped part-way is rolled back (before the mode changed) or finished. */
  async function recoverHandover() {
    if (!K.handoverPending) return null;
    if (S.mode !== 'v3') {
      keys.clearHouse();
      R.closeDb();
      for (const f of ['household.db', 'household.db-wal', 'household.db-shm']) rmSync(join(R.DATA, f), { force: true });
      R.note('handover-rolled-back', {});
      return 'rolled-back';
    }
    await R.openDb({});
    finishHandover();
    return 'finished';
  }

  /** A bring (section 7): a phone household replaces the server's empty house. */
  async function bring(c, device) {
    const name = S.house?.name || c.name;
    takeKeys(c);
    keys.save();
    // Its tabs and receipts come with its owner phone's file; widened only once that's in and every
    // member is on 0.9.4 (widen).
    S.house = { ...(S.house ?? {}), name, seeded: true, narrow: { since: new Date(now()).toISOString(), waitFor: device } };
    // 0.9.5 (review): another household now (its own id); the browsers signed in to the empty one carry
    // on with it (each drops its copy of the empty one: its owner key changed, live.ts).
    delete S.house.id;
    R.web?.joinHouse(null, true);
    await R.openDb({ fresh: true, name, ownerPub: c.ownerPub });
    signHouseRows(name, { wide: false });
    R.mergeEverything({});
    await R.st.save();
    R.note('household-brought', { by: device });
  }

  /**
   * D10 after a handover or a bring: all three tabs and receipts on, signed, once every member that
   * isn't removed is on v3 (upgraded or joined): a 0.9.3 phone follows the household's tabs, so it
   * must never start sharing Keg, Pharmacy or receipts because the household moved. 0.9.4 phones
   * decide by their own shares. True when it widened now.
   */
  function widen() {
    const e = R.engine;
    const narrow = S.house?.narrow;
    if (!e || S.mode !== 'v3' || !narrow || e.meta('applying') !== null) return false;
    if (narrow.waitFor && e.seenSum(`restock-sync-${narrow.waitFor}.bin`) === null) return false;
    const v3 = (d) => !!d && (d.status ?? 'active') === 'active' && d.api === 3;
    for (const d of Object.values(S.devices)) if ((d.status ?? 'active') === 'active' && d.api !== 3) return false;
    for (const r of e.db.query("SELECT k FROM household WHERE k LIKE 'member:%'")) {
      const id = String(r.k).slice('member:'.length);
      if (id !== me() && !v3(S.devices[id])) return false;
    }
    const was = { tabs: e.householdValue('tabs'), receipts: e.householdValue('receipts') };
    delete S.house.narrow;
    R.st.saveSoon();
    if (was.tabs === ALL_TABS && was.receipts === '1') return false;
    e.db.transaction(() => {
      e.writeHousehold('tabs', ALL_TABS);
      e.writeHousehold('receipts', '1');
    });
    // The server now takes in every tab: read every file again for what it passed over before.
    e.db.exec("DELETE FROM sync_meta WHERE key LIKE 'folder_seen:%'");
    R.merger.logLine('log', 'household-widened', null, { was, since: narrow.since });
    R.note('household-widened', { was });
    R.mergeEverything({});
    return true;
  }

  return {
    widen,
    me,
    kexPub,
    kexPriv,
    home,
    away,
    keepMonths,
    cutoff,
    currentKey,
    memberRow,
    signMember,
    create,
    joinGift,
    sealGift,
    admit,
    remove,
    leave,
    checkPayload,
    commitHandover,
    recoverHandover,
    bring,
    refreshServerRow,
    resealRecovery,
    writeKeysFiles,
  };
}
