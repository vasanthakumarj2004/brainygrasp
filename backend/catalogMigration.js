'use strict';

const catalog = require('./catalog-products.json');
const MIGRATION = '2026-11-15-sentence-safari-mag-clash';
const MAG_CLASH_PRICE_MIGRATION = '2026-11-28-mag-clash-price-1-inr';

async function migrateMagClashPrice(client) {
  const applied = await client.query('SELECT name FROM catalog_migrations WHERE name = $1', [MAG_CLASH_PRICE_MIGRATION]);
  if (applied.rows.length) return false;

  const previous = await client.query(
    "SELECT to_jsonb(p) AS product FROM products p WHERE upper(p.name) = 'MAG CLASH' FOR UPDATE"
  );
  if (previous.rows.length) {
    await client.query(
      "UPDATE products SET price = $1, save = $2 WHERE upper(name) = 'MAG CLASH'",
      [1, '99.8%']
    );
  }
  await client.query(
    'INSERT INTO catalog_migrations (name, previous_products) VALUES ($1, $2::jsonb)',
    [MAG_CLASH_PRICE_MIGRATION, JSON.stringify(previous.rows.map(row => row.product))]
  );
  return previous.rows.length > 0;
}

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
    if (applied.rows.length) {
      await migrateMagClashPrice(client);
      await client.query('COMMIT');
      return false;
    }
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
    await migrateMagClashPrice(client);
    await client.query('COMMIT');
    return true;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

module.exports = { migrateCatalog, MIGRATION, MAG_CLASH_PRICE_MIGRATION };
