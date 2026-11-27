/**
 * frontend-server.js — BrainyGrasp Dedicated Frontend Server
 * ─────────────────────────────────────────────────────────────
 * Port : 5500 by default (override with FRONTEND_PORT)
 * Serves:
 *   /           → frontend/index.html
 *   /admin/*    → admin/
 *   /affiliate/ → frontend/affiliate/
 *
 * Backend API is served SEPARATELY on port 3000 (backend/server.js).
 * All /api/* calls from the browser go to http://localhost:3000.
 */

const http = require('http');
const { createFrontendHandler } = require('./backend/serveFrontend');
const serveFrontend = createFrontendHandler();
const path = require('path');

const FRONTEND_DIR  = path.join(__dirname, 'frontend');
const ADMIN_DIR     = path.join(__dirname, 'admin');

const server = http.createServer((req, res) => {
  // CORS headers (development convenience)
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  const rawUrl    = req.url || '/';
  const cleanPath = rawUrl.split('?')[0];

  if (cleanPath === '/api' || cleanPath.startsWith('/api/')) {
    const requestHeaders = { ...req.headers };
    delete requestHeaders.connection;
    const proxy = http.request({
      hostname: '127.0.0.1',
      port: process.env.BACKEND_PORT || 3000,
      path: rawUrl,
      method: req.method,
      headers: requestHeaders,
    }, apiResponse => {
      const responseHeaders = { ...apiResponse.headers };
      delete responseHeaders.connection;
      responseHeaders['cache-control'] = 'no-store';
      res.writeHead(apiResponse.statusCode || 502, responseHeaders);
      apiResponse.pipe(res);
    });

    proxy.on('error', error => {
      console.error('Backend API proxy failed:', error.message);
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ error: 'Backend service unavailable' }));
      } else {
        res.destroy(error);
      }
    });
    req.pipe(proxy);
    return;
  }

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  // Share clean URLs, redirects, cache policy and static-file boundaries
  // with the combined backend/frontend server.
  serveFrontend(req, res);
});

const PORT = process.env.FRONTEND_PORT || 5500;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`🌐 Frontend server  →  http://localhost:${PORT}`);
  console.log(`🛠️  Admin panel      →  http://localhost:${PORT}/admin`);
  console.log(`📁 Serving frontend from: ${FRONTEND_DIR}`);
  console.log(`📁 Serving admin    from: ${ADMIN_DIR}`);
  console.log(`⚡ Backend API       →  http://localhost:3000  (run separately)`);
});
