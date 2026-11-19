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

module.exports = { mountFrontend };
