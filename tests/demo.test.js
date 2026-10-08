const test = require('node:test');
const assert = require('node:assert/strict');

// Exercise the same browser-side transport used by the dashboard.
function setup(initialValue) {
  const { createDemoApi } = require('../public/demo.js');
  let value = initialValue ?? null;
  const storage = {
    getItem: () => value,
    setItem: (_key, next) => { value = next; }
  };
  const api = createDemoApi(storage);
  const request = async (path, method = 'GET', body) => {
    const response = await api.request(path, {
      method, body: body === undefined ? undefined : JSON.stringify(body)
    });
    return { status: response.status, body: await response.json() };
  };
  return { api, storage, request };
}

test('demo starts with mixed synthetic statuses and consistent totals', async () => {
  const { request } = setup();
  const { body } = await request('/api/monitors');
  assert.ok(body.monitors.some(m => m.status === 'up'));
  assert.ok(body.monitors.some(m => m.status === 'down'));
  assert.equal(body.stats.total, body.monitors.length);
  assert.equal(body.stats.total, body.stats.up + body.stats.down + body.stats.unknown);
  assert.ok(body.monitors.every(m => m.ip.startsWith('192.0.2.')));
});

test('host management persists between visits and rejects invalid or duplicate IPv4 targets', async () => {
  const { api, request, storage } = setup();
  assert.equal((await request('/api/monitors', 'POST', { ip: '999.1.1.1' })).status, 400);
  assert.equal((await request('/api/monitors', 'POST', { ip: 'host.example' })).status, 400);
  const added = await request('/api/monitors', 'POST', { ip: ' 198.51.100.7 ', name: 'Test', group: 'Custom group', notes: 'Browser only' });
  assert.equal(added.status, 201);
  assert.equal(added.body.ip, '198.51.100.7');
  assert.equal((await request('/api/monitors', 'POST', { ip: '198.51.100.7' })).status, 409);
  const path = `/api/monitors/${added.body.id}`;
  assert.equal((await request(path, 'PUT', { name: 'Renamed', notes: 'Updated' })).body.name, 'Renamed');
  const { createDemoApi } = require('../public/demo.js');
  const restored = await (await createDemoApi(storage).request('/api/monitors')).json();
  assert.equal(restored.monitors.find(m => m.id === added.body.id).notes, 'Updated');
  assert.equal((await request(path, 'DELETE')).status, 200);
  assert.equal((await request(path, 'PUT', { name: 'Missing' })).status, 404);
  api.reset();
  assert.ok(!(await request('/api/monitors')).body.monitors.some(m => m.ip === '198.51.100.7'));
});

test('simulated checks update counters and retain only 60 history records', async () => {
  const { request } = setup();
  const added = await request('/api/monitors', 'POST', { ip: '198.51.100.9' });
  const path = `/api/monitors/${added.body.id}/check`;
  let result;
  for (let i = 0; i < 65; i++) result = await request(path, 'POST');
  assert.equal(result.body.totalChecks, 65);
  assert.equal(result.body.history.length, 60);
  assert.ok(result.body.upChecks <= 65);
  assert.equal(result.body.lastCheck, result.body.history.at(-1).time);
  const all = await request('/api/check-all', 'POST');
  assert.equal(all.body.monitors.find(m => m.id === added.body.id).totalChecks, 66);
  assert.equal(all.body.stats.lastGlobalCheck, all.body.monitors[0].lastCheck);
});

test('category ordering includes omitted groups and survives a reload', async () => {
  const { request, storage } = setup();
  assert.equal((await request('/api/groups/order', 'PUT', { order: 'bad' })).status, 400);
  const result = await request('/api/groups/order', 'PUT', { order: ['nas', 'not-real', 'nas'] });
  assert.equal(result.body.order[0], 'nas');
  assert.equal(result.body.order.filter(g => g === 'nas').length, 1);
  assert.ok(!result.body.order.includes('not-real'));
  const { createDemoApi } = require('../public/demo.js');
  const restored = await (await createDemoApi(storage).request('/api/monitors')).json();
  assert.equal(restored.monitors[0].group, 'nas');
});

test('invalid stored data and unavailable storage still leave a working demo', async () => {
  for (const value of ['bad JSON', '{}', '{"monitors":[{}],"groupOrder":[]}']) {
    assert.ok((await setup(value).request('/api/monitors')).body.monitors.length > 0);
  }
  const { createDemoApi } = require('../public/demo.js');
  const api = createDemoApi({ getItem() { throw Error('blocked'); }, setItem() { throw Error('full'); } });
  assert.equal((await api.request('/api/check-all', { method: 'POST' })).status, 200);
});

test('unknown endpoints and malformed requests return local errors', async () => {
  const { api, request } = setup();
  assert.equal((await request('/api/no-such-route')).status, 404);
  assert.equal((await api.request('/api/monitors', { method: 'POST', body: '{' })).status, 400);
  assert.equal((await request('/api/monitors', 'POST', null)).status, 400);
});

test('category names matching object properties remain plain text labels', async () => {
  const { request } = setup();
  const added = await request('/api/monitors', 'POST', { ip: '198.51.100.21', group: '__proto__' });
  const { body } = await request('/api/monitors');
  assert.equal(body.monitors.find(m => m.id === added.body.id).groupLabel, '__proto__');
});

test('editing a seed category by its visible label keeps the original category', async () => {
  const { request } = setup();
  const original = (await request('/api/monitors')).body.monitors.find(m => m.group === 'nas');
  const updated = await request(`/api/monitors/${original.id}`, 'PUT', { name: 'Edited NAS', group: 'NAS' });
  assert.equal(updated.body.group, 'nas');
  const added = await request('/api/monitors', 'POST', { ip: '198.51.100.22', group: '伺服器' });
  assert.equal(added.body.group, 'server');
});

test('demo average excludes unchecked monitors and represents all unchecked as null', async () => {
  const { storage, request } = setup();
  const state = JSON.parse(storage.getItem());
  state.monitors.forEach(m => { m.totalChecks = 0; m.upChecks = 0; m.history = []; });
  const unchecked = setup(JSON.stringify(state));
  assert.equal((await unchecked.request('/api/monitors')).body.stats.avgUptime, null);
  state.monitors[0].totalChecks = 4;
  state.monitors[0].upChecks = 1;
  assert.equal((await setup(JSON.stringify(state)).request('/api/monitors')).body.stats.avgUptime, 25);
});

test('demo normalizes legacy category labels on reload and group ordering', async () => {
  const { storage } = setup();
  const state = JSON.parse(storage.getItem());
  state.monitors[0].group = '伺服器';
  state.groupOrder = ['伺服器', 'server', 'NAS'];
  const { request } = setup(JSON.stringify(state));
  const snapshot = (await request('/api/monitors')).body;
  assert.equal(snapshot.monitors.find(m => m.ip === '192.0.2.10').group, 'server');
  const order = (await request('/api/groups/order', 'PUT', { order: ['NAS', 'nas', '伺服器'] })).body.order;
  assert.deepEqual(order.slice(0, 2), ['nas', 'server']);
  assert.equal(order.filter(g => g === 'nas').length, 1);
});
