const test = require('node:test');
const assert = require('node:assert/strict');
const { setupGo } = require('./go-helper.cjs');
const { createApp } = require('../app');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');

// Compare complete JSON contracts, allowing only wall-clock values to differ.
function normalize(value) {
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, ['time', 'lastCheck', 'checkedAt', 'lastGlobalCheck', 'savedAt'].includes(k) && typeof v === 'string' ? '<timestamp>' : normalize(v)]));
  return value;
}
async function nodeServer(t, dataFile) {
  const backend = createApp({ dataFile, config: { manualCheckLimit: 100 }, probe: async () => ({ alive: true, rtt: 7 }), logger: { log() {}, error() {}, warn() {} } });
  const server = backend.app.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { backend.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return `http://127.0.0.1:${server.address().port}`;
}
test('Node and Go return equivalent JSON, Unicode ordering and mutually readable storage', { skip: !process.env.GO_BACKEND }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'host-monitor-differential-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const go = await setupGo(t, { config: { manualCheckLimit: 100 } });
  const node = await nodeServer(t, path.join(dir, 'monitors.json'));
  async function both(route, method = 'GET', body) {
    const results = [];
    for (const base of [node, go.base]) {
      const response = await fetch(base + route, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
      results.push({ status: response.status, body: normalize(await response.json()) });
    }
    assert.deepEqual(results[1], results[0], `${method} ${route}`);
    return results[0];
  }
  await both('/api/health'); await both('/api/monitors');
  for (const [i, name] of ['主機', '乙', '一', '二', '中', '阿', '張', '陳', 'a', 'A', 'é', 'e', '😀'].entries()) {
    await both('/api/monitors', 'POST', { ip: `192.0.2.${i + 1}`, name, group: ['伺服器', 'NAS', '__proto__', '印表機', '甲', '乙', '邊緣版'][i % 7] });
  }
  await both('/api/monitors');
  await both('/api/monitors', 'POST', { ip: '\ufeff192.0.2.50\ufeff', name: '\ufeffname\ufeff', group: '\ufeffNAS\ufeff', notes: '\u0085keep\u0085' });
  await both('/api/monitors', 'POST', { ip: '192.0.2.1' });
  for (const body of [{}, { ip: '01.2.3.4' }, { ip: 7 }, { ip: '1.2.3.4', notes: null }, []]) await both('/api/monitors', 'POST', body);
  await both('/api/monitors/192-0-2-1', 'PUT', { name: ' ', group: 'NAS', notes: '  note  ' });
  await both('/api/groups/order', 'PUT', { order: ['NAS', 'nas', '不存在', '__proto__', '伺服器'] });
  await both('/api/groups/order'); await both('/api/monitors');
  await both('/api/monitors/192-0-2-1/check', 'POST');
  await both('/api/check-all', 'POST');
  await both('/api/monitors/192-0-2-2', 'DELETE');
  await both('/api/monitors/192-0-2-2', 'DELETE');
  const expected = (await both('/api/monitors')).body;
  // Go writes are accepted by unchanged Node, including confirmed counters/history.
  expected.monitors.find(m => m.ip === '192.0.2.1').name = '192.0.2.1';
  const restoredNode = await nodeServer(t, go.dataFile);
  assert.deepEqual(normalize(await (await fetch(restoredNode + '/api/monitors')).json()), expected);
  const restoredGo = await setupGo(t, { dataFile: path.join(dir, 'monitors.json') });
  assert.deepEqual(normalize((await restoredGo.request('/api/monitors')).body), expected);
});
