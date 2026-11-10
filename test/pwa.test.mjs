// 0.9.5: the home screen web app (Restock's vite.server.config.ts builds sw.js, pwa/manifest.webmanifest
// and pwa/*.png into public/app). The server serves them with the right types and cache rules, the
// page may use the camera (this server only), and the page's CSP stays strict: workers and the
// manifest from this server only. Uses a made-up web app folder (cfg.appDir), and the real build
// when there is one.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { APP_CSP, PAGE_CSP } from '../src/server.mjs';
import { start, PASS, ITER } from './helpers.mjs';

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4d40000000049454e44ae426082', 'hex');

function fakeApp() {
  const dir = mkdtempSync(join(tmpdir(), 'restock-pwa-app-'));
  mkdirSync(join(dir, 'assets'));
  mkdirSync(join(dir, 'pwa'));
  writeFileSync(join(dir, 'index.html'), '<!doctype html><title>Restock</title><link rel="manifest" href="pwa/manifest.webmanifest">');
  writeFileSync(join(dir, 'sw.js'), 'self.addEventListener("fetch", () => {});');
  writeFileSync(join(dir, 'assets', 'index-abc123.js'), 'console.log(1)');
  writeFileSync(join(dir, 'pwa', 'manifest.webmanifest'), JSON.stringify({ name: 'Restock', start_url: '/', display: 'standalone', icons: [] }));
  for (const n of ['apple-touch-icon', 'icon-192', 'icon-512', 'icon-maskable-512']) writeFileSync(join(dir, 'pwa', `${n}.png`), PNG);
  return dir;
}

async function readyServer(appDir) {
  const t = await start({ appDir });
  const b = t.browser();
  await b.setup({ passphrase: PASS, iterations: ITER });
  return { t, b };
}

const directives = (csp) => new Map(csp.split(';').map((d) => d.trim().split(/\s+/)).map(([k, ...v]) => [k, v]));

