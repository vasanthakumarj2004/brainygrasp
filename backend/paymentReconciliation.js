'use strict';
const { validateConfig } = require('./paymentService');

function createPaymentReconciliation({ pool, service, env = process.env, onError = () => {} }) {
  let running = false;
  return async function tick() {
    if (running) return;
    try { validateConfig(env); } catch { return; }
    running = true;
    try {
      // Claim durably before network I/O; restarts and other workers respect
      // this deadline. Keep checking old cancellations for late captures too.
      const { rows } = await pool.query(`WITH due AS (
        SELECT id FROM orders WHERE payment_method='razorpay'
          AND razorpay_key_id=$1 AND checkout_key IS NOT NULL
          AND status IN ('Payment Pending','Cancelled')
          AND payment_verified_at IS NULL AND payment_review IS NULL
          AND payment_next_check_at<=NOW()
        ORDER BY payment_next_check_at,id LIMIT 5 FOR UPDATE SKIP LOCKED
      ) UPDATE orders o SET payment_next_check_at=NOW()+INTERVAL '15 minutes'
        FROM due WHERE o.id=due.id RETURNING o.id,o.user_id`, [env.RAZORPAY_KEY_ID]);
      for (const order of rows) {
        try { await service.reconcile(order.user_id, order.id); }
        catch (err) { onError(err); }
      }
    } catch (err) { onError(err); }
    finally { running = false; }
  };
}
function startPaymentWorker(options) {
  const tick = createPaymentReconciliation(options);
  const timer = setInterval(() => { void tick(); }, 15000);
  timer.unref(); void tick(); return timer;
}
module.exports = { createPaymentReconciliation, startPaymentWorker };
