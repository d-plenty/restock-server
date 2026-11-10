// Copied from the Restock tree's Home Assistant tests (P4 keeps the original).
// A tiny pretend Home Assistant: /api/config, /api/states and the four todo services, with Bearer
// auth that turns a wrong token away. Shapes follow developers.home-assistant.io/docs/api/rest
// (service_response under ?return_response; 400 without it for a service that must respond).
import http from 'node:http';
import { randomBytes } from 'node:crypto';

export function startFakeHa({ token, version = '2025.11.2' } = {}) {
  const lists = { 'todo.shopping_list': [], 'todo.groceries': [] };
  const log = [];
  // startingUp: get_items answers with an empty list (as a to-do integration that hasn't loaded yet does).
  const fail = { addAfterApplying: 0, addDropConnection: false, startingUp: false };
  const send = (res, status, body, type = 'application/json') => {
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    res.writeHead(status, { 'Content-Type': type, 'Content-Length': Buffer.byteLength(text) });
    res.end(text);
  };
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const url = new URL(req.url, 'http://x');
      log.push(`${req.method} ${url.pathname}${url.search}`);
      if (req.headers.authorization !== `Bearer ${token}`) return send(res, 401, '401: Unauthorized', 'text/plain');
      if (req.method === 'GET' && url.pathname === '/api/config') return send(res, 200, { version, location_name: 'Home' });
      if (req.method === 'GET' && url.pathname === '/api/states')
        return send(res, 200, [
          { entity_id: 'light.kitchen', state: 'on', attributes: { friendly_name: 'Kitchen' } },
          { entity_id: 'todo.shopping_list', state: String(lists['todo.shopping_list'].length), attributes: { friendly_name: 'Shopping List' } },
          { entity_id: 'todo.groceries', state: '0', attributes: { friendly_name: 'Groceries' } },
        ]);
      const m = url.pathname.match(/^\/api\/services\/todo\/(get_items|add_item|update_item|remove_item)$/);
      if (req.method !== 'POST' || !m) return send(res, 404, { message: 'Not found' });
      let body;
      try {
        body = JSON.parse(raw || '{}');
      } catch {
        return send(res, 400, { message: 'Invalid JSON' });
      }
      const list = lists[body.entity_id];
      const wantsResponse = url.searchParams.has('return_response');
      if (m[1] === 'get_items') {
        if (!wantsResponse) return send(res, 400, { message: 'Service call requires responses but caller did not ask for responses. Add ?return_response to query parameters.' });
        if (!list) return send(res, 400, { message: `Referenced entities ${body.entity_id} are missing or not currently available` });
        return send(res, 200, { changed_states: [], service_response: { [body.entity_id]: { items: fail.startingUp ? [] : list.map((i) => ({ ...i })) } } });
      }
      if (wantsResponse) return send(res, 400, { message: 'Service does not support responses. Remove return_response from request.' });
      if (!list) return send(res, 400, { message: 'entity not found' });
      const find = (item) => list.find((i) => i.uid === item) ?? list.find((i) => i.summary === item);
      if (m[1] === 'add_item') {
        list.push({ uid: randomBytes(16).toString('hex'), summary: String(body.item), status: 'needs_action' });
        if (fail.addAfterApplying > 0 && --fail.addAfterApplying === 0) {
          // Added, but the answer never gets back: the worst case for doubling up.
          if (fail.addDropConnection) return req.socket.destroy();
          return send(res, 500, { message: 'Internal Server Error' });
        }
        return send(res, 200, []);
      }
      if (m[1] === 'update_item') {
        const i = find(body.item);
        if (!i) return send(res, 400, { message: `Unable to find to-do list item: ${body.item}` });
        if (typeof body.rename === 'string') i.summary = body.rename;
        if (body.status === 'completed' || body.status === 'needs_action') i.status = body.status;
        return send(res, 200, []);
      }
      if (m[1] === 'remove_item') {
        const items = Array.isArray(body.item) ? body.item : [body.item];
        for (const it of items) {
          const i = find(it);
          if (!i) return send(res, 400, { message: `Unable to find to-do list item: ${it}` });
          list.splice(list.indexOf(i), 1);
        }
        return send(res, 200, []);
      }
    });
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () =>
      resolve({
        url: `http://127.0.0.1:${server.address().port}`,
        lists,
        log,
        fail,
        // "Okay Nabu, add milk to my shopping list" (Assist adds to the list as add_item does).
        say: (summary, entity = 'todo.shopping_list') => lists[entity].push({ uid: randomBytes(16).toString('hex'), summary, status: 'needs_action' }),
        close: () => new Promise((r) => server.close(r)),
      }),
    ),
  );
}
