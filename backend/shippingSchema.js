'use strict';

async function migrateShipping(db) {
  await db.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS shipping_weight_g INTEGER,
    ADD COLUMN IF NOT EXISTS shipping_length_cm DOUBLE PRECISION,
    ADD COLUMN IF NOT EXISTS shipping_breadth_cm DOUBLE PRECISION,
    ADD COLUMN IF NOT EXISTS shipping_height_cm DOUBLE PRECISION`);
  await db.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS shipment_id VARCHAR(100),
    ADD COLUMN IF NOT EXISTS shipping_snapshot JSONB,
    ADD COLUMN IF NOT EXISTS awb_number VARCHAR(100), ADD COLUMN IF NOT EXISTS courier_name VARCHAR(100),
    ADD COLUMN IF NOT EXISTS tracking_status VARCHAR(100), ADD COLUMN IF NOT EXISTS estimated_delivery DATE,
    ADD COLUMN IF NOT EXISTS tracking_event_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS tracking_next_check_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    ADD COLUMN IF NOT EXISTS delivery_date DATE`);
  // Older deployments created this column with a smaller limit.
  await db.query('ALTER TABLE orders ALTER COLUMN tracking_status TYPE VARCHAR(100)');
  await db.query(`CREATE TABLE IF NOT EXISTS shipping_jobs (
    order_id INTEGER PRIMARY KEY REFERENCES orders(id) ON DELETE CASCADE,
    state TEXT NOT NULL DEFAULT 'awaiting_parcel', phase TEXT NOT NULL DEFAULT 'new',
    details JSONB NOT NULL DEFAULT '{}', attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), last_error TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await db.query(`CREATE TABLE IF NOT EXISTS delivery_events (
    id VARCHAR(64) PRIMARY KEY, payload JSONB NOT NULL, state TEXT NOT NULL DEFAULT 'pending',
    attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), processed_at TIMESTAMPTZ
  )`);
  await db.query('CREATE INDEX IF NOT EXISTS ix_shipping_due ON shipping_jobs(state, next_attempt_at)');
  await db.query('CREATE INDEX IF NOT EXISTS ix_delivery_due ON delivery_events(state, next_attempt_at)');
  await db.query('CREATE INDEX IF NOT EXISTS ix_order_awb ON orders(awb_number)');
  await db.query(`CREATE INDEX IF NOT EXISTS ix_order_tracking_due ON orders(tracking_next_check_at)
    WHERE awb_number IS NOT NULL AND status IN ('Placed','Paid','Confirmed','Shipped','Out for Delivery')`);
}
module.exports = { migrateShipping };
