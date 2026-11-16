'use strict';
require('dotenv').config({ path: require('path').join(__dirname, '.env'), quiet: true });
const pool = require('./db');
const { migrateCatalog } = require('./catalogMigration');

(async () => {
  let client;
  try {
    client = await pool.connect();
    const changed = await migrateCatalog(client);
    const { rows } = await client.query('SELECT id, name, price, original_price, stock_quantity FROM products ORDER BY id');
    console.log(changed ? 'Catalog replaced; previous rows backed up in catalog_migrations.' : 'Catalog migration already applied; existing edits preserved.');
    console.log(JSON.stringify(rows, null, 2));
  } catch (error) {
    console.error('Catalog import failed:', error.code || error.message);
    process.exitCode = 1;
  } finally {
    client?.release();
    await pool.end();
  }
})();
