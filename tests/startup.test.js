const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { once } = require('node:events');

for (const host of ['127.0.0.1', '0.0.0.0']) {
  test(`startup listens on ${host} and advertises matching URLs`, { timeout: 10000 }, async t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'host-monitor-startup-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    for (const file of ['server.js', 'config.js']) fs.copyFileSync(path.join(__dirname, '..', file), path.join(dir, file));
    // Exercise the production boot path and actual socket without starting monitoring jobs.
    fs.writeFileSync(path.join(dir, 'app.js'), `
      const http = require('node:http');
      exports.createApp = () => ({
        app: { listen: (...args) => {
          const server = http.createServer((req, res) => res.end(JSON.stringify(server.address())));
          return server.listen(...args);
        } }, startChecker() {}, close() {}
      });
    `);
    const reservation = net.createServer().listen(0, '127.0.0.1');
    await once(reservation, 'listening');
    const port = reservation.address().port;
    await new Promise(resolve => reservation.close(resolve));
    const child = spawn(process.execPath, [path.join(dir, 'server.js')], {
      env: { ...process.env, HOST: host, PORT: String(port), LOG_TO_STDOUT: 'true' }
    });
    t.after(async () => {
      if (child.exitCode === null) { child.kill(); await once(child, 'exit'); }
    });
    let output = '';
    await new Promise((resolve, reject) => {
      child.stdout.on('data', chunk => {
        output += chunk;
        if (output.includes('自動檢查間隔')) resolve();
      });
      child.once('error', reject);
      child.once('exit', code => reject(new Error(`startup exited: ${code}`)));
    });
    const address = await (await fetch(`http://127.0.0.1:${port}`)).json();
    assert.equal(address.address, host);
    assert.ok(output.includes(`http://127.0.0.1:${port}`));
    assert.equal(output.includes('區域網路'), host === '0.0.0.0');
  });
}
