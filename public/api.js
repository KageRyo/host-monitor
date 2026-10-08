(function (root) {
  'use strict';
  function createJsonRequest(transport) {
    return async function request(url, options) {
      const response = await transport(url, options);
      let body;
      try { body = await response.json(); } catch { /* Proxies may return HTML. */ }
      if (!response.ok) {
        const message = typeof body?.error === 'string' ? body.error : `請求失敗 (HTTP ${response.status})`;
        const error = new Error(message);
        error.status = response.status;
        throw error;
      }
      if (body === undefined) throw new Error('伺服器回應格式錯誤');
      return body;
    };
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = { createJsonRequest };
  else root.createJsonRequest = createJsonRequest;
})(typeof globalThis !== 'undefined' ? globalThis : this);
