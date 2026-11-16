'use strict';

const crypto = require('crypto');
const { ShippingError, mapShiprocketStatus, nextTrackingStatus, eventTime } = require('./shippingPolicy');

function validWebhookKey(provided, secret) {
  if (typeof secret !== 'string' || secret.length < 32 || typeof provided !== 'string') return false;
  const a = Buffer.from(provided), b = Buffer.from(secret);
  return a.length === b.length && crypto.timingSafeEqual(a,b);
}
function trackingEvent(payload) {
  const awb = String(payload?.awb || payload?.awb_code || '');
  const srStatus = payload?.current_status || payload?.srStatus || payload?.status;
  const courierName = payload?.courier_name || payload?.courierName || '';
  if (!/^[a-zA-Z0-9-]{1,100}$/.test(awb) || typeof srStatus !== 'string' || !srStatus.trim() || srStatus.length > 100 ||
    typeof courierName !== 'string' || courierName.length > 100) throw new ShippingError('webhook_payload', 'Invalid tracking payload.', { status: 400 });
  const etd = payload.etd || payload.estimated_delivery_date || payload.estimatedDelivery;
  const date = typeof etd === 'string' && /^\d{4}-\d{2}-\d{2}/.test(etd) ? etd.slice(0,10) : null;
  return { awb, srStatus: srStatus.trim(), courierName, estimatedDelivery: date && Number.isFinite(Date.parse(date)) ? date : null,
    eventAt: eventTime(payload.current_timestamp || payload.eventAt) };
}

function createDeliveryTracking({ pool, invalidate = async () => {} }) {
  async function receive(payload) {
    const event = trackingEvent(payload);
    const id = crypto.createHash('sha256').update(JSON.stringify(event)).digest('hex');
    // Commit the inbox entry before acknowledging delivery, including unknown AWBs.
    await pool.query('INSERT INTO delivery_events(id,payload) VALUES ($1,$2) ON CONFLICT (id) DO NOTHING', [id, JSON.stringify(event)]);
    return id;
  }
  async function apply(db, event, expectedOrderId) {
    const { rows } = await db.query('SELECT * FROM orders WHERE awb_number=$1 FOR UPDATE', [event.awb]);
    if (rows.length !== 1 || (expectedOrderId && rows[0].id !== expectedOrderId)) throw new ShippingError('unknown_awb', 'Tracking order has not been matched yet.', { retryable: true });
    const order = rows[0];
    if (event.eventAt && order.tracking_event_at && new Date(event.eventAt) <= new Date(order.tracking_event_at)) return order;
    const status = nextTrackingStatus(order.status, mapShiprocketStatus(event.srStatus));
    if (!status) return order;
    const result = await db.query(`UPDATE orders SET status=$2, tracking_status=$3,
      estimated_delivery=COALESCE($4,estimated_delivery), courier_name=COALESCE(NULLIF($5,''),courier_name),
      tracking_event_at=COALESCE($6,tracking_event_at) WHERE id=$1 RETURNING *`,
    [order.id, status, event.srStatus, event.estimatedDelivery, event.courierName, event.eventAt]);
    return result.rows[0];
  }
  async function refresh(id, payload) {
    const event = trackingEvent(payload);
    const db = await pool.connect(); let order;
    try { await db.query('BEGIN'); order = await apply(db,event,id); await db.query('COMMIT'); }
    catch (err) { await db.query('ROLLBACK'); throw err; }
    finally { db.release(); }
    await invalidate(order.user_id); return order;
  }
  async function processEvent(id) {
    const db = await pool.connect(); let order;
    try {
      await db.query('BEGIN');
      const found = await db.query("SELECT * FROM delivery_events WHERE id=$1 AND state='pending' FOR UPDATE SKIP LOCKED", [id]);
      const entry = found.rows[0];
      if (!entry) { await db.query('COMMIT'); return; }
      try { order = await apply(db,entry.payload); }
      catch (err) {
        if (!(err instanceof ShippingError)) throw err;
        await db.query(`UPDATE delivery_events SET attempts=attempts+1,
          state=CASE WHEN attempts>=19 THEN 'needs_review' ELSE 'pending' END,
          next_attempt_at=NOW()+INTERVAL '15 minutes' WHERE id=$1`, [id]);
        await db.query('COMMIT'); return;
      }
      await db.query("UPDATE delivery_events SET state='processed', processed_at=NOW() WHERE id=$1", [id]);
      await db.query('COMMIT');
    } catch (err) { await db.query('ROLLBACK'); throw err; }
    finally { db.release(); }
    if (order) await invalidate(order.user_id);
  }
  return { receive, refresh, processEvent };
}
module.exports = { createDeliveryTracking, trackingEvent, validWebhookKey };
