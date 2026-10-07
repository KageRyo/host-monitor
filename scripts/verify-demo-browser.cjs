const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const os = require('node:os');
// Serve a fixed asset allowlist. Request paths never become filesystem paths.
const assets = new Map();
for (const [prefix, folder] of [['/host-monitor/', 'demo-dist'], ['/', 'public']]) {
  const html = fs.readFileSync(path.join(root, folder, 'index.html'));
  const js = fs.readFileSync(path.join(root, folder, 'demo.js'));
  assets.set(prefix, { type: 'text/html', body: html });
  assets.set(`${prefix}index.html`, { type: 'text/html', body: html });
  assets.set(`${prefix}demo.js`, { type: 'text/javascript', body: js });
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
    console.log('Browser checks passed: Pages subpath, filters, theme, CRUD, literal input, persistence, manual and automatic checks, reorder, reset, mobile, blocked storage, and normal transport.');
  } finally { await browser.close(); server.close(); }
})().catch(error => { console.error(error); server.close(); process.exitCode = 1; });
