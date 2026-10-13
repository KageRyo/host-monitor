const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../app');
const { setup } = require('./helpers');
const logger = { log() {}, warn() {}, error() {} };

test('invalid parseable files stop startup and preserve both original bytes and recoverable backup', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'host-monitor-invalid-storage-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const valid = { ip: '192.0.2.1', id: '192-0-2-1', name: 'Keep this target' };
  const badRecords = [null, {}, { ip: 1 }, { ip: 'invalid' }, { ...valid, id: 'wrong' },
    { ...valid, name: {} }, { ...valid, group: [] }, { ...valid, notes: 1 },
    { ...valid, status: 'bad' }, { ...valid, responseTime: -1 }, { ...valid, lastCheck: 'bad' },
    { ...valid, totalChecks: -1 }, { ...valid, totalChecks: 1.5 },
    { ...valid, totalChecks: 1, upChecks: 2 }, { ...valid, totalChecks: null },
    { ...valid, history: {} }, { ...valid, history: [null] },
    { ...valid, history: [{ time: 'bad', alive: true }] },
    { ...valid, history: [{ time: new Date().toISOString(), alive: 'false' }] },
    { ...valid, history: Array(61).fill({ time: new Date().toISOString(), alive: false, rtt: null }) },
    { ...valid, history: [{ time: new Date().toISOString(), alive: true }], totalChecks: 0 },
    { ...valid, lastReachabilityStatus: 'error' }, { ...valid, checkError: 'raw secret error' },
    { ...valid, initialDownPending: 'true' }, { ...valid, initialDownChecks: -1 },
    { ...valid, initialDownChecks: 1, totalChecks: 0 }
  ];
  const files = [null, [], {}, { monitors: {} }, { monitors: [valid, valid] },
    { monitors: [valid], groupOrder: {} }, { monitors: [valid], groupOrder: [null] },
    { monitors: [valid], lastGlobalCheck: {} },
    ...badRecords.map(record => ({ monitors: [{ ip: '192.0.2.2' }, record] }))];
  for (const [index, value] of files.entries()) {
    const file = path.join(dir, `monitors-${index}.json`);
    const bytes = JSON.stringify(value);
    fs.writeFileSync(file, bytes);
    assert.throws(() => createApp({ dataFile: file, logger }), /startup stopped/, `fixture ${index}`);
    assert.equal(fs.readFileSync(file, 'utf8'), bytes);
    const copies = fs.readdirSync(dir).filter(name => name.startsWith(`monitors-${index}.json.corrupt-`));
    assert.equal(copies.length, 1);
    assert.equal(fs.readFileSync(path.join(dir, copies[0]), 'utf8'), bytes);
  }
});

test('malformed JSON and impossible backups also stop startup without replacing the source', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'host-monitor-storage-recovery-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'monitors.json');
  fs.writeFileSync(file, '{ broken');
  assert.throws(() => createApp({ dataFile: file, logger }), /startup stopped/);
  assert.equal(fs.readFileSync(file, 'utf8'), '{ broken');
  const directorySource = path.join(dir, 'not-a-file');
  fs.mkdirSync(directorySource);
  assert.throws(() => createApp({ dataFile: directorySource, logger }), /startup stopped/);
  assert.ok(fs.statSync(directorySource).isDirectory());
});

test('valid legacy records normalize, preserve history and remain writable and reloadable', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'host-monitor-legacy-storage-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const dataFile = path.join(dir, 'monitors.json');
  const time = '2026-01-01T00:00:00.000Z';
  fs.writeFileSync(dataFile, JSON.stringify({ monitors: [
    { ip: '192.0.2.1', group: 'NAS' },
    { ip: '192.0.2.2', status: 'up', history: [{ time, alive: true, rtt: 0 }] }
  ], groupOrder: ['NAS', 'nas', 'server'], lastGlobalCheck: time }));
  const { request } = await setup(t, { dataFile });
  let snapshot = (await request('/api/monitors')).body;
  assert.equal(snapshot.monitors.length, 2);
  assert.equal(snapshot.monitors[0].id, '192-0-2-1');
  assert.equal(snapshot.monitors[0].group, 'nas');
  assert.equal(snapshot.monitors[1].totalChecks, 1);
  assert.equal(snapshot.monitors[1].upChecks, 1);
  assert.equal(snapshot.monitors[1].history[0].rtt, 0);
  assert.equal((await request('/api/monitors/192-0-2-1', 'PUT', { name: 'Preserved' })).status, 200);
  const restored = await setup(t, { dataFile });
  snapshot = (await restored.request('/api/monitors')).body;
  assert.equal(snapshot.monitors[0].name, 'Preserved');
  assert.equal(snapshot.monitors[1].totalChecks, 1);
  assert.deepEqual((await restored.request('/api/groups/order')).body.order, ['nas', 'server']);
});
