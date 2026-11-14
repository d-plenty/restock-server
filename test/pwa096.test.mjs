// 0.9.6 (iPhone): the home screen web app's phone layout and offline. The service worker's app shell
// is versioned (a new release is a new shell, so 0.9.6 replaces 0.9.5 cleanly) and holds every file a
// screen needs offline (the Pantry, all four lists, Cards and their barcodes, Specials, the database
// engine); the page and the worker are always checked for a new version; the phone layout's styles
// keep clear of the notch and the home bar. Uses the real build (RESTOCK_WEB_BUILT, or public/app),
// skipped without one.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { start, PASS, ITER } from './helpers.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const built = process.env.RESTOCK_WEB_BUILT ? resolve(process.env.RESTOCK_WEB_BUILT) : resolve(here, '..', 'public', 'app');
const restockDir = resolve(process.env.RESTOCK_DIR ? resolve(here, '..', process.env.RESTOCK_DIR) : resolve(here, '..', '..'));
const has = existsSync(join(built, 'sw.js'));
const shellOf = () => JSON.parse(JSON.parse(readFileSync(join(built, 'sw.js'), 'utf8').match(/("\{\\"build\\".*?\]\}")/)[1]));

describe('0.9.6: the iPhone web app offline and its phone layout', () => {
  test('the app shell is versioned and has every file the screens need offline', { skip: !has && 'no web build here' }, () => {
    const shell = shellOf();
    const pkg = join(restockDir, 'package.json');
    if (existsSync(pkg)) assert.equal(shell.version, JSON.parse(readFileSync(pkg, 'utf8')).version, 'the shell names the release');
    assert.match(shell.build, /^[0-9a-z]{7,}$/);
    const files = new Set(shell.files);
    // Every script, style sheet and wasm of the build (but the text reader, the QR maker and, 0.10.7, the shop map).
    const assets = readdirSync(join(built, 'assets'));
    for (const f of assets) {
      if (!/\.(js|css|wasm)$/.test(f) || /tesseract|traineddata|worker\.min|zxing_writer|ppocrv5|ort-wasm|ocrWorker|maplibre-gl/i.test(f)) continue;
      assert.ok(files.has(`assets/${f}`), `assets/${f} is kept for offline`);
    }
    // The database engine (the household's copy) is among them.
    assert.ok([...files].some((f) => /sql-wasm.*\.wasm$/.test(f)), 'sql.js wasm');
    // The page's own scripts and styles.
    const html = readFileSync(join(built, 'index.html'), 'utf8');
    for (const m of html.matchAll(/(?:src|href)="\/?(assets\/[^"]+)"/g)) assert.ok(files.has(m[1]), `${m[1]} from the page`);
    assert.ok(!shell.files.some((f) => f.startsWith('api/') || f.startsWith('setup/')));
  });

  test('the phone layout keeps clear of the notch and home bar, with the phone tab bar', { skip: !has && 'no web build here' }, () => {
    const html = readFileSync(join(built, 'index.html'), 'utf8');
    assert.match(html, /viewport-fit=cover/);
    assert.match(html, /name="apple-mobile-web-app-status-bar-style" content="black-translucent"/);
    const css = readdirSync(join(built, 'assets'))
      .filter((f) => f.endsWith('.css'))
      .map((f) => readFileSync(join(built, 'assets', f), 'utf8'))
      .join('\n');
    assert.match(css, /env\(safe-area-inset-top/);
    assert.match(css, /env\(safe-area-inset-bottom/);
    assert.match(css, /\.pt-tabs/);
    assert.match(css, /-webkit-overflow-scrolling:\s*touch/);
  });

  test('the server always lets the page and the worker check for a new version (no stale shell)', async () => {
    const t = await start({});
    const b = t.browser();
    await b.setup({ passphrase: PASS, iterations: ITER });
    for (const p of ['/sw.js', '/']) {
      const r = await b.raw('GET', p);
      if (r.status !== 200) continue; // no web app in this copy
      const cc = r.headers.get('cache-control') ?? '';
      assert.ok(/no-cache|no-store/.test(cc), `${p}: ${cc}`);
      assert.doesNotMatch(cc, /immutable/);
    }
  });
});
