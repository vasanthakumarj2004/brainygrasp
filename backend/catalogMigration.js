'use strict';

const catalog = require('./catalog-products.json');
const MIGRATION = '2026-11-15-sentence-safari-mag-clash';

// Run once: keep a recoverable snapshot, never reuse mock IDs, and never reset
// stock or later admin edits on a subsequent server start. Orders retain their
// original JSON snapshots; stale cart IDs fail normal checkout validation.
async function migrateCatalog(client) {
  await client.query('BEGIN');
  try {
    await client.query("SELECT pg_advisory_xact_lock(hashtext('brainygrasp-catalog-migration'))");
    await client.query(`CREATE TABLE IF NOT EXISTS catalog_migrations (
      name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), previous_products JSONB NOT NULL
    )`);
    const applied = await client.query('SELECT name FROM catalog_migrations WHERE name = $1', [MIGRATION]);
    if (applied.rows.length) { await client.query('COMMIT'); return false; }
    await client.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS details JSONB NOT NULL DEFAULT '{}',
      ADD COLUMN IF NOT EXISTS stock_quantity INTEGER CHECK (stock_quantity >= 0)`);
    await client.query('LOCK TABLE products IN EXCLUSIVE MODE');
    await client.query(`INSERT INTO catalog_migrations (name, previous_products)
      SELECT $1, COALESCE(jsonb_agg(to_jsonb(p)), '[]'::jsonb) FROM products p`, [MIGRATION]);
    await client.query('DELETE FROM products');
    for (const product of catalog) {
      const columns = Object.keys(product);
      const values = columns.map(key => ['skills', 'details'].includes(key) ? JSON.stringify(product[key]) : product[key]);
      await client.query(`INSERT INTO products (${columns.join(', ')}) VALUES (${columns.map((_, i) => `$${i + 1}`).join(', ')})`, values);
    }
    await client.query('COMMIT');
    return true;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

module.exports = { migrateCatalog, MIGRATION };
