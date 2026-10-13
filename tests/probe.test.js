const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { setup } = require('./helpers');

test('Windows explicit destination-unreachable replies remain down even when ping counts an ICMP error as received', async () => {
  const { createSystemProbe } = require('../probes');
  const stdout = 'Pinging 192.0.2.1 with 32 bytes of data:\r\nReply from 192.0.2.254: Destination host unreachable.\r\n\r\nPing statistics for 192.0.2.1:\r\n    Packets: Sent = 1, Received = 1, Lost = 0 (0% loss),\r\n';
  const probe = createSystemProbe({ platform: 'win32', execute: async () => ({ stdout, stderr: '' }) });
  assert.deepEqual(await probe('192.0.2.1'), { alive: false, rtt: null });
});

test('system probes distinguish valid no-reply summaries from execution and parsing failures', async () => {
  const { createSystemProbe } = require('../probes');
  const down = 'PING 192.0.2.1 (192.0.2.1) 56(84) bytes of data.\n\n--- 192.0.2.1 ping statistics ---\n1 packets transmitted, 0 received, 100% packet loss, time 0ms\n';
  const up = 'PING 192.0.2.1 (192.0.2.1) 56(84) bytes of data.\n64 bytes from 192.0.2.1: icmp_seq=1 ttl=64 time=0.041 ms\n\n--- 192.0.2.1 ping statistics ---\n1 packets transmitted, 1 received, 0% packet loss, time 0ms\nrtt min/avg/max/mdev = 0.041/0.041/0.041/0.000 ms\n';
  assert.deepEqual(await createSystemProbe({ platform: 'linux', execute: async () => ({ stdout: up, stderr: '' }) })('192.0.2.1'), { alive: true, rtt: 0 });
  for (const [platform, code] of [['linux', 1], ['darwin', 2]]) {
    const probe = createSystemProbe({ platform, execute: async () => { throw Object.assign(new Error('no replies'), { code, stdout: down }); } });
    assert.deepEqual(await probe('192.0.2.1'), { alive: false, rtt: null });
  }
  for (const error of [
    { code: 'ENOENT' }, { code: 'EACCES' }, { code: 2 },
    { code: 1, stdout: 'permission denied' },
    { code: 1, stdout: down, killed: true },
    { code: 1, stdout: down, stderr: 'permission denied' }
  ]) {
    const probe = createSystemProbe({ platform: 'linux', execute: async () => { throw Object.assign(new Error('secret details'), error); } });
    assert.deepEqual(await probe('192.0.2.1'), { alive: null, rtt: null, error: 'probe_execution_failed' });
  }
  assert.equal((await createSystemProbe({ platform: 'linux', execute: async () => ({ stdout: 'unparseable', stderr: '' }) })('192.0.2.1')).error, 'probe_execution_failed');
});

test('unreachable checks count as down while thrown probe errors are excluded and survive reload', async t => {
  let failure = false;
  const warnings = [];
  const { request, dataFile } = await setup(t, { probe: async () => {
    if (failure) throw new Error('private probe details and credentials');
    return { alive: false, rtt: null };
  }, logger: { log() {}, error() {}, warn: message => warnings.push(message) } });
  await request('/api/monitors', 'POST', { ip: '192.0.2.1' });
  let monitor = (await request('/api/monitors/192-0-2-1/check', 'POST')).body;
  assert.equal(monitor.status, 'down');
  assert.equal(monitor.totalChecks, 1);
  failure = true;
  monitor = (await request('/api/monitors/192-0-2-1/check', 'POST')).body;
  assert.equal(monitor.status, 'error');
  assert.equal(monitor.checkError, 'probe_execution_failed');
  assert.equal(monitor.totalChecks, 1);
  assert.equal(monitor.upChecks, 0);
  assert.equal(monitor.history.at(-1).alive, null);
  assert.equal(monitor.history.at(-1).error, 'probe_execution_failed');
  const stats = (await request('/api/monitors')).body.stats;
  assert.equal(stats.error, 1);
  assert.equal(stats.down, 0);
  assert.equal(stats.unknown, 0);
  assert.equal(stats.avgUptime, 0);
  assert.ok(warnings.length > 0);
  assert.ok(!warnings.join(' ').includes('private'));
  const reload = await setup(t, { dataFile });
  assert.equal((await reload.request('/api/monitors')).body.monitors[0].checkError, 'probe_execution_failed');
  failure = false;
  monitor = (await request('/api/monitors/192-0-2-1/check', 'POST')).body;
  assert.equal(monitor.status, 'down');
  assert.equal(monitor.checkError, null);
  assert.equal(monitor.totalChecks, 2);
  assert.equal(JSON.parse(fs.readFileSync(dataFile)).monitors[0].checkError, null);
});

test('errors before the first real result keep uptime unknown and failed persistence restores the last result', async t => {
  const { request, dataFile } = await setup(t, { probe: async () => { throw new Error('tool missing'); } });
  await request('/api/monitors', 'POST', { ip: '192.0.2.1' });
  const saved = fs.readFileSync(dataFile);
  fs.unlinkSync(dataFile); fs.mkdirSync(dataFile);
  assert.equal((await request('/api/monitors/192-0-2-1/check', 'POST')).status, 500);
  assert.equal((await request('/api/monitors')).body.monitors[0].status, 'unknown');
  fs.rmdirSync(dataFile); fs.writeFileSync(dataFile, saved);
  const result = await request('/api/check-all', 'POST');
  assert.equal(result.status, 200);
  assert.equal(result.body.monitors[0].status, 'error');
  assert.equal(result.body.monitors[0].totalChecks, 0);
  assert.equal(result.body.stats.avgUptime, null);
});
