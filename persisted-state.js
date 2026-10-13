const net = require('node:net');
const { groupKey } = require('./public/shared');

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const timestamp = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value));
const nullableTime = value => value === undefined || value === null || timestamp(value);
const rtt = value => value === undefined || value === null || (typeof value === 'number' && Number.isFinite(value) && value >= 0);
const counter = value => Number.isSafeInteger(value) && value >= 0;
function requireValid(condition, field) {
  if (!condition) throw new Error(`Invalid persisted ${field}`);
}

function validatePersistedState(data) {
  requireValid(object(data) && Array.isArray(data.monitors), 'monitor list');
  requireValid(nullableTime(data.lastGlobalCheck) && nullableTime(data.savedAt), 'timestamp');
  requireValid(data.groupOrder === undefined || (Array.isArray(data.groupOrder) && data.groupOrder.every(g => typeof g === 'string')), 'group order');
  const ids = new Set();
  const monitors = data.monitors.map(m => {
    requireValid(object(m) && typeof m.ip === 'string' && net.isIPv4(m.ip.trim()), 'monitor IP');
    const ip = m.ip.trim();
    const id = ip.replaceAll('.', '-');
    requireValid((m.id === undefined || m.id === id) && !ids.has(id), 'monitor identity');
    ids.add(id);
    for (const field of ['name', 'group', 'notes']) requireValid(m[field] === undefined || typeof m[field] === 'string', field);
    const history = m.history === undefined ? [] : m.history;
    requireValid(Array.isArray(history) && history.length <= 60, 'history length');
    for (const entry of history) {
      requireValid(object(entry) && timestamp(entry.time) && rtt(entry.rtt), 'history entry');
      requireValid(typeof entry.alive === 'boolean'
        ? entry.error === undefined || entry.error === null
        : entry.alive === null && entry.error === 'probe_execution_failed' && entry.rtt == null, 'history outcome');
    }
    const measured = history.filter(entry => typeof entry.alive === 'boolean');
    const recentUp = measured.filter(entry => entry.alive).length;
    const totalChecks = m.totalChecks === undefined ? measured.length : m.totalChecks;
    const upChecks = m.upChecks === undefined ? recentUp : m.upChecks;
    requireValid(counter(totalChecks) && counter(upChecks) && upChecks <= totalChecks &&
      totalChecks >= measured.length && upChecks >= recentUp && totalChecks - upChecks >= measured.length - recentUp, 'check counters');
    const status = m.status === undefined ? 'unknown' : m.status;
    requireValid(['up', 'down', 'unknown', 'error'].includes(status), 'status');
    requireValid(rtt(m.responseTime) && nullableTime(m.lastCheck), 'last result');
    requireValid(status === 'error' ? m.checkError === 'probe_execution_failed'
      : m.checkError === undefined || m.checkError === null, 'check error');
    const lastMeasured = measured.at(-1);
    const lastReachabilityStatus = m.lastReachabilityStatus === undefined
      ? ['up', 'down'].includes(status) ? status : lastMeasured ? lastMeasured.alive ? 'up' : 'down' : 'unknown'
      : m.lastReachabilityStatus;
    requireValid(['up', 'down', 'unknown'].includes(lastReachabilityStatus) &&
      (!['up', 'down'].includes(status) || lastReachabilityStatus === status), 'confirmed status');
    return {
      id, ip, name: m.name || ip, group: groupKey(m.group), notes: m.notes || '', status,
      checkError: m.checkError || null, lastReachabilityStatus,
      responseTime: m.responseTime ?? null, lastCheck: m.lastCheck ?? null,
      history: history.map(entry => ({ ...entry, rtt: entry.rtt ?? null })), totalChecks, upChecks
    };
  });
  return { monitors, groupOrder: [...new Set((data.groupOrder || []).map(groupKey))], lastGlobalCheck: data.lastGlobalCheck ?? null };
}

module.exports = { validatePersistedState };
