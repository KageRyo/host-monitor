const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('invalid ports and timer intervals fall back safely with warnings', () => {
  const { readConfig } = require('../config');
  for (const invalid of ['abc', '0', '-1', '1.5', '2x', '65536', '999999999999999999']) {
    const warnings = [];
    const config = readConfig({ PORT: invalid }, { warn: message => warnings.push(message) });
    assert.equal(config.port, 3000);
    assert.equal(warnings.length, 1);
  }
  for (const invalid of ['abc', '0', '-1', '999', '2147483648']) {
    assert.equal(readConfig({ CHECK_INTERVAL: invalid }, { warn() {} }).checkInterval, 30000);
  }
  assert.equal(readConfig({ PORT: ' 65535 ', CHECK_INTERVAL: '1000' }).port, 65535);
  assert.equal(readConfig({ CHECK_INTERVAL: '1000' }).checkInterval, 1000);
  assert.equal(readConfig({ CHECK_INTERVAL: '2147483647' }).checkInterval, 2147483647);
});

test('env file is parsed without executing shell and process values take precedence', t => {
  const { loadEnvFile, readConfig } = require('../config');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'host-monitor-env-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, '.env');
  fs.writeFileSync(file, '# config\n PORT="4000"\nCHECK_INTERVAL=1000\nNAME=$(touch malicious)\n');
  const env = { PORT: '5000' };
  loadEnvFile(file, env);
  assert.equal(readConfig(env).port, 5000);
  assert.equal(readConfig(env).checkInterval, 1000);
  assert.equal(env.NAME, '$(touch malicious)');
});

test('probe limits and webhook timeout reject invalid positive integers', () => {
  const { readConfig } = require('../config');
  for (const invalid of ['0', '-1', 'abc', '1.5', '999999999999999999']) {
    const config = readConfig({ PROBE_CONCURRENCY: invalid, MAX_MONITORS: invalid, MANUAL_CHECK_LIMIT: invalid, WEBHOOK_TIMEOUT_MS: invalid }, { warn() {} });
    assert.equal(config.probeConcurrency, 5);
    assert.equal(config.maxMonitors, 100);
    assert.equal(config.manualCheckLimit, 10);
    assert.equal(config.webhookTimeoutMs, 5000);
  }
  assert.equal(readConfig({ WEBHOOK_ENABLED: 'false' }).webhookEnabled, false);
  assert.equal(readConfig({ WEBHOOK_ENABLED: 'true' }).webhookEnabled, true);
});

test('unreadable env file warns without breaking startup', t => {
  const { loadEnvFile } = require('../config');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'host-monitor-env-error-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const warnings = [];
  assert.doesNotThrow(() => loadEnvFile(dir, {}, { warn: message => warnings.push(message) }));
  assert.equal(warnings.length, 1);
});
