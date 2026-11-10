// Starts the Restock server with the Home Assistant app's options (/data/options.json).
// The server keeps its files in /data/restock, so Home Assistant backups include them.
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, lchownSync } from 'node:fs';
import { join } from 'node:path';

let o = {};
try {
  o = JSON.parse(readFileSync('/data/options.json', 'utf8'));
} catch (e) {
  console.error('Restock server: could not read the app options, using defaults.', e.message);
}
const text = (v) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
const env = { ...process.env, DATA_DIR: '/data/restock', PORT: '8787' };
const set = (k, v) => {
  if (v !== undefined) env[k] = v;
};
set('RESTOCK_PASSWORD', text(o.password));
set('RESTOCK_USER', text(o.user));
set('RESTOCK_HOME_URL', text(o.home_url));
set('RESTOCK_AWAY_URL', text(o.away_url));
set('RESTOCK_TRUST_PROXY', text(o.trust_proxy));
mkdirSync(env.DATA_DIR, { recursive: true });

// Home Assistant's /data is root's, but the server needn't be: its own folder goes to the image's
// "node" user (1000) and the server runs as that user (it holds the household's keys and talks to
// phones and Home Assistant). If that can't be done, it carries on as root, as 0.9.3 did.
function chownTree(path, uid, gid) {
  lchownSync(path, uid, gid);
  for (const e of readdirSync(path, { withFileTypes: true })) {
    const p = join(path, e.name);
    if (e.isDirectory()) chownTree(p, uid, gid);
    else lchownSync(p, uid, gid);
  }
}
let user = {};
if (process.getuid?.() === 0) {
  try {
    chownTree(env.DATA_DIR, 1000, 1000);
    user = { uid: 1000, gid: 1000 };
    env.HOME = '/tmp';
  } catch (e) {
    console.error('Restock server: could not give its data folder to user 1000, so it runs as root.', e.message);
  }
}

let child;
function run(as) {
  const c = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', '/app/src/server.mjs'], { env, stdio: 'inherit', cwd: '/app', ...as });
  child = c;
  c.on('error', (e) => {
    if (as.uid !== undefined) {
      console.error('Restock server: could not run as user 1000, so it runs as root.', e.message);
      return run({});
    }
    console.error('Restock server could not start: ' + e.message);
    process.exit(1);
  });
  c.on('exit', (code, signal) => {
    if (c === child) process.exit(code ?? (signal ? 1 : 0));
  });
}
run(user);
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => child.kill(sig));
