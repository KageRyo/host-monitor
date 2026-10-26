const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { createInterface } = require('node:readline');

async function setupGo(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'host-monitor-go-test-'));
  const dataFile = options.dataFile || path.join(dir, 'data', 'monitors.json');
  const probe = options.probe || (async () => ({ alive: true, rtt: 7 }));
  const rpc = http.createServer(async (req, res) => {
    let ip = ''; for await (const chunk of req) ip += chunk;
    let result;
    try { result = await probe(ip); } catch { result = { error: 'probe_execution_failed' }; }
    res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(result ?? {}));
  });
  rpc.listen(0, '127.0.0.1'); await once(rpc, 'listening');
  const mapping = { host: 'HOST', port: 'PORT', checkInterval: 'CHECK_INTERVAL', probeConcurrency: 'PROBE_CONCURRENCY',
    maxMonitors: 'MAX_MONITORS', manualCheckLimit: 'MANUAL_CHECK_LIMIT', authEnabled: 'AUTH_ENABLED',
    authUsername: 'AUTH_USERNAME', authPassword: 'AUTH_PASSWORD', webhookEnabled: 'WEBHOOK_ENABLED',
    webhookUrl: 'WEBHOOK_URL', webhookTimeoutMs: 'WEBHOOK_TIMEOUT_MS', webhookInitialDown: 'WEBHOOK_INITIAL_DOWN',
    webhookInitialDownThreshold: 'WEBHOOK_INITIAL_DOWN_THRESHOLD' };
  const env = {};
  for (const [k, v] of Object.entries(options.config || {})) if (mapping[k]) env[mapping[k]] = String(v);
  const spec = { Env: env, DataFile: dataFile, ProbeURL: `http://127.0.0.1:${rpc.address().port}`, Public: path.resolve(__dirname, '../public') };
  const child = spawn(process.env.GO_BACKEND, ['-test.run=^TestBridge$'], { env: { ...process.env, HM_TEST_BRIDGE: JSON.stringify(spec) }, stdio: ['pipe', 'pipe', 'pipe'] });
  let output = ''; child.stderr.on('data', b => { output += b; });
  const lines = createInterface({ input: child.stdout });
  let base;
  const ready = new Promise((resolve, reject) => {
    child.once('exit', code => reject(new Error(`Go bridge exited ${code}: ${output}`)));
    lines.on('line', line => {
      try { const message = JSON.parse(line); if (message.base) { base = message.base; resolve(); }
        if (message.warning) options.logger?.warn?.(message.warning);
      } catch { output += line; }
    });
  });
  t.after(async () => {
    const exited = child.exitCode !== null ? Promise.resolve() : once(child, 'exit');
    child.stdin.end(); await exited;
    rpc.closeAllConnections(); await new Promise(resolve => rpc.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  await ready;
  async function request(url, method = 'GET', body) {
    const response = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, body: await response.json(), headers: response.headers };
  }
  return { dir, dataFile, base, request, startChecker: () => { void fetch(base + '/_bridge/start'); }, stopChecker: () => { void fetch(base + '/_bridge/stop'); } };
}
module.exports = { setupGo };
