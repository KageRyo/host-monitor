/* Shared data semantics for the backend, dashboard and browser-only demo. */
(function (root) {
  'use strict';
  const labels = new Map([['server', '伺服器'], ['nas', 'NAS'], ['printer', '印表機'], ['edge', '邊緣裝置']]);
  const aliases = new Map([...labels].map(([key, label]) => [label, key]));
  aliases.set('邊緣版', 'edge');
  function groupKey(value) {
    const group = typeof value === 'string' && value.trim() ? value.trim() : 'server';
    return aliases.get(group) || group;
  }
  const groupLabel = group => labels.get(group) || group;
  const shared = { groupKey, groupLabel };
  if (typeof module !== 'undefined' && module.exports) module.exports = shared;
  else root.HostMonitorShared = shared;
})(typeof globalThis !== 'undefined' ? globalThis : this);
