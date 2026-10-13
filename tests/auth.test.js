const test = require('node:test');
const assert = require('node:assert/strict');
const { setup } = require('./helpers');
const { readConfig } = require('../config');

test('enabled authentication rejects missing credentials and invalid usernames at startup', () => {
  for (const env of [
    { AUTH_ENABLED: 'true' },
    { AUTH_ENABLED: 'true', AUTH_USERNAME: 'user' },
    { AUTH_ENABLED: 'true', AUTH_USERNAME: 'user:name', AUTH_PASSWORD: 'secret' },
    { AUTH_ENABLED: 'true', AUTH_USERNAME: 'user\nname', AUTH_PASSWORD: 'secret' }
  ]) assert.throws(() => readConfig(env), /AUTH/);
  assert.equal(readConfig({ AUTH_ENABLED: 'false' }).authEnabled, false);
  assert.throws(() => readConfig({ AUTH_ENABLED: 'typo' }), /AUTH_ENABLED/);
});

test('Basic authentication protects dashboard, assets and every API before parsing or mutation', async t => {
  const config = readConfig({ AUTH_ENABLED: 'true', AUTH_USERNAME: 'operator', AUTH_PASSWORD: 'a:test-secret' });
  const { base } = await setup(t, { config });
  const valid = `Basic ${Buffer.from('operator:a:test-secret').toString('base64')}`;
  const wrong = `Basic ${Buffer.from('operator:wrong').toString('base64')}`;
  for (const [url, method] of [
    ['/', 'GET'], ['/index.html', 'GET'], ['/shared.js', 'GET'],
    ['/api/health', 'GET'], ['/api/monitors', 'GET'], ['/api/groups/order', 'GET'],
    ['/api/monitors', 'POST'], ['/api/monitors/192-0-2-1', 'PUT'],
    ['/api/monitors/192-0-2-1', 'DELETE'], ['/api/check-all', 'POST'],
    ['/api/monitors/192-0-2-1/check', 'POST'], ['/api/groups/order', 'PUT']
  ]) {
    for (const authorization of [undefined, wrong, 'Basic !!!', 'Bearer secret']) {
      const headers = { 'Content-Type': 'application/json' };
      if (authorization) headers.Authorization = authorization;
      const response = await fetch(base + url, { method, headers,
        body: ['POST', 'PUT'].includes(method) ? '{' : undefined });
      assert.equal(response.status, 401, `${method} ${url}`);
      assert.match(response.headers.get('www-authenticate'), /^Basic /);
      const text = await response.text();
      assert.ok(!text.includes('test-secret'));
    }
  }
  const headers = { Authorization: valid, 'Content-Type': 'application/json' };
  assert.equal((await fetch(base + '/api/check-all', { method: 'POST', headers: { ...headers, Origin: 'https://untrusted.example' } })).status, 403);
  assert.equal((await fetch(base + '/api/check-all', { method: 'POST', headers: { ...headers, 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
  assert.equal((await fetch(base + '/', { headers })).status, 200);
  assert.equal((await fetch(base + '/shared.js', { headers })).status, 200);
  assert.equal((await fetch(base + '/api/health', { headers })).status, 200);
  const added = await fetch(base + '/api/monitors', { method: 'POST', headers, body: JSON.stringify({ ip: '192.0.2.1' }) });
  assert.equal(added.status, 201);
  const inventory = await (await fetch(base + '/api/monitors', { headers })).json();
  assert.equal(inventory.monitors.length, 1);
  assert.equal((await fetch(base + '/api/monitors/192-0-2-1/check', { method: 'POST', headers })).status, 200);
  assert.equal((await fetch(base + '/api/monitors/192-0-2-1', { method: 'DELETE', headers })).status, 200);
});

test('direct backend configuration cannot enable authentication with missing secrets', () => {
  const { createApp } = require('../app');
  assert.throws(() => createApp({ config: { authEnabled: true } }), /authentication configuration/);
});

test('explicitly disabling authentication preserves unauthenticated self-hosted access', async t => {
  const { base, request } = await setup(t, { config: readConfig({ AUTH_ENABLED: 'false' }) });
  assert.equal((await fetch(base + '/')).status, 200);
  assert.equal((await request('/api/monitors', 'POST', { ip: '192.0.2.1' })).status, 201);
});
