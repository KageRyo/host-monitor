const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const os = require('node:os');
const { createApp } = require('../app');
const liveDir = fs.mkdtempSync(path.join(os.tmpdir(), 'host-monitor-browser-'));
const backend = createApp({ dataFile: path.join(liveDir, 'monitors.json'),
  probe: async () => ({ alive: true, rtt: 7 }), logger: { log() {}, warn() {}, error() {} } });
let liveServer;
// Serve a fixed asset allowlist. Request paths never become filesystem paths.
const assets = new Map();
for (const [prefix, folder] of [['/host-monitor/', 'demo-dist'], ['/', 'public']]) {
  const html = fs.readFileSync(path.join(root, folder, 'index.html'));
  assets.set(`${prefix}api.js`, { type: 'text/javascript', body: fs.readFileSync(path.join(root, folder, 'api.js')) });
  const js = fs.readFileSync(path.join(root, folder, 'demo.js'));
  assets.set(prefix, { type: 'text/html', body: html });
  assets.set(`${prefix}index.html`, { type: 'text/html', body: html });
  assets.set(`${prefix}demo.js`, { type: 'text/javascript', body: js });
  assets.set(`${prefix}shared.js`, { type: 'text/javascript', body: fs.readFileSync(path.join(root, folder, 'shared.js')) });
}
const server = http.createServer((req, res) => {
  const asset = assets.get(new URL(req.url, 'http://localhost').pathname);
  if (!asset) { res.writeHead(404); res.end(); return; }
  res.setHeader('Content-Type', asset.type);
  res.end(asset.body);
});
(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined, args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors = [], apiRequests = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', req => { if (new URL(req.url()).pathname.startsWith('/api/')) apiRequests.push(req.url()); });
    page.on('dialog', dialog => dialog.accept());
    await page.goto(`http://127.0.0.1:${port}/host-monitor/`, { waitUntil: 'networkidle' });
    await page.waitForSelector('.monitor-card');
    assert.equal(await page.locator('.monitor-card').count(), 8);
    assert.ok(await page.locator('#demo-banner').isVisible());
    await page.evaluate(() => setFilter('down'));
    assert.equal(await page.locator('.monitor-card').count(), 2);
    await page.evaluate(() => setFilter('all'));
    await page.evaluate(() => toggleTheme());
    assert.ok(await page.evaluate(() => ['dark', 'light'].includes(localStorage.getItem('theme'))));
    await page.evaluate(() => showAddModal());
    await page.fill('#form-ip', '198.51.100.7');
    await page.fill('#form-name', '<img src=x onerror="window.injected=true">');
    await page.fill('#form-group', "Demo group's rack");
    await page.fill('#form-notes', '<b>Literal note</b>');
    await page.evaluate(() => submitFormModal());
    assert.equal(await page.locator('.monitor-card').count(), 9, 'custom categories must render');
    assert.equal(await page.evaluate(() => window.injected), undefined, 'host names must render as text');
    assert.ok((await page.locator('#groups-container').innerText()).includes('<img src=x'));
    await page.reload({ waitUntil: 'networkidle' });
    assert.equal(await page.locator('.monitor-card').count(), 9);
    await page.evaluate(() => showDetailModal(currentMonitors.find(m => m.ip === '198.51.100.7')));
    await page.evaluate(() => editFromModal());
    await page.fill('#form-name', 'Demo edited host');
    await page.evaluate(() => submitFormModal());
    assert.ok((await page.locator('#groups-container').innerText()).includes('Demo edited host'));
    await page.evaluate(() => showDetailModal(currentMonitors.find(m => m.ip === '198.51.100.7')));
    await page.evaluate(() => { checkSingleFromModal(); });
    await page.waitForFunction(() => currentMonitors.find(m => m.ip === '198.51.100.7').totalChecks === 1, null, { timeout: 5000 });
    assert.ok(await page.locator('#detail-modal').isVisible(), 'single check keeps detail visible');
    assert.equal(await page.evaluate(() => currentMonitors.find(m => m.ip === '198.51.100.7').totalChecks), 1);
    await page.evaluate(() => deleteFromModal());
    assert.equal(await page.locator('.monitor-card').count(), 8);
    await page.evaluate(() => checkAllNow());
    await page.evaluate(() => toggleReorderMode());
    const oldFirst = await page.locator('#groups-container > div').first().getAttribute('data-internal-group');
    await page.evaluate(key => moveGroupByInternal(key, 1), oldFirst);
    await page.evaluate(() => toggleReorderMode());
    await page.reload({ waitUntil: 'networkidle' });
    assert.notEqual(await page.locator('#groups-container > div').first().getAttribute('data-internal-group'), oldFirst);
    // Accelerate the real 30-second timer before a reload to exercise automatic simulation.
    await page.addInitScript(() => {
      const original = window.setInterval;
      window.setInterval = (callback, delay) => original(callback, delay === 30000 ? 200 : delay);
    });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => currentMonitors.every(m => m.totalChecks > 0));
    await page.evaluate(() => resetDemo());
    assert.equal(await page.locator('.monitor-card').count(), 8);
    await page.screenshot({ path: path.join(os.tmpdir(), 'host-monitor-demo-desktop.png'), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: path.join(os.tmpdir(), 'host-monitor-demo-mobile.png'), fullPage: true });
    assert.ok(await page.evaluate(() => [...document.querySelectorAll('nav button')].every(button => { const rect = button.getBoundingClientRect(); return rect.top >= 0 && rect.bottom <= 64 && rect.right <= innerWidth; })), 'mobile navigation buttons must fit');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'mobile page must fit viewport');
    // Fresh browser with disabled storage must still render and allow edits.
    const blocked = await browser.newPage();
    await blocked.addInitScript(() => Object.defineProperty(window, 'localStorage', { get() { throw new Error('Storage disabled'); } }));
    await blocked.goto(`http://127.0.0.1:${port}/host-monitor/`, { waitUntil: 'networkidle' });
    assert.equal(await blocked.locator('.monitor-card').count(), 8);
    // Normal hosting retains the real transport and hides the demo banner.
    const real = await browser.newPage();
    await real.route('**/api/monitors', route => route.fulfill({ json: { monitors: [], stats: { total: 0 } } }));
    await real.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'networkidle' });
    assert.equal(await real.locator('#demo-banner').isVisible(), false);
    assert.ok(await real.locator('#empty-state').isVisible());
    assert.deepEqual(apiRequests, [], 'demo must not send API requests');
    assert.deepEqual(errors, [], 'demo must not have browser errors');
    // HTTP failures must never create success toasts or erase local form/detail state.
    const failure = await browser.newPage();
    failure.on('dialog', dialog => dialog.accept());
    const fixture = { id: '192-0-2-1', ip: '192.0.2.1', name: 'Unchecked', group: 'server', groupLabel: '伺服器',
      notes: '', status: 'unknown', responseTime: null, lastCheck: null, history: [], totalChecks: 0, upChecks: 0 };
    let failureStatus = 500, failureMessage = 'Mock persistence failure', nonJson = false, abortRequest = false;
    await failure.route('**/api/**', route => {
      if (route.request().method() === 'GET') return route.fulfill({ json: { monitors: [fixture], stats: { total: 1, unknown: 1, avgUptime: null } } });
      if (abortRequest) return route.abort();
      return route.fulfill({ status: failureStatus, contentType: nonJson ? 'text/html' : 'application/json',
        body: nonJson ? '<html>bad gateway</html>' : JSON.stringify({ error: failureMessage }) });
    });
    await failure.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'networkidle' });
    await failure.waitForSelector('.monitor-card');
    assert.ok((await failure.locator('#global-stats').innerText()).includes('—'), 'unknown global uptime');
    assert.ok((await failure.locator('.monitor-card').innerText()).includes('可用率 —'), 'unknown card uptime');
    await failure.evaluate(() => {
      window.testToasts = [];
      const original = showToast;
      showToast = (message, error = false) => { window.testToasts.push({ message, error }); original(message, error); };
      showDetailModal(currentMonitors[0]);
    });
    assert.equal(await failure.locator('#modal-uptime').innerText(), '—');
    await failure.evaluate(async () => {
      await checkAllNow();
      await checkSingleFromModal();
      await deleteFromModal();
      await saveGroupOrder();
    });
    assert.ok(await failure.locator('#detail-modal').isVisible(), 'failed actions retain detail');
    await failure.evaluate(() => showAddModal());
    await failure.fill('#form-ip', '192.0.2.2');
    await failure.evaluate(() => submitFormModal());
    assert.ok(await failure.locator('#form-modal').isVisible(), 'failed create retains form');
    await failure.evaluate(() => { hideFormModal(); showEditModal(currentMonitors[0]); });
    await failure.fill('#form-name', 'Unsaved edit');
    await failure.evaluate(() => submitFormModal());
    assert.ok(await failure.locator('#form-modal').isVisible(), 'failed edit retains form');
    assert.equal(await failure.evaluate(() => currentMonitors[0].name), 'Unchecked');
    assert.deepEqual(await failure.evaluate(() => window.testToasts.map(item => item.error)), Array(6).fill(true));
    assert.ok((await failure.evaluate(() => window.testToasts)).every(item => item.message === 'Mock persistence failure'));
    failureStatus = 429; failureMessage = 'Check already in progress';
    await failure.evaluate(() => checkAllNow());
    assert.equal(await failure.locator('#toast-text').innerText(), '檢查中，請稍候');
    failureMessage = '檢查請求過於頻繁，請稍後再試';
    await failure.evaluate(() => checkAllNow());
    assert.equal(await failure.locator('#toast-text').innerText(), failureMessage);
    failureStatus = 400; failureMessage = 'Invalid JSON';
    await failure.evaluate(() => checkAllNow());
    assert.equal(await failure.locator('#toast-text').innerText(), 'Invalid JSON');
    failureStatus = 502; nonJson = true;
    await failure.evaluate(() => checkAllNow());
    assert.ok((await failure.locator('#toast-text').innerText()).includes('HTTP 502'));
    abortRequest = true;
    await failure.evaluate(() => checkAllNow());
    assert.equal(await failure.evaluate(() => window.testToasts.at(-1).error), true);
    assert.equal(await failure.locator('.monitor-card').count(), 1);

    // Browser → actual Express routes → isolated JSON file, with a mocked ICMP boundary.
    liveServer = backend.app.listen(0, '127.0.0.1');
    await new Promise(resolve => liveServer.once('listening', resolve));
    const live = await browser.newPage();
    live.on('dialog', dialog => dialog.accept());
    live.on('pageerror', error => errors.push(error.message));
    await live.goto(`http://127.0.0.1:${liveServer.address().port}/`, { waitUntil: 'networkidle' });
    await live.evaluate(() => showAddModal());
    await live.fill('#form-ip', '192.0.2.8');
    await live.fill('#form-name', 'Real route test');
    await live.evaluate(() => submitFormModal());
    assert.equal(await live.locator('.monitor-card').count(), 1);
    assert.equal(JSON.parse(fs.readFileSync(path.join(liveDir, 'monitors.json'))).monitors[0].group, 'server');
    await live.evaluate(() => showDetailModal(currentMonitors[0]));
    await live.evaluate(() => checkSingleFromModal());
    assert.equal(await live.locator('#modal-uptime').innerText(), '100.0%');
    await live.evaluate(() => checkAllNow());
    assert.equal(JSON.parse(fs.readFileSync(path.join(liveDir, 'monitors.json'))).monitors[0].totalChecks, 2);
    await live.evaluate(() => { showDetailModal(currentMonitors[0]); editFromModal(); });
    await live.fill('#form-name', 'Saved edit');
    await live.evaluate(() => submitFormModal());
    assert.equal(JSON.parse(fs.readFileSync(path.join(liveDir, 'monitors.json'))).monitors[0].name, 'Saved edit');
    await live.evaluate(() => showDetailModal(currentMonitors[0]));
    await live.evaluate(() => deleteFromModal());
    assert.ok(await live.locator('#empty-state').isVisible());
    assert.equal(JSON.parse(fs.readFileSync(path.join(liveDir, 'monitors.json'))).monitors.length, 0);
    assert.deepEqual(errors, [], 'dashboard must not have browser errors');
    console.log('Browser checks passed: demo interactions, Pages subpath, responsive layout, real backend CRUD/persistence/checks, unknown uptime, and 400/429/500/non-JSON/network error handling.');
  } finally {
    await browser.close();
    server.close();
    backend.close();
    if (liveServer) { liveServer.closeAllConnections(); await new Promise(resolve => liveServer.close(resolve)); }
    fs.rmSync(liveDir, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); backend.close(); server.close(); fs.rmSync(liveDir, { recursive: true, force: true }); process.exitCode = 1; });
