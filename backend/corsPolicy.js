'use strict';

function normalizeOrigin(value) {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
        url.pathname !== '/' || url.search || url.hash) return null;
    return url.origin;
  } catch { return null; }
}

function createCorsPolicy(env = process.env) {
  const configured = [env.ALLOWED_ORIGINS, env.FRONTEND_URL].filter(Boolean).join(',');
  const allowed = new Set();
  for (const value of configured.split(',').map(value => value.trim()).filter(Boolean)) {
    const origin = normalizeOrigin(value);
    if (!origin) throw new Error('CORS configuration must contain HTTP(S) origins without paths or wildcards');
    allowed.add(origin);
  }
  const openDevelopment = env.NODE_ENV !== 'production' && allowed.size === 0;

  return (req, res, next) => {
    const origin = req.get('origin');
    res.vary('Origin');
    // A page served by this app may call its own API, including EC2 IP previews.
    // Use Host, not client-supplied X-Forwarded-Host. A TLS proxy must preserve Host.
    const sameOrigin = origin && origin === normalizeOrigin(`${req.protocol}://${req.get('host')}`);
    let localDevelopment = false;
    if (env.NODE_ENV !== 'production' && normalizeOrigin(origin)) {
      localDevelopment = ['localhost', '127.0.0.1', '[::1]'].includes(new URL(origin).hostname);
    }
    if (origin) {
      if (!openDevelopment && !localDevelopment && !sameOrigin && !allowed.has(origin)) {
        return res.status(403).json({ error: 'CORS: Origin not allowed.' });
      }
      res.set('Access-Control-Allow-Origin', openDevelopment ? '*' : origin);
      if (!openDevelopment) res.set('Access-Control-Allow-Credentials', 'true');
    }
    res.set('Access-Control-Allow-Methods', 'GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.set('Access-Control-Max-Age', '86400');
    if (req.method === 'OPTIONS') return res.status(204).end();
    next();
  };
}

module.exports = { createCorsPolicy };
