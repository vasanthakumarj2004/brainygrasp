'use strict';

// Additive migration. Legacy orders are not retroactively treated as verified.
async function migratePayments(db) {
  await db.query(`ALTER TABLE orders
    ADD COLUMN IF NOT EXISTS payment_id VARCHAR(100),
    ADD COLUMN IF NOT EXISTS checkout_key UUID,
    ADD COLUMN IF NOT EXISTS checkout_fingerprint VARCHAR(64),
    ADD COLUMN IF NOT EXISTS razorpay_order_id VARCHAR(100),
    ADD COLUMN IF NOT EXISTS razorpay_key_id VARCHAR(100),
    ADD COLUMN IF NOT EXISTS amount_paise INTEGER,
    ADD COLUMN IF NOT EXISTS currency VARCHAR(3) DEFAULT 'INR',
    ADD COLUMN IF NOT EXISTS payment_verified_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS payment_review JSONB,
    ADD COLUMN IF NOT EXISTS payment_next_check_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    ADD COLUMN IF NOT EXISTS shipping INTEGER DEFAULT 0,
    ADD COLUMN IF NOT EXISTS discount INTEGER DEFAULT 0,
    ADD COLUMN IF NOT EXISTS promo_code VARCHAR(30)`);
  await db.query('CREATE UNIQUE INDEX IF NOT EXISTS uq_checkout_request ON orders(user_id, checkout_key)');
  await db.query(`CREATE INDEX IF NOT EXISTS ix_payment_due ON orders(payment_next_check_at)
    WHERE payment_method='razorpay' AND payment_verified_at IS NULL AND payment_review IS NULL`);
  await db.query('CREATE UNIQUE INDEX IF NOT EXISTS uq_razorpay_order ON orders(razorpay_order_id)');
  // Applies to the new bound flow, without failing on unverified legacy duplicates.
  await db.query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_verified_payment ON orders(payment_id)
    WHERE razorpay_order_id IS NOT NULL AND payment_id IS NOT NULL`);
}

module.exports = { migratePayments };
