// 0.17.1: every place that names the server's version says the same one. The image build stops
// when they don't (.github/workflows/image.yml), and in 0.15.2 to 0.17.0 the Home Assistant app's
// two were left at 0.15.1, so no image was published.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const version = JSON.parse(read('package.json')).version;

test('the Home Assistant app, the Dockerfile and package.json name the same version', () => {
  assert.match(read('restock/config.yaml'), new RegExp(`^version: "${version.replaceAll('.', '\\.')}"$`, 'm'));
  assert.match(read('restock/Dockerfile'), new RegExp(`^FROM ghcr\\.io/d-plenty/restock-server:${version.replaceAll('.', '\\.')}$`, 'm'));
  assert.match(read('Dockerfile'), new RegExp(`^ARG RESTOCK_REF=v${version.replaceAll('.', '\\.')}$`, 'm'));
  assert.equal(JSON.parse(read('package-lock.json')).version, version);
});
