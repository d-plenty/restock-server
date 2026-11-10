#!/usr/bin/env node
// Builds core/restock-core.mjs (the Restock core the server runs for protocol v3: the merge engine,
// crypto, household settings and Home Assistant's sync) from a Restock checkout:
//   RESTOCK_DIR=/path/to/Restock node scripts/core.mjs
// Without RESTOCK_DIR it uses the parent folder when that's a Restock checkout (as in the dev tree,
// where this repo is Restock's server/ folder). The Dockerfile builds it from Restock at RESTOCK_REF.

import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'core');
const isRestock = (d) => {
  try {
    return !!JSON.parse(readFileSync(join(d, 'package.json'), 'utf8')).scripts?.['build:server-core'];
  } catch {
    return false;
  }
};
const dir = process.env.RESTOCK_DIR ? resolve(process.env.RESTOCK_DIR) : isRestock(resolve(ROOT, '..')) ? resolve(ROOT, '..') : null;
if (!dir || !isRestock(dir)) {
  if (existsSync(join(OUT, 'restock-core.mjs')) && !process.env.RESTOCK_DIR) {
    console.log('Restock core: using core/restock-core.mjs as it is (no Restock checkout found to build it from).');
    process.exit(0);
  }
  console.error('The Restock core (core/restock-core.mjs) needs building from a Restock checkout (0.9.4 or newer):');
  console.error('  git clone --branch v0.9.4 https://github.com/d-plenty/Restock ../Restock && (cd ../Restock && npm ci)');
  console.error('  RESTOCK_DIR=../Restock npm test');
  process.exit(1);
}
if (!existsSync(join(dir, 'node_modules'))) {
  console.error(`${dir} has no node_modules: run npm ci there first.`);
  process.exit(1);
}
const r = spawnSync('npm', ['run', '--silent', 'build:server-core'], { cwd: dir, env: { ...process.env, SERVER_CORE_OUT: OUT }, stdio: ['ignore', 'pipe', 'inherit'] });
if (r.status !== 0 || !existsSync(join(OUT, 'restock-core.mjs'))) {
  console.error('Building the Restock core failed.');
  process.exit(r.status || 1);
}
