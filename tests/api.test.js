const test = require('node:test');
const assert = require('node:assert/strict');

test('JSON transport rejects backend errors and preserves status for friendly 429 UI', async () => {
  const { createJsonRequest } = require('../public/api');
  for (const status of [400, 429, 500]) {
    const request = createJsonRequest(async () => new Response(JSON.stringify({ error: 'Backend message' }), { status }));
    await assert.rejects(request('/api/test'), error => error.message === 'Backend message' && error.status === status);
  }
  const html = createJsonRequest(async () => new Response('<html>bad gateway</html>', { status: 502 }));
  await assert.rejects(html('/api/test'), /HTTP 502/);
  const network = createJsonRequest(async () => { throw new Error('Network unavailable'); });
  await assert.rejects(network('/api/test'), /Network unavailable/);
  const success = createJsonRequest(async () => new Response('{"success":true}'));
  assert.deepEqual(await success('/api/test'), { success: true });
});
