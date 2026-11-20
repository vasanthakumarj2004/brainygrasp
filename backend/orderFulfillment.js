'use strict';

const pool = require('./db');
const { deleteCache, CACHE_KEYS } = require('./redisClient');
const { createDeliveryTracking } = require('./deliveryTracking');
const { processShipment } = require('./shippingJobs');
const { createTrackingReconciliation } = require('./trackingReconciliation');
const shippingClient = require('./shiprocketService');

async function invalidateOrderCache(userId) {
  await Promise.all([
    deleteCache(CACHE_KEYS.USER_CART(userId)).catch(() => {}),
    deleteCache(CACHE_KEYS.USER_ORDERS(userId)).catch(() => {}),
  ]);
}
const tracking = createDeliveryTracking({ pool, invalidate: invalidateOrderCache });
const reconcileTracking = createTrackingReconciliation({ pool, client: shippingClient, tracking,
  onError: () => console.error('Courier tracking refresh will retry.') });
let ticking = false;
async function tick() {
  if (ticking) return;
  ticking = true;
  try {
    const events = await pool.query("SELECT id FROM delivery_events WHERE state='pending' AND next_attempt_at<=NOW() ORDER BY received_at LIMIT 20");
    for (const event of events.rows) {
      try { await tracking.processEvent(event.id); } catch { console.error('Delivery event processing will retry.'); }
    }
    if (process.env.SHIPROCKET_ENABLED === 'true') {
      const jobs = await pool.query("SELECT order_id FROM shipping_jobs WHERE state IN ('queued','retry','processing') AND next_attempt_at<=NOW() ORDER BY updated_at LIMIT 5");
      for (const job of jobs.rows) {
        try { await processShipment(job.order_id); } catch (err) { if (err.code !== 'busy') console.error('Shipment processing paused:', err.code || 'database'); }
      }
      await reconcileTracking();
    }
  } catch { console.error('Shipping worker could not read its queue; it will retry.'); }
  finally { ticking = false; }
}
function startShippingWorker() {
  // Persisted jobs survive restarts. Only confirmed, prepared orders are queued.
  const timer = setInterval(() => { void tick(); }, 15000);
  timer.unref(); void tick(); return timer;
}
function afterConfirmation(order) {
  // The durable job was inserted inside the confirmation transaction.
  void invalidateOrderCache(order.user_id);
}
module.exports = { afterConfirmation, invalidateOrderCache, startShippingWorker, tracking };
