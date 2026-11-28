// 0.19.0: "Test both" on the web page's Addresses asks the server, which tries each address itself
// and checks that a Restock server with this household's name answers. (The page's own rules only let it talk to the address it
// was opened with, so a test made in the browser said "didn't answer" for any other one.)
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { house } from './helpers.mjs';

describe('0.19.0: testing the addresses', () => {
  test('this server answers; nothing there, another server and a wrong address do not', async () => {
    const t = await house();
    const port = new URL(t.base).port;
    // Something else that says yes to everything.
    const plain = http.createServer((_, res) => res.end('{"ok":true}'));
    await new Promise((r) => plain.listen(0, '127.0.0.1', r));
    try {
      const ask = async (b) => (await t.web.post('/api/v3/addresses/test', b)).body;
      assert.deepEqual(await ask({ home: `http://127.0.0.1:${port}` }), { home: true });
      assert.deepEqual(await ask({ home: `127.0.0.1:${port}/` }), { home: true }, 'tidied as Save tidies it');
      assert.deepEqual(await ask({ home: 'http://127.0.0.1:9' }), { home: false }, 'nothing there');
      assert.deepEqual(await ask({ home: `http://127.0.0.1:${plain.address().port}` }), { home: false }, 'not a Restock server');
      assert.deepEqual(await ask({ home: `http://127.0.0.1:${port}`, away: 'http://example.com' }), { home: true, away: false }, 'an away address that Save would refuse');
      assert.deepEqual(await ask({}), {});
    } finally {
      plain.close();
    }
  });

  test('only for someone signed in', async () => {
    const t = await house();
    const r = await fetch(`${t.base}/api/v3/addresses/test`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"home":"http://127.0.0.1:1"}' });
    assert.equal(r.status, 401);
  });
});
