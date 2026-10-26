const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const net = require('node:net');
const { once } = require('node:events');
const root = path.join(__dirname, '..');

async function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'host-monitor-scripts-'));
  for (const file of ['start.sh', 'stop.sh', 'scripts/process-identity.sh']) {
    const dest = path.join(dir, file);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    if (fs.existsSync(path.join(root, file))) fs.copyFileSync(path.join(root, file), dest);
  }
  if (process.env.GO_PRODUCTION_BINARY) fs.copyFileSync(process.env.GO_PRODUCTION_BINARY, path.join(dir, 'host-monitor'));
  else {
    const build = spawnSync('go', ['build', '-o', path.join(dir, 'host-monitor'), '.'], { cwd: root, encoding: 'utf8' });
    assert.equal(build.status, 0, build.stderr);
  }
  fs.mkdirSync(path.join(dir, 'logs'));
  const reservation = net.createServer().listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  fs.writeFileSync(path.join(dir, '.env'), `HOST=127.0.0.1\nPORT=${port}\nLOG_TO_STDOUT=false\n`);
  fs.writeFileSync(path.join(dir, 'server.js'), 'setInterval(() => {}, 1000);');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function run(dir, script) {
  return spawnSync('bash', [path.join(dir, script)], { cwd: dir, encoding: 'utf8', timeout: 15000 });
}
function alive(pid) {
  try { return !fs.readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].startsWith('Z'); }
  catch { return false; }
}

test('stop cleans a reused PID without killing unrelated processes', async t => {
  const dir = await fixture(t);
  const child = spawn('sleep', ['60']);
  await new Promise(resolve => child.once('spawn', resolve));
  t.after(() => child.kill());
  fs.writeFileSync(path.join(dir, 'logs/server.pid'), String(child.pid));
  const result = run(dir, 'stop.sh');
  assert.equal(result.status, 0);
  assert.equal(alive(child.pid), true);
  assert.equal(fs.existsSync(path.join(dir, 'logs/server.pid')), false);
});

test('stop refuses a Node legacy process with wrong recorded start time', async t => {
  const dir = await fixture(t);
  const child = spawn(process.execPath, ['server.js'], { cwd: dir });
  await new Promise(resolve => child.once('spawn', resolve));
  t.after(() => child.kill());
  fs.writeFileSync(path.join(dir, 'logs/server.pid'), String(child.pid));
  fs.writeFileSync(path.join(dir, 'logs/server.identity'), 'wrong-start-time\n');
  assert.equal(run(dir, 'stop.sh').status, 0);
  assert.equal(alive(child.pid), true);
});

test('start and stop reliably manage the exact Linux helper process', async t => {
  const dir = await fixture(t);
  const result = run(dir, 'start.sh');
  const startupLog = path.join(dir, 'logs/startup.log');
  const diagnostics = result.stderr + result.stdout +
    (fs.existsSync(startupLog) ? fs.readFileSync(startupLog, 'utf8') : 'No startup.log was created');
  assert.equal(result.status, 0, diagnostics);
  const pid = Number(fs.readFileSync(path.join(dir, 'logs/server.pid')));
  t.after(() => { try { process.kill(pid, 'SIGKILL'); } catch {} });
  assert.equal(alive(pid), true);
  assert.equal(fs.existsSync(path.join(dir, 'logs/server.identity')), true);
  assert.equal(run(dir, 'stop.sh').status, 0);
  assert.equal(fs.existsSync(path.join(dir, 'logs/server.pid')), false);
  const stat = fs.existsSync(`/proc/${pid}/stat`) ? fs.readFileSync(`/proc/${pid}/stat`, 'utf8') : '';
  assert.ok(!stat || stat.split(') ')[1].startsWith('Z'), 'managed process has exited');
});
