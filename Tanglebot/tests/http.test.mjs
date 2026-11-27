import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const http = require('../src/utils/http.js');

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

function answer(status, text) {
  return { ok: status >= 200 && status < 300, status, text: async () => text, arrayBuffer: async () => new TextEncoder().encode(text).buffer };
}

test('get sends the params and returns parsed JSON as data', async () => {
  let seen;
  globalThis.fetch = async (url, options) => { seen = { url, options }; return answer(200, '[{"event_id":"e"}]'); };
  const { data } = await http.get('https://x.test/rest', { params: { select: 'event_id', channel_id: 'eq.1' }, headers: { apikey: 'k' } });
  assert.deepEqual(data, [{ event_id: 'e' }]);
  assert.equal(seen.url, 'https://x.test/rest?select=event_id&channel_id=eq.1');
  assert.equal(seen.options.method, 'GET');
  assert.equal(seen.options.headers.apikey, 'k');
});

test('post sends JSON and a failure carries the status and body like axios', async () => {
  let seen;
  globalThis.fetch = async (url, options) => { seen = options; return answer(400, '{"code":"P0001","message":"No"}'); };
  await assert.rejects(http.post('https://x.test/rpc', { a: 1 }), err => {
    assert.equal(err.response.status, 400);
    assert.deepEqual(err.response.data, { code: 'P0001', message: 'No' });
    return true;
  });
  assert.equal(seen.body, '{"a":1}');
});

test('arraybuffer responses and empty bodies', async () => {
  globalThis.fetch = async () => answer(200, 'png');
  const { data } = await http.get('https://x.test/img', { responseType: 'arraybuffer' });
  assert.equal(Buffer.from(data).toString(), 'png');
  globalThis.fetch = async () => answer(204, '');
  assert.equal((await http.post('https://x.test/rpc', {})).data, null);
});
