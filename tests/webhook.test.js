const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const { setup } = require('./helpers');

async function receiver(t, handle) {
  const server = http.createServer(handle);
  server.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return `http://127.0.0.1:${server.address().port}/secret?token=do-not-log`;
}
async function waitFor(predicate) {
  const deadline = Date.now() + 3000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Webhook test timed out');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

test('webhook sends only persisted up/down transitions with generic JSON payloads', async t => {
  const events = [];
  const url = await receiver(t, (req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => { events.push(JSON.parse(body)); res.end('ok'); });
  });
  const states = [true, false, false, true];
  const { request } = await setup(t, { config: { webhookEnabled: true, webhookUrl: url },
    probe: async () => ({ alive: states.shift(), rtt: 3 }) });
  await request('/api/monitors', 'POST', { ip: '192.0.2.1', name: 'Router' });
  for (let i = 0; i < 4; i++) assert.equal((await request('/api/monitors/192-0-2-1/check', 'POST')).status, 200);
  await waitFor(() => events.length >= 2);
  assert.equal(events.length, 2);
  assert.deepEqual(events.map(e => [e.previousStatus, e.status]), [['up', 'down'], ['down', 'up']]);
  assert.deepEqual(events[0].monitor, { id: '192-0-2-1', ip: '192.0.2.1', name: 'Router', group: 'server' });
  assert.equal(events[0].event, 'monitor.status_changed');
  assert.equal(typeof events[0].checkedAt, 'string');
});

test('disabled notifications and failed persistence do not send webhooks', async t => {
  const events = [];
  const url = await receiver(t, (req, res) => { events.push(req.url); req.resume(); res.end(); });
  const { createNotifier } = require('../notifications');
  const disabled = createNotifier({ enabled: false, url });
  disabled.notify({ status: 'down' });
  disabled.close();
  let alive = true;
  const { request, dataFile } = await setup(t, { config: { webhookEnabled: true, webhookUrl: url },
    probe: async () => ({ alive, rtt: null }) });
  await request('/api/monitors', 'POST', { ip: '192.0.2.1' });
  await request('/api/monitors/192-0-2-1/check', 'POST');
  fs.unlinkSync(dataFile); fs.mkdirSync(dataFile);
  alive = false;
  assert.equal((await request('/api/monitors/192-0-2-1/check', 'POST')).status, 500);
  // Give an erroneously queued notification a chance to reach the real receiver.
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(events.length, 0);
});

test('timeout and HTTP failures release notification workers without leaking URL secrets or retrying', async t => {
  let received = 0;
  const warnings = [];
  const url = await receiver(t, (req, res) => {
    req.resume(); received++;
    if (received === 1) return; // No response: tests the wall-clock timeout.
    res.statusCode = received === 2 ? 500 : 200;
    res.end('secret response body');
  });
  const { createNotifier } = require('../notifications');
  const notifier = createNotifier({ enabled: true, url, timeoutMs: 40, logger: { warn: text => warnings.push(text) } });
  t.after(() => notifier.close());
  for (let i = 0; i < 3; i++) notifier.notify({ event: 'test', status: 'down' });
  await waitFor(() => received === 3 && warnings.length >= 2);
  assert.equal(received, 3);
  assert.ok(warnings.some(w => w.includes('500')));
  assert.equal(warnings.join(' ').includes('secret'), false);
  assert.equal(warnings.join(' ').includes('do-not-log'), false);
  assert.equal(warnings.join(' ').includes(url), false);
});

test('notification queue has two workers and drops overflow at 100 waiting events', async t => {
  let received = 0;
  const warnings = [];
  const url = await receiver(t, req => { received++; req.resume(); });
  const { createNotifier } = require('../notifications');
  const notifier = createNotifier({ enabled: true, url, timeoutMs: 10000, logger: { warn: text => warnings.push(text) } });
  t.after(() => notifier.close());
  for (let i = 0; i < 103; i++) notifier.notify({ event: 'test' });
  await waitFor(() => received >= 2);
  assert.equal(received, 2);
  assert.equal(warnings.filter(w => w.includes('queue')).length, 1);
});

test('first unknown to down is silent and invalid URLs disable notifications safely', async t => {
  let received = 0;
  const url = await receiver(t, (req, res) => { received++; req.resume(); res.end(); });
  const { request } = await setup(t, { config: { webhookEnabled: true, webhookUrl: url },
    probe: async () => ({ alive: false, rtt: null }) });
  await request('/api/monitors', 'POST', { ip: '192.0.2.1' });
  await request('/api/check-all', 'POST');
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(received, 0);
  const warnings = [];
  const { createNotifier } = require('../notifications');
  const invalid = createNotifier({ enabled: true, url: 'secret-invalid-url', logger: { warn: text => warnings.push(text) } });
  invalid.notify({ event: 'test' });
  invalid.close();
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].includes('secret'), false);
});

for (const recoveryAlive of [false, true]) {
  test(`failed-save recovery ${recoveryAlive ? 'up' : 'down'} compares notifications against persisted state`, async t => {
    const events = [];
    const url = await receiver(t, (req, res) => {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => { events.push(JSON.parse(body)); res.end(); });
    });
    let alive = true;
    const { request, dataFile } = await setup(t, { config: { webhookEnabled: true, webhookUrl: url },
      probe: async () => ({ alive, rtt: alive ? 1 : null }) });
    await request('/api/monitors', 'POST', { ip: '192.0.2.1' });
    await request('/api/monitors/192-0-2-1/check', 'POST');
    fs.unlinkSync(dataFile); fs.mkdirSync(dataFile);
    alive = false;
    assert.equal((await request('/api/monitors/192-0-2-1/check', 'POST')).status, 500);
    fs.rmdirSync(dataFile);
    alive = recoveryAlive;
    assert.equal((await request('/api/monitors/192-0-2-1/check', 'POST')).status, 200);
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.deepEqual(events.map(e => [e.previousStatus, e.status]), recoveryAlive ? [] : [['up', 'down']]);
  });
}