describe('the home screen web app', () => {
  test('serves sw.js, the manifest and the icons with the right types and cache rules', async () => {
    const { b } = await readyServer(fakeApp());
    let r = await b.raw('GET', '/sw.js');
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('content-type'), 'text/javascript; charset=utf-8');
    // Checked on every visit, so a new version is seen; never "immutable".
    assert.equal(r.headers.get('cache-control'), 'no-cache');
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff');

    r = await b.raw('GET', '/pwa/manifest.webmanifest');
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('content-type'), 'application/manifest+json');
    assert.equal(r.headers.get('cache-control'), 'no-cache');
    assert.equal(JSON.parse(await r.text()).name, 'Restock');

    for (const n of ['apple-touch-icon', 'icon-192', 'icon-512', 'icon-maskable-512']) {
      r = await b.raw('GET', `/pwa/${n}.png`);
      assert.equal(r.status, 200, n);
      assert.equal(r.headers.get('content-type'), 'image/png');
      assert.equal(r.headers.get('cache-control'), 'public, max-age=86400');
    }
    // Built files keep their year-long cache; the page is checked every time.
    assert.match((await b.raw('GET', '/assets/index-abc123.js')).headers.get('cache-control'), /immutable/);
    assert.equal((await b.raw('GET', '/')).headers.get('cache-control'), 'no-cache');
    // Made-up names are 404s, not the page.
    assert.equal((await b.raw('GET', '/pwa/nope.png')).status, 404);
    assert.equal((await b.raw('GET', '/pwa/manifest.json')).status, 404);
  });

  test("the page's CSP: workers and the manifest from this server only, nothing looser", async () => {
    const { b } = await readyServer(fakeApp());
    for (const path of ['/', '/sw.js', '/pwa/manifest.webmanifest']) {
      const csp = (await b.raw('GET', path)).headers.get('content-security-policy');
      assert.equal(csp, APP_CSP, path);
    }
    for (const csp of [APP_CSP, PAGE_CSP]) {
      const d = directives(csp);
      assert.deepEqual(d.get('manifest-src'), ["'self'"]);
      // blob: is for the receipt reader's own worker (tesseract.js), as in 0.9.4; no other place.
      assert.deepEqual(d.get('worker-src'), ["'self'", 'blob:']);
      assert.deepEqual(d.get('default-src'), ["'self'"]);
      assert.deepEqual(d.get('connect-src'), ["'self'"]);
      assert.deepEqual(d.get('script-src'), ["'self'", "'wasm-unsafe-eval'"]);
      assert.deepEqual(d.get('frame-ancestors'), ["'none'"]);
      assert.deepEqual(d.get('object-src'), ["'none'"]);
      for (const [k, v] of d) {
        assert.ok(!v.includes('*') && !v.includes('https:') && !v.includes('http:'), `${k} names no wildcard source`);
        assert.ok(!v.includes("'unsafe-eval'"), `${k} has no unsafe-eval`);
      }
    }
  });

  test('the camera: the web app may use it (this server only); the API and setup page may not', async () => {
    const { b } = await readyServer(fakeApp());
    const pp = (r) => r.headers.get('permissions-policy');
    assert.match(pp(await b.raw('GET', '/')), /(^|, )camera=\(self\)/);
    assert.match(pp(await b.raw('GET', '/')), /microphone=\(\)/);
    assert.match(pp(await b.raw('GET', '/sw.js')), /camera=\(self\)/);
    assert.match(pp(await b.raw('GET', '/setup/setup.css')), /camera=\(\)/);
    assert.match(pp(await b.raw('GET', '/api/v3/health')), /camera=\(\)/);
  });

  test('before setup, the files redirect like every page (nothing of the app shows)', async () => {
    const t = await start({ appDir: fakeApp() });
    const b = t.browser();
    for (const path of ['/sw.js', '/pwa/manifest.webmanifest', '/pwa/icon-192.png']) {
      const r = await b.raw('GET', path);
      assert.equal(r.status, 302, path);
      assert.equal(r.headers.get('location'), '/setup/');
    }
  });

  // The real build, when this copy of the server has one (npm run build:server-web in Restock), or
  // the folder RESTOCK_WEB_BUILT names (SERVER_WEB_OUT=<folder> npm run build:server-web).
  const built = process.env.RESTOCK_WEB_BUILT ? resolve(process.env.RESTOCK_WEB_BUILT) : resolve(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'app');
  test('the real build: installable manifest, icons and a service worker with its app shell', { skip: !existsSync(join(built, 'sw.js')) && 'public/app has no 0.9.5 build' }, () => {
    const m = JSON.parse(readFileSync(join(built, 'pwa', 'manifest.webmanifest'), 'utf8'));
    assert.equal(m.name, 'Restock');
    assert.equal(m.short_name, 'Restock');
    assert.equal(m.display, 'standalone');
    assert.equal(m.start_url, '/');
    assert.equal(m.scope, '/');
    assert.match(m.theme_color, /^#[0-9a-f]{6}$/i);
    assert.match(m.background_color, /^#[0-9a-f]{6}$/i);
    const sizes = (purpose) => m.icons.filter((i) => i.purpose === purpose).map((i) => i.sizes);
    assert.ok(sizes('any').includes('192x192') && sizes('any').includes('512x512'));
    assert.ok(sizes('maskable').includes('512x512'));
    for (const i of m.icons) assert.ok(readFileSync(join(built, 'pwa', i.src)).subarray(1, 4).toString() === 'PNG', i.src);
    const html = readFileSync(join(built, 'index.html'), 'utf8');
    assert.match(html, /<link rel="manifest" href="pwa\/manifest\.webmanifest">/);
    assert.match(html, /<link rel="apple-touch-icon" href="pwa\/apple-touch-icon\.png">/);
    assert.match(html, /name="apple-mobile-web-app-capable" content="yes"/);
    assert.match(html, /viewport-fit=cover/);
    const sw = readFileSync(join(built, 'sw.js'), 'utf8');
    assert.doesNotMatch(sw, /__RESTOCK_SHELL_MANIFEST__/);
    assert.doesNotMatch(sw, /^\s*import\s/m);
    const shell = JSON.parse(JSON.parse(sw.match(/("\{\\"build\\".*?\]\}")/)[1]));
    assert.ok(shell.files.includes('index.html'));
    for (const f of shell.files) {
      assert.ok(existsSync(join(built, f)), `${f} is in the build`);
      assert.ok(!f.startsWith('api/'), 'nothing from the API');
    }
  });
});
