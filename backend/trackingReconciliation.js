'use strict';

// Webhooks are the fast path; polling repairs missed events, including delivery.
// Claim in one statement so multiple workers do not poll the same order. The
// persisted deadline also releases abandoned claims after a process restart.
function createTrackingReconciliation({ pool, client, tracking, onError = () => {} }) {
  return async function reconcile() {
    const { rows } = await pool.query(`WITH due AS (
      SELECT id FROM orders
      WHERE awb_number IS NOT NULL AND awb_number <> ''
        AND status IN ('Placed','Paid','Confirmed','Shipped','Out for Delivery')
        AND tracking_next_check_at <= NOW()
      ORDER BY tracking_next_check_at, id LIMIT 5 FOR UPDATE SKIP LOCKED
    )
    UPDATE orders o SET tracking_next_check_at=NOW()+INTERVAL '15 minutes'
    FROM due WHERE o.id=due.id RETURNING o.id, o.awb_number`);
    for (const order of rows) {
      try {
        const snapshot = await client.getTracking(order.awb_number);
        await tracking.refresh(order.id, snapshot);
      } catch (err) {
        // Keep retrying active shipments; one failure must not starve the batch.
        // The claim deadline bounds retries even when the provider is offline.
        onError(err);
      }
    }
  };
}

module.exports = { createTrackingReconciliation };
