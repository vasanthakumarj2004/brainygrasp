'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createDeliveryTracking, validWebhookKey } = require('../deliveryTracking');
const { shippingReadiness } = require('../shippingReadiness');
const validation = require('../../frontend/js/customer-validation');
const { environment } = require('./helpers/shippingFixture');

function fixture(initial = {}) {
  let order = { id: 1, user_id: 9, awb_number: 'AWB1', status: 'Shipped', tracking_status: 'IN TRANSIT', ...initial };
  const inbox = new Map();
  let updates = 0;
  const db = { release() {}, async query(sql, args = []) {
    if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(sql)) return { rows: [] };
    if (sql.startsWith('INSERT INTO delivery_events')) {
      if (!inbox.has(args[0])) inbox.set(args[0], { payload: JSON.parse(args[1]), state: 'pending' });
      return { rows: [] };
    }
    if (sql.startsWith('SELECT * FROM delivery_events')) return { rows: inbox.get(args[0])?.state === 'pending' ? [inbox.get(args[0])] : [] };
    if (sql.startsWith('SELECT * FROM orders')) return { rows: [{ ...order }] };
    if (sql.startsWith('UPDATE orders SET status')) {
      updates++;
      order = { ...order, status: args[1], tracking_status: args[2], estimated_delivery: args[3] || order.estimated_delivery,
        courier_name: args[4] || order.courier_name, tracking_event_at: args[5] || order.tracking_event_at,
        delivery_date: order.delivery_date || args[6] };
      return { rows: [{ ...order }] };
    }
    if (sql.startsWith("UPDATE delivery_events SET state='processed'")) { inbox.get(args[0]).state = 'processed'; return { rows: [] }; }
    throw new Error('Unexpected query: ' + sql);
  } };
  const service = createDeliveryTracking({ pool: { query: db.query, connect: async () => db } });
  return { order: () => order, updates: () => updates, async send(status, time = '19 11 2026 10:00:00', extra = {}) {
    const id = await service.receive({ awb: 'AWB1', current_status: status, current_timestamp: time, ...extra });
    await service.processEvent(id);
    assert.equal(inbox.get(id).state, 'processed');
    return id;
  } };
}

test('courier exceptions and future statuses are persisted without inventing delivery stages', async () => {
  for (const status of ['UNDELIVERED', 'DELAYED', 'PICKUP ERROR', 'PICKUP EXCEPTION', 'FUTURE COURIER STATUS']) {
    const f = fixture();
    await f.send(status, undefined, { etd: '2026-11-23', courier_name: 'Courier' });
    assert.equal(f.order().status, 'Shipped');
    assert.equal(f.order().tracking_status, status);
    assert.equal(f.order().estimated_delivery, '2026-11-23');
    assert.equal(f.order().courier_name, 'Courier');
    assert.equal(f.order().tracking_event_at, '2026-11-19T04:30:00.000Z');
  }
});

test('repeated and older courier updates cannot overwrite the latest exception', async () => {
  const f = fixture();
  await f.send('DELAYED'); await f.send('DELAYED');
  await f.send('IN TRANSIT', '18 11 2026 10:00:00');
  assert.equal(f.order().tracking_status, 'DELAYED');
  assert.equal(f.updates(), 1);
  await f.send('OUT FOR DELIVERY', '20 11 2026 10:00:00');
  assert.equal(f.order().status, 'Out for Delivery');
});

test('delivered events record Indian calendar date and terminal orders do not regress', async () => {
  const f = fixture();
  await f.send('DELIVERED', '2026-11-19T20:00:00Z');
  assert.equal(f.order().status, 'Delivered');
  assert.equal(f.order().delivery_date, '2026-11-20');
  await f.send('UNDELIVERED', '2026-11-20T20:00:00Z');
  assert.equal(f.order().tracking_status, 'DELIVERED');
  assert.equal(f.updates(), 1);
});

test('missing timestamps do not invent a delivery date or overwrite an admin date', async () => {
  const f = fixture(); await f.send('DELIVERED', null);
  assert.equal(f.order().delivery_date, null);
  const manual = fixture({ delivery_date: '2026-11-18' }); await manual.send('DELIVERED');
  assert.equal(manual.order().delivery_date, '2026-11-18');
});

test('courier events cannot confirm an unpaid order and loss is not mislabeled as a return', async () => {
  const pending = fixture({ status: 'Payment Pending' }); await pending.send('DELIVERED');
  assert.equal(pending.order().status, 'Payment Pending'); assert.equal(pending.updates(), 0);
  const lost = fixture(); await lost.send('LOST'); assert.equal(lost.order().status, 'Lost');
});

test('shared profile validation normalizes supported formats and enforces storage limits', () => {
  for (const phone of ['9876543210', '+91 98765 43210', '919876543210', '09876543210']) {
    assert.equal(validation.profile({ name: 'Buyer', phone }).phone, '9876543210');
  }
  for (const phone of ['+1 9876543210', '1234567', 'abc', '9'.repeat(21)]) assert.throws(() => validation.profile({ name: 'Buyer', phone }));
  assert.throws(() => validation.profile({ name: 'Buyer', address: 'x'.repeat(256) }));
  assert.throws(() => validation.profile({ name: 'Buyer', gender: 'x'.repeat(21) }));
  assert.throws(() => validation.profile({ name: 'Buyer', country: 'Other', pincode: 'x'.repeat(11) }));
  assert.equal(validation.profile({ name: ' Buyer ', phone: '  ' }).phone, null);
});

test('shipping readiness reports missing settings without exposing secrets or enabling shipping', () => {
  const empty = shippingReadiness({});
  assert.equal(empty.configured, false); assert.equal(empty.enabled, false);
  assert.ok(empty.missing.includes('SHIPROCKET_WEBHOOK_SECRET'));
  const env = { ...environment, FRONTEND_URL: 'https://example.invalid', SHIPROCKET_ENABLED: 'false' };
  const ready = shippingReadiness(env);
  assert.equal(ready.configured, true); assert.equal(ready.enabled, false);
  assert.ok(!JSON.stringify(ready).includes(env.SHIPROCKET_PASSWORD));
  assert.equal(validWebhookKey('replace_with_a_long_placeholder_secret', 'replace_with_a_long_placeholder_secret'), false);
});
