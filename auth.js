const { createHash, timingSafeEqual } = require('node:crypto');

function createBasicAuth({ authEnabled, authUsername, authPassword }) {
  if (!authEnabled) return (req, res, next) => next();
  if (typeof authUsername !== 'string' || !authUsername.trim() || /[:\x00-\x1f\x7f]/.test(authUsername) ||
      typeof authPassword !== 'string' || !authPassword || /[\x00-\x1f\x7f]/.test(authPassword)) {
    throw new Error('Invalid authentication configuration');
  }
  const hash = value => createHash('sha256').update(value).digest();
  const expected = hash(Buffer.from(`${authUsername}:${authPassword}`, 'utf8'));
  return (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    const match = /^Basic ([A-Za-z0-9+/]+={0,2})$/i.exec(req.get('authorization') || '');
    if (!match || !timingSafeEqual(hash(Buffer.from(match[1], 'base64')), expected)) {
      res.set('WWW-Authenticate', 'Basic realm="Host Monitor", charset="UTF-8"');
      return res.status(401).json({ error: 'Authentication required' });
    }
    // Browsers attach cached Basic credentials automatically; reject cross-site writes.
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      let foreignOrigin = false;
      if (req.get('origin')) {
        try { foreignOrigin = new URL(req.get('origin')).host !== req.get('host'); }
        catch { foreignOrigin = true; }
      }
      if (foreignOrigin || req.get('sec-fetch-site') === 'cross-site') {
        return res.status(403).json({ error: 'Cross-site operation rejected' });
      }
    }
    next();
  };
}

module.exports = { createBasicAuth };
