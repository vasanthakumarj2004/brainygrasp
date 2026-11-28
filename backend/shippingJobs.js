'use strict';

const pool = require('./db');
const client = require('./shiprocketService');
const { ShippingError, shippingConfig, eligibleBooking, parcelDetails, orderAmounts } = require('./shippingPolicy');
const { advanceBooking } = require('./shipmentBooking');
const { deleteCache, CACHE_KEYS } = require('./redisClient');

async function lockOrder(id, action) {
  const db = await pool.connect();
  let locked = false;
  try {
    const { rows } = await db.query('SELECT pg_try_advisory_lock(71346, $1) AS locked', [id]);
    locked = rows[0].locked;
    if (!locked) throw new ShippingError('busy', 'Shipment processing is already in progress.');
    return await action(db);
  } finally {
    // Destroy a broken connection rather than returning a leaked session lock.
    let broken = false;
    if (locked) try { await db.query('SELECT pg_advisory_unlock(71346, $1)', [id]); } catch { broken = true; }
    db.release(broken);
  }
}
async function approveShipment(id, parcel) {
  const config = shippingConfig(process.env);
  return lockOrder(id, async db => {
    const { rows } = await db.query('SELECT * FROM orders WHERE id = $1', [id]);
    const order = rows[0];
    if (!order) throw new ShippingError('order_status', 'Order not found.', { status: 404 });
    orderAmounts(order);
    await db.query('INSERT INTO shipping_jobs(order_id) VALUES ($1) ON CONFLICT (order_id) DO NOTHING', [id]);
    const found = await db.query('SELECT * FROM shipping_jobs WHERE order_id = $1', [id]);
    const job = found.rows[0];
    if (job.state === 'completed') return job;
    eligibleBooking(order, job.details);
    if (!job.details.parcel) {
      if (order.shipment_id || order.awb_number) throw new ShippingError('legacy_shipment', 'Reconcile this existing shipment in Shiprocket before using the new booking flow.');
      job.details = { parcel: parcelDetails(parcel || order.shipping_snapshot?.parcel), config, reference: `${config.prefix}${String(id).padStart(10, '0')}` };
    } else if (job.phase === 'new' && !job.details.remoteOrderId) {
      // Queue / resume is an explicit admin approval. Before any Shiprocket
      // order-creation attempt, it is safe to adopt the current settings. A
      // pending/known remote order keeps its original channel and reference so
      // retries can reconcile it without creating a duplicate.
      const previous = job.details.config || {};
      const changed = ['channelId', 'pickup', 'postcode', 'prefix']
        .some(key => previous[key] !== config[key]);
      if (changed) {
        job.details.config = config;
        job.details.reference = `${config.prefix}${String(id).padStart(10, '0')}`;
        delete job.details.courierId;
        delete job.details.courierName;
      }
    }
    // A resume preserves the approved parcel, reference and pending operation.
    await db.query(`UPDATE shipping_jobs SET details=$2, state='queued', attempts=0,
      next_attempt_at=NOW(), last_error=NULL, updated_at=NOW() WHERE order_id=$1`, [id, JSON.stringify(job.details)]);
    return { ...job, state: 'queued' };
  });
}

async function saveStage(db, job) {
  await db.query('BEGIN');
  try {
    await db.query(`UPDATE shipping_jobs SET phase=$2, details=$3,
      state=$4, updated_at=NOW() WHERE order_id=$1`, [job.order_id, job.phase, JSON.stringify(job.details), job.phase === 'complete' ? 'completed' : 'processing']);
    await db.query(`UPDATE orders SET shipment_id=COALESCE($2,shipment_id), awb_number=COALESCE($3,awb_number),
      courier_name=COALESCE(NULLIF($4,''),courier_name) WHERE id=$1`,
    [job.order_id, job.details.shipmentId || null, job.details.awb || null, job.details.courierName || null]);
    await db.query('COMMIT');
  } catch (err) { await db.query('ROLLBACK'); throw err; }
}

async function processShipment(id) {
  const config = shippingConfig(process.env);
  return lockOrder(id, async db => {
    const result = await db.query('SELECT * FROM shipping_jobs WHERE order_id=$1', [id]);
    const job = result.rows[0];
    if (!job || !['queued','retry','processing'].includes(job.state)) return;
    const { rows } = await db.query('SELECT * FROM orders WHERE id=$1', [id]);
    const order = rows[0];
    try {
      const address = order.shipping_snapshot?.address || (await db.query('SELECT * FROM addresses WHERE id=$1 AND user_id=$2', [order.address_id, order.user_id])).rows[0];
      const user = await db.query('SELECT name,email,phone FROM users WHERE id=$1', [order.user_id]);
      if (!address || !user.rows[0]) throw new ShippingError('address', 'Delivery information is unavailable.');
      await advanceBooking({ job, order, address, user: user.rows[0], config, client, save: j => saveStage(db,j) });
    } catch (err) {
      const attempt = job.attempts + 1;
      const retry = err instanceof ShippingError && err.retryable && attempt < 6;
      // Unexpected/database failures may have interrupted an external effect.
      // Leave its persisted pending phase intact for read-only reconciliation.
      await db.query(`UPDATE shipping_jobs SET state=$2, attempts=$3, last_error=$4,
        next_attempt_at=NOW()+($5 * INTERVAL '1 second'), updated_at=NOW() WHERE order_id=$1`,
      [id, retry ? 'retry' : 'needs_review', attempt, err instanceof ShippingError ? err.message : 'Processing interrupted. Check the existing remote shipment before resuming.', Math.min(3600, 30 * 2 ** attempt)]);
    }
    await deleteCache(CACHE_KEYS.USER_ORDERS(order.user_id)).catch(() => {});
  });
}
module.exports = { approveShipment, processShipment };
