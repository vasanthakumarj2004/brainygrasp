-- Run against the intended database with ON_ERROR_STOP enabled in psql.
-- Read-only: does not migrate, cancel, refund or mark any order paid.
-- Missing columns in later queries indicate the migration must run first.
BEGIN READ ONLY;
SET LOCAL statement_timeout = '10s';

WITH required(column_name) AS (
  VALUES ('checkout_key'), ('checkout_fingerprint'), ('razorpay_order_id'),
    ('razorpay_key_id'), ('amount_paise'), ('currency'), ('payment_verified_at'),
    ('payment_id'), ('shipping'), ('discount'), ('promo_code'), ('shipping_snapshot')
)
SELECT 'missing_order_column' AS check_name, r.column_name
FROM required r LEFT JOIN information_schema.columns c
  ON c.table_schema = 'public' AND c.table_name = 'orders' AND c.column_name = r.column_name
WHERE c.column_name IS NULL;

WITH required(index_name) AS (
  VALUES ('uq_checkout_request'), ('uq_razorpay_order'), ('uq_verified_payment')
)
SELECT 'payment_index' AS check_name, r.index_name,
  COALESCE(i.indisunique AND i.indisvalid, false) AS valid_unique_index
FROM required r LEFT JOIN pg_class c ON c.oid = to_regclass('public.' || r.index_name)
LEFT JOIN pg_index i ON i.indexrelid = c.oid;

SELECT 'shipping_queue_exists' AS check_name,
  to_regclass('public.shipping_jobs') IS NOT NULL AS present;

SELECT 'unverified_online_orders' AS check_name, status,
  CASE WHEN razorpay_key_id LIKE 'rzp_test_%' THEN 'test'
       WHEN razorpay_key_id LIKE 'rzp_live_%' THEN 'live' ELSE 'unknown' END AS mode,
  count(*) AS order_count
FROM orders WHERE payment_method = 'razorpay' AND payment_verified_at IS NULL
GROUP BY status, mode ORDER BY status, mode;

SELECT 'incomplete_verified_online_orders' AS check_name, count(*) AS order_count
FROM orders WHERE payment_method = 'razorpay' AND payment_verified_at IS NOT NULL
  AND (payment_id IS NULL OR razorpay_order_id IS NULL OR amount_paise IS NULL
    OR razorpay_key_id IS NULL OR currency IS DISTINCT FROM 'INR');

ROLLBACK;
