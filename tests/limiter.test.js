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
