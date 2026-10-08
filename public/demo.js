/* Browser-only simulation: no network requests or real reachability checks. */
(function (root) {
  'use strict';
  const STORAGE_KEY = 'host-monitor-demo:v1';
  const { groupKey, groupLabel } = typeof module !== 'undefined' && module.exports
    ? require('./shared') : root.HostMonitorShared;

  function seed() {
    const now = Date.now();
    const targets = [
      ['Web Server', 'server', 'up', 'Demo rack A'],
      ['Database Server', 'server', 'up', 'Synthetic database host'],
      ['Backup Server', 'server', 'down', 'Simulated maintenance'],
      ['Office NAS', 'nas', 'up', 'Synthetic file storage'],
      ['Backup NAS', 'nas', 'up', 'Demo rack B'],
      ['Office Printer', 'printer', 'down', 'Simulated offline device'],
      ['Edge Gateway', 'edge', 'up', 'Synthetic gateway'],
      ['New Device', 'edge', 'unknown', 'Awaiting a simulated check']
    ];
    const monitors = targets.map(([name, group, status, notes], index) => {
      const ip = `192.0.2.${index + 10}`;
      const history = status === 'unknown' ? [] : Array.from({ length: 60 }, (_, step) => {
        const alive = status === 'up' ? step % 19 !== 0 : step < 40;
        return { time: new Date(now - (59 - step) * 30000).toISOString(), alive, rtt: alive ? 2 + index * 3 + step % 5 : null };
      });
      return {
        id: ip.replaceAll('.', '-'), ip, name, group, status, notes,
        responseTime: history.at(-1)?.rtt ?? null,
        lastCheck: history.at(-1)?.time ?? null,
        history, totalChecks: history.length, upChecks: history.filter(item => item.alive).length
      };
    });
    return { version: 1, monitors, groupOrder: ['server', 'nas', 'printer', 'edge'], lastGlobalCheck: new Date(now).toISOString() };
  }

  function isIpv4(value) {
    return typeof value === 'string' && /^(?:0|[1-9]\d{0,2})(?:\.(?:0|[1-9]\d{0,2})){3}$/.test(value)
      && value.split('.').every(part => Number(part) <= 255);
  }

  function validState(value) {
    return value?.version === 1 && Array.isArray(value.monitors)
      && Array.isArray(value.groupOrder) && value.groupOrder.every(group => typeof group === 'string')
      && value.monitors.every(m => isIpv4(m.ip) && m.id === m.ip.replaceAll('.', '-')
        && ['name', 'group', 'notes'].every(key => typeof m[key] === 'string')
        && ['up', 'down', 'unknown'].includes(m.status)
        && Number.isInteger(m.totalChecks) && m.totalChecks >= 0
        && Number.isInteger(m.upChecks) && m.upChecks >= 0 && m.upChecks <= m.totalChecks
        && Array.isArray(m.history) && m.history.length <= 60
        && m.history.every(item => typeof item.time === 'string' && typeof item.alive === 'boolean'));
  }

  function createDemoApi(storage) {
    let state;
    try {
      const saved = JSON.parse(storage?.getItem(STORAGE_KEY) || 'null');
      if (validState(saved)) state = saved;
    } catch { /* Storage may be disabled or contain an outdated session. */ }
    if (!state) state = seed();
    state.monitors = state.monitors.map(m => ({ ...m, group: groupKey(m.group) }));
    state.groupOrder = [...new Set(state.groupOrder.map(groupKey))];

    function save() {
      try { storage?.setItem(STORAGE_KEY, JSON.stringify(state)); }
      catch { /* Keep the demo usable in memory if browser storage is unavailable. */ }
    }

    function groups() {
      const existing = [...new Set(state.monitors.map(m => m.group))];
      return [...new Set([...state.groupOrder.filter(g => existing.includes(g)), ...existing])];
    }

    function snapshot() {
      const order = groups();
      const monitors = state.monitors.map(m => ({ ...m, groupLabel: groupLabel(m.group) }))
        .sort((a, b) => order.indexOf(a.group) - order.indexOf(b.group) || a.name.localeCompare(b.name, 'zh-Hant'));
      const up = monitors.filter(m => m.status === 'up').length;
      const down = monitors.filter(m => m.status === 'down').length;

      const avgUptime = monitors.length ? monitors.reduce((sum, m) => sum + (m.totalChecks ? m.upChecks / m.totalChecks * 100 : 100), 0) / monitors.length : 0;
      return { monitors, isChecking: false, stats: {
        total: monitors.length, up, down, unknown: monitors.length - up - down,
        avgUptime: Math.round(avgUptime * 10) / 10, lastGlobalCheck: state.lastGlobalCheck
      } };
    }

    function check(monitor, time) {
      // Repeatable synthetic variation; an entered address is never contacted.
      const number = Number(monitor.ip.split('.').at(-1));
      const alive = (monitor.totalChecks + number) % 11 !== 0;
      const rtt = alive ? 2 + (monitor.totalChecks + number) % 28 : null;
      monitor.status = alive ? 'up' : 'down';
      monitor.responseTime = rtt;
      monitor.lastCheck = time;
      monitor.totalChecks += 1;
      if (alive) monitor.upChecks += 1;
      monitor.history = [...monitor.history, { time, alive, rtt }].slice(-60);
    }

    const reply = (body, status = 200) => new Response(JSON.stringify(body), {
      status, headers: { 'Content-Type': 'application/json' }
    });
    const error = (message, status) => reply({ error: message }, status);
    const text = (value, fallback = '') => typeof value === 'string' && value.trim() ? value.trim() : fallback;

    async function request(url, options = {}) {
      const method = options.method || 'GET';
      let body = {};
      try { if (options.body !== undefined) body = JSON.parse(options.body); }
      catch { return error('Invalid JSON', 400); }
      if (!body || typeof body !== 'object' || Array.isArray(body)) return error('Expected a JSON object', 400);

      if (url === '/api/monitors' && method === 'GET') return reply(snapshot());
      if (url === '/api/monitors' && method === 'POST') {
        const ip = text(body.ip);
        if (!isIpv4(ip)) return error('Invalid IPv4 address', 400);
        if (state.monitors.some(m => m.ip === ip)) return error('Monitor with this IP already exists', 409);
        const monitor = {
          id: ip.replaceAll('.', '-'), ip, name: text(body.name, ip), group: groupKey(text(body.group, 'server')),
          notes: text(body.notes), status: 'unknown', responseTime: null, lastCheck: null,
          history: [], totalChecks: 0, upChecks: 0
        };
        state.monitors.push(monitor);
        save();
        return reply(monitor, 201);
      }
      if (url === '/api/groups/order' && method === 'GET') return reply({ order: groups() });
      if (url === '/api/groups/order' && method === 'PUT') {
        if (!Array.isArray(body.order) || !body.order.every(g => typeof g === 'string')) return error('order must be an array of strings', 400);
        const existing = groups();
        state.groupOrder = [...new Set([...body.order.map(groupKey).filter(g => existing.includes(g)), ...existing])];
        save();
        return reply({ success: true, order: state.groupOrder });
      }
      if (url === '/api/check-all' && method === 'POST') {
        const now = new Date().toISOString();
        state.monitors.forEach(m => check(m, now));
        state.lastGlobalCheck = now;
        save();
        return reply({ success: true, ...snapshot() });
      }
      const match = /^\/api\/monitors\/([^/]+)(\/check)?$/.exec(url);
      if (match) {
        const monitor = state.monitors.find(m => m.id === match[1]);
        if (!monitor) return error('Monitor not found', 404);
        if (match[2] && method === 'POST') check(monitor, new Date().toISOString());
        else if (!match[2] && method === 'PUT') {
          monitor.name = text(body.name, monitor.name);
          monitor.group = groupKey(text(body.group, monitor.group));
          if (typeof body.notes === 'string') monitor.notes = body.notes.trim();
        } else if (!match[2] && method === 'DELETE') {
          state.monitors = state.monitors.filter(m => m.id !== monitor.id);
          save();
          return reply({ success: true });
        } else return error('Unknown demo endpoint', 404);
        save();
        return reply({ ...monitor, groupLabel: groupLabel(monitor.group) });
      }
      return error('Unknown demo endpoint', 404);
    }

    save();
    return { request, reset() { state = seed(); save(); } };
  }

  if (typeof module !== 'undefined' && module.exports) module.exports = { createDemoApi };
  else root.createDemoApi = createDemoApi;
})(typeof window === 'undefined' ? globalThis : window);
