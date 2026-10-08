const test = require('node:test');
const assert = require('node:assert/strict');
test('manual quota resets after its 60-second window', () => {
  const { createManualLimiter } = require('../scheduler');
  let time = 1000;
  const acquire = createManualLimiter({ limit: 2, now: () => time });
  assert.equal(acquire(), 0);
  assert.equal(acquire(), 0);
  assert.equal(acquire(), 60);
  time = 60999;
  assert.equal(acquire(), 1);
  time = 61000;
  assert.equal(acquire(), 0);
});

test('a rejected probe releases its worker and allows the next queued job', async () => {
  const { createProbeScheduler } = require('../scheduler');
  const failed = {};
  const next = {};
  const scheduler = createProbeScheduler({ concurrency: 1, run: async monitor => {
    if (monitor === failed) throw new Error('Probe failed');
    return 'completed';
  } });
  const first = scheduler.enqueue(failed);
  const second = scheduler.enqueue(next);
  await assert.rejects(first, /Probe failed/);
  assert.equal(await second, 'completed');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(scheduler.has(failed), false);
  assert.equal(scheduler.has(next), false);
});
