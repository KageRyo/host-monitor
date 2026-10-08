const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const { setup } = require('./helpers');

// The real routes, persistence and counters must remain intact after decoupling boot.
test('real backend CRUD persists and reloads independently of process boot', async t => {
  const { request, dataFile } = await setup(t);
  assert.equal((await request('/api/health')).status, 200);
  assert.equal((await request('/api/monitors', 'POST', { ip: 'invalid' })).status, 400);
  const added = await request('/api/monitors', 'POST', { ip: ' 192.0.2.10 ', name: 'Test' });
  assert.equal(added.status, 201);
  assert.equal(added.body.ip, '192.0.2.10');
  assert.equal((await request('/api/monitors', 'POST', { ip: '192.0.2.10' })).status, 409);
  const url = `/api/monitors/${added.body.id}`;
  assert.equal((await request(url, 'PUT', { name: 'Edited', notes: 'Note' })).body.name, 'Edited');
  assert.equal((await request(url + '/check', 'POST')).body.responseTime, 7);
  const all = await request('/api/check-all', 'POST');
  assert.equal(all.body.monitors[0].totalChecks, 2);
  assert.equal(all.body.monitors[0].upChecks, 2);
  assert.equal(all.body.monitors[0].history.length, 2);
  const { createApp } = require('../app');
  const reloaded = createApp({ dataFile, logger: { log() {}, warn() {}, error() {} } });
  const server = reloaded.app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const restored = await (await fetch(`http://127.0.0.1:${server.address().port}/api/monitors`)).json();
  assert.equal(restored.monitors[0].notes, 'Note');
  assert.equal(restored.monitors[0].totalChecks, 2);
  assert.equal((await request(url, 'DELETE')).status, 200);
  assert.equal((await request(url, 'DELETE')).status, 404);
  assert.equal(JSON.parse(fs.readFileSync(dataFile)).monitors.length, 0);
});

test('failed persistence rolls back CRUD and order and reports check failure', async t => {
  const { request, dataFile } = await setup(t);
  const added = await request('/api/monitors', 'POST', { ip: '192.0.2.1' });
  const url = `/api/monitors/${added.body.id}`;
  fs.unlinkSync(dataFile);
  fs.mkdirSync(dataFile); // Atomic rename fails against a directory; no fs mocks.
  assert.equal((await request('/api/monitors', 'POST', { ip: '192.0.2.2' })).status, 500);
  assert.equal((await request(url, 'PUT', { name: 'Not saved' })).status, 500);
  assert.equal((await request(url, 'DELETE')).status, 500);
  assert.equal((await request('/api/groups/order', 'PUT', { order: ['server'] })).status, 500);
  assert.equal((await request('/api/groups/order')).body.order.length, 0);
  const snapshot = (await request('/api/monitors')).body;
  assert.equal(snapshot.monitors.length, 1);
  assert.equal(snapshot.monitors[0].name, '192.0.2.1');
  assert.equal((await request(url + '/check', 'POST')).status, 500);
  assert.equal((await request('/api/check-all', 'POST')).status, 500);
});


test('reserved category keys remain literal labels with stable sorting', async t => {
  const { request } = await setup(t);
  for (const [i, group] of ['__proto__', 'constructor', 'toString'].entries()) {
    assert.equal((await request('/api/monitors', 'POST', { ip: `192.0.2.${i + 1}`, group })).status, 201);
  }
  const response = await request('/api/monitors');
  assert.equal(response.status, 200);
  assert.deepEqual(new Set(response.body.monitors.map(m => m.groupLabel)), new Set(['__proto__', 'constructor', 'toString']));
});

test('built-in aliases normalize on CRUD and reload and ordering deduplicates', async t => {
  const { request, dataFile } = await setup(t);
  for (const [i, [group, expected]] of [['伺服器', 'server'], ['NAS', 'nas'], ['印表機', 'printer'], ['邊緣版', 'edge'], ['邊緣裝置', 'edge'], ['Custom', 'Custom']].entries()) {
    const added = await request('/api/monitors', 'POST', { ip: `192.0.2.${i + 1}`, group });
    assert.equal(added.body.group, expected);
    assert.equal((await request(`/api/monitors/${added.body.id}`, 'PUT', { group })).body.group, expected);
  }
  const order = (await request('/api/groups/order', 'PUT', { order: ['NAS', 'nas', 'missing'] })).body.order;
  assert.deepEqual(order, ['nas', 'server', 'printer', 'edge', 'Custom']);
  const saved = JSON.parse(fs.readFileSync(dataFile));
  saved.monitors[0].group = '伺服器';
  saved.groupOrder = ['伺服器', 'server', 'NAS', 'nas'];
  fs.writeFileSync(dataFile, JSON.stringify(saved));
  const reloaded = await setup(t, { dataFile });
  assert.equal((await reloaded.request('/api/monitors')).body.monitors.find(m => m.ip === '192.0.2.1').group, 'server');
  assert.deepEqual((await reloaded.request('/api/groups/order')).body.order, ['server', 'nas']);
});

test('mutation routes reject missing, non-object and malformed JSON with safe 400 errors', async t => {
  const { request, base } = await setup(t);
  await request('/api/monitors', 'POST', { ip: '192.0.2.1' });
  for (const [url, method] of [['/api/monitors', 'POST'], ['/api/monitors/192-0-2-1', 'PUT'], ['/api/groups/order', 'PUT']]) {
    for (const raw of [undefined, 'null', '[]', '1', '"text"', 'true', '{']) {
      const response = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json' }, body: raw });
      assert.equal(response.status, 400, `${method} ${url} ${raw}`);
      const body = await response.json();
      assert.equal(typeof body.error, 'string');
      assert.equal(body.stack, undefined);
    }
  }
  for (const body of [{ ip: '192.0.2.3', name: 3 }, { ip: '192.0.2.3', group: {} }, { ip: '192.0.2.3', notes: [] }]) {
    assert.equal((await request('/api/monitors', 'POST', body)).status, 400);
  }
  assert.equal((await request('/api/groups/order', 'PUT', { order: [3] })).status, 400);
});

test('real check history keeps 60 entries while cumulative counters survive reload with zero RTT', async t => {
  const { request, dataFile } = await setup(t, { config: { manualCheckLimit: 100 }, probe: async () => ({ alive: true, rtt: 0 }) });
  await request('/api/monitors', 'POST', { ip: '192.0.2.1' });
  for (let i = 0; i < 65; i++) await request('/api/monitors/192-0-2-1/check', 'POST');
  const reloaded = await setup(t, { dataFile });
  const monitor = (await reloaded.request('/api/monitors')).body.monitors[0];
  assert.equal(monitor.totalChecks, 65);
  assert.equal(monitor.upChecks, 65);
  assert.equal(monitor.history.length, 60);
  assert.equal(monitor.responseTime, 0);
});

test('API responses omit framework disclosure headers', async t => {
  const { request } = await setup(t);
  const response = await request('/api/monitors');
  assert.equal(response.headers.get('x-powered-by'), null);
});
