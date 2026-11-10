#!/usr/bin/env node
// Starts a throwaway Restock server on a temp folder and prints where it is, for testing the
// phone and the web app against a real server. Stop it with Ctrl+C (the folder is removed).
//
//   node server/test/e2e-server.mjs                  fresh server, in setup mode (admin / admin)
//   node server/test/e2e-server.mjs --ready          also sets a passphrase, and prints a signed-in
//                                                    session cookie and a phone invite
//   node server/test/e2e-server.mjs --house "Our house"
//                                                    0.9.4 (v3): also sets up a house on it, and prints
//                                                    a v3 session (id and key) and an Add a phone code
//   options: --port 8787   --host 0.0.0.0   --dir <folder to keep>   --passphrase "..."
//            --user admin  --password admin  --trust-proxy
//
// The last line printed is one line of JSON starting with "E2E " for scripts to read:
//   E2E {"url":"http://127.0.0.1:41234","port":41234,"dir":"...","user":"admin",...}
// With --ready, type "invite" and Enter for another invite (printed the same way).

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { makeServer, config, VERSION } from '../src/server.mjs';
import { Browser, V3Browser } from './client.mjs';

const args = process.argv.slice(2);
const flag = (n) => args.includes('--' + n);
const opt = (n, d) => {
  const i = args.indexOf('--' + n);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : d;
};

const keep = opt('dir');
const dir = keep || mkdtempSync(join(tmpdir(), 'restock-e2e-'));
const user = opt('user', 'admin');
const password = opt('password', 'admin');
const passphrase = opt('passphrase', 'kettle orbit lemon fence');
const host = opt('host', '127.0.0.1');
const houseName = opt('house');
const cfg = { ...config({}), dataDir: dir, user, password, quiet: !flag('verbose'), trustProxy: flag('trust-proxy') };
const s = await makeServer(cfg);
await new Promise((r) => s.server.listen(Number(opt('port', 0)), host, r));
const port = s.server.address().port;
const url = `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${port}`;
const out = { url, port, dir, version: VERSION, user, password };

console.log(`Restock server ${VERSION} (test) on ${url}, data in ${dir}`);
let web = null;
if ((flag('ready') || houseName) && !s.state.account) {
  web = new Browser(url);
  const { salt, auth } = await web.setup({ user, password, passphrase });
  out.passphrase = passphrase;
  out.salt = salt;
  out.auth = auth;
  out.cookie = 'restock_session=' + web.cookie('restock_session');
  console.log(`  Passphrase set: "${passphrase}". Session cookie: ${out.cookie}`);
} else if (!s.state.account) {
  console.log(`  Setup mode: open ${url} and log in with ${user} / ${password}.`);
}
let web3 = null;
if (houseName && web) {
  web3 = new V3Browser(url);
  const l = await web3.login(user, passphrase);
  if (l.status !== 200) throw new Error('v3 sign-in failed: ' + JSON.stringify(l.body));
  const h = await web3.post('/api/v3/setup', { name: houseName });
  if (h.status !== 200) throw new Error('Set up this server failed: ' + JSON.stringify(h.body));
  out.house = houseName;
  out.sid = s.state.sid;
  out.session = web3.session;
  out.sessionKey = Buffer.from(web3.key).toString('base64url');
  console.log(`  House "${houseName}" set up (srv-${s.state.sid}). v3 session: ${out.session}`);
}
async function invite() {
  if (web3) {
    const r = await web3.post('/api/v3/phones', { label: 'Test phone' });
    console.log(`  Add a phone (10 minutes, one phone): ${r.body.code}`);
    return { invite: new URLSearchParams(r.body.code.split('?')[1]).get('i'), code: r.body.code };
  }
  const r = await web.post('/api/v2/invites');
  console.log(`  Invite (10 minutes, one phone): ${r.body.code}`);
  return r.body;
}
if (web) {
  const i = await invite();
  out.invite = i.invite;
  out.code = i.code;
  createInterface({ input: process.stdin }).on('line', async (l) => {
    if (l.trim() === 'invite') {
      const n = await invite();
      console.log('E2E ' + JSON.stringify({ invite: n.invite, code: n.code }));
    }
  });
}
console.log('E2E ' + JSON.stringify(out));

const stop = async () => {
  s.server.close();
  await s.flush();
  if (!keep) rmSync(dir, { recursive: true, force: true });
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
