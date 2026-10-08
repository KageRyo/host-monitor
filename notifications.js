const http = require('node:http');
const https = require('node:https');

function createNotifier({ enabled = false, url = '', timeoutMs = 5000, logger = console } = {}) {
  let target;
  if (enabled) {
    try {
      target = new URL(url);
      if (!['http:', 'https:'].includes(target.protocol)) throw new Error();
    } catch {
      logger.warn('Webhook URL invalid; notifications disabled');
      enabled = false;
    }
  }
  const queue = [];
  const requests = new Set();
  let active = 0, closed = false;
  function drain() {
    while (!closed && active < 2 && queue.length) {
      const body = queue.shift();
      active++;
      let request, timer, settled = false;
      function finish(message) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        requests.delete(request);
        active--;
        // Never include URLs, response bodies or raw network errors in logs.
        if (message && !closed) logger.warn(message);
        drain();
      }
      try {
        const transport = target.protocol === 'https:' ? https : http;
        request = transport.request(target, { method: 'POST', headers: {
          'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body)
        } }, response => {
          response.resume();
          response.on('error', () => finish('Webhook response failed'));
          response.on('end', () => finish(response.statusCode >= 200 && response.statusCode < 300
            ? null : `Webhook HTTP ${response.statusCode}`));
        });
        requests.add(request);
        timer = setTimeout(() => { request.destroy(); finish('Webhook request timed out'); }, timeoutMs);
        request.on('error', () => finish('Webhook request failed'));
        request.end(body);
      } catch {
        if (request) request.destroy();
        finish('Webhook request failed');
      }
    }
  }
  function notify(event) {
    if (!enabled || closed) return;
    if (queue.length >= 100) { logger.warn('Webhook queue full; event dropped'); return; }
    try { queue.push(JSON.stringify(event)); }
    catch { logger.warn('Webhook payload invalid; event dropped'); return; }
    drain();
  }
  function close() {
    closed = true;
    queue.length = 0;
    for (const request of requests) request.destroy();
  }
  return { notify, close };
}
module.exports = { createNotifier };
