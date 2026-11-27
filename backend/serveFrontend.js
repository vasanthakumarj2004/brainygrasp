'use strict';

const express = require('express');
const fs = require('fs');
const path = require('path');

function mountFrontend(app, { root = path.resolve(__dirname, '..') } = {}) {
  const frontend = path.join(root, 'frontend');
  const admin = path.join(root, 'admin');
  for (const entry of [path.join(frontend, 'index.html'), path.join(admin, 'index.html'),
    path.join(frontend, 'affiliate', 'login.html')]) {
    if (!fs.existsSync(entry)) throw new Error('Frontend files are missing. Deploy the full project or build Docker from the project root.');
  }
  // Mount after API routes. An unknown API URL must never return a frontend page.
  app.use('/api', (req, res) => res.status(404).json({ error: 'API route not found' }));
  // Redirect browser URLs only; static middleware still reads .html files.
  // Keep query strings intact (search, affiliate attribution and checkout).
  app.use((req, res, next) => {
    if (!['GET', 'HEAD'].includes(req.method)) return next();
    const [pathname] = req.originalUrl.split('?');
    if (!pathname.endsWith('.html')) return next();
    const target = pathname.slice(0, -5) + req.originalUrl.slice(pathname.length);
    // A relative Location must never become a protocol-relative external URL.
    if (target.startsWith('//') || target.includes('\\')) return res.sendStatus(400);
    res.redirect(308, target);
  });
  const options = {
    dotfiles: 'deny', extensions: ['html'], maxAge: 0,
    setHeaders(res, file) {
      // Revalidate scripts/styles on deployment; do not retain protected HTML.
      res.set('Cache-Control', path.extname(file) === '.html' ? 'no-store' : 'public, max-age=0, must-revalidate');
      res.set('X-Content-Type-Options', 'nosniff');
    },
  };
  app.use('/admin', express.static(admin, options));
  app.use('/affiliate', express.static(path.join(frontend, 'affiliate'), { ...options, index: 'login.html' }));
  app.use('/frontend', express.static(frontend, options));
  app.use(express.static(frontend, options));
}

function createFrontendHandler() {
  const app = express();
  mountFrontend(app);
  return app;
}

module.exports = { mountFrontend, createFrontendHandler };
