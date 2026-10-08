const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
async function setup(t, options = {}) {
  const { createApp } = require('../app');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'host-monitor-test-'));
  const dataFile = path.join(dir, 'data', 'monitors.json');
  const backend = createApp({ dataFile, logger: { log() {}, warn() {}, error() {} },
    probe: async () => ({ alive: true, rtt: 7 }), ...options });
  const server = backend.app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(async () => {
    backend.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  async function request(url, method = 'GET', body) {
    const response = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, body: await response.json(), headers: response.headers };
  }
  return { ...backend, dir, dataFile, base, request };
}

module.exports = { setup };
