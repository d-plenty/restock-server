// Starts the Restock server with the Home Assistant app's options (/data/options.json).
// The server keeps its files in /data/restock, so Home Assistant backups include them.
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';

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

const child = spawn(process.execPath, ['/app/src/server.mjs'], { env, stdio: 'inherit', cwd: '/app' });
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => child.kill(sig));
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
