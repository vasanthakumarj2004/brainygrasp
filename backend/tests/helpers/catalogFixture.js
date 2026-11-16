'use strict';

// Uses real Express routes and SQL argument mapping with an in-memory catalog.
// It never loads .env, opens a database connection, or calls a remote service.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const express = require('express');
const jwt = require('jsonwebtoken');
const root = path.resolve(__dirname, '../../..');
const environment = { JWT_SECRET: 'catalog-test-secret', ADMIN_USERNAME: 'catalog-review', ADMIN_PASSWORD: 'local-review-only' };

function createCatalogFixture(initial = []) {
  const rows = structuredClone(initial), invalidations = [];
  let nextId = Math.max(0, ...rows.map(row => row.id)) + 1;
  const state = { rows, invalidations, unavailable: false };
  const pool = { async query(sql, args = []) {
    if (state.unavailable) throw new Error('Simulated database outage');
    let result;
    if (sql.includes('INSERT INTO products')) {
      const columns = sql.match(/INSERT INTO products\s*\(([\s\S]*?)\)\s*VALUES/)[1].split(',').map(key => key.trim());
      const row = { id: nextId++ };
      columns.forEach((key, index) => { row[key] = key === 'skills' ? JSON.parse(args[index]) : args[index]; });
      rows.push(row); result = [row];
    } else if (sql.includes('UPDATE products SET')) {
      const row = rows.find(row => row.id === args[17]);
      if (row) for (const match of sql.split('WHERE')[0].matchAll(/(\w+)=\$(\d+)/g)) {
        const value = args[Number(match[2])-1]; row[match[1]] = match[1] === 'skills' ? JSON.parse(value) : value;
      }
      result = row ? [row] : [];
    } else if (sql.includes('DELETE FROM products')) {
      const index = rows.findIndex(row => row.id === args[0]);
      result = index < 0 ? [] : rows.splice(index, 1);
    } else if (sql.includes('FROM products')) {
      result = [...rows];
      if (sql.includes('ILIKE')) {
        const term = args[0].slice(1,-1).replace(/\\([%_\\])/g, '$1').toLowerCase();
        result = result.filter(row => (sql.includes('GROUP BY') ? [row.category] : [row.name, row.category, row.theme, row.group_name])
          .some(value => String(value || '').toLowerCase().includes(term)));
      }
      if (sql.includes('GROUP BY')) result = [...new Set(result.map(row => row.category))].map(name => ({ name, product_count: result.filter(row => row.category === name).length }));
    } else throw new Error(`Unexpected query: ${sql}`);
    return { rows: structuredClone(result) };
  } };
  const cache = { getCached() { throw new Error('Catalog must not read stale Redis data'); },
    clearCachePattern: async pattern => { invalidations.push(pattern); }, deleteCache: async () => {}, CACHE_KEYS: {} };
  function load(relative) {
    const filename = path.join(root, 'backend', relative), requireLocal = createRequire(filename), module = { exports: {} };
    const mocks = { '../db': pool, '../redisClient': cache, '../shiprocketService': {}, '../shippingJobs': {}, '../orderFulfillment': {} };
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), { module, exports: module.exports, Buffer, console,
      process: { env: environment }, require: name => Object.hasOwn(mocks, name) ? mocks[name] : requireLocal(name) }, { filename });
    return module.exports;
  }
  const app = express();
  app.use(express.json());
  app.use(load('routes/admin.js'));
  app.use(load('routes/products.js'));
  app.get('/js/config.js', (req,res) => res.type('js').send('window.BG_CONFIG={API_BASE:""};'));
  app.get('/admin/js/config.js', (req,res) => res.type('js').send('window.BG_ADMIN_CONFIG={API_BASE:""};'));
  app.use('/admin', express.static(path.join(root, 'admin')));
  app.use(express.static(path.join(root, 'frontend')));
  return { app, state, token: jwt.sign({ role: 'admin', username: environment.ADMIN_USERNAME }, environment.JWT_SECRET), environment };
}
module.exports = { createCatalogFixture };

if (require.main === module) {
  const fixture = createCatalogFixture();
  fixture.app.listen(4317, '127.0.0.1', () => console.log('Local catalog review at http://127.0.0.1:4317 (in-memory data only)'));
}
