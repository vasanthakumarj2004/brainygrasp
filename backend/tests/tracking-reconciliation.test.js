'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createTrackingReconciliation } = require('../trackingReconciliation');
const { createDeliveryTracking } = require('../deliveryTracking');
const { createShiprocketClient } = require('../shiprocketService');
const { environment } = require('./helpers/shippingFixture');

function fixture(initial = [{ id: 1, status: 'Shipped' }]) {
  let now = 0;
  const orders = initial.map(o => ({ user_id: 9, awb_number: `AWB${o.id}`, tracking_next_check_at: 0, ...o }));
  const invalidated = [], calls = [], errors = [];
  const db = { release() {}, async query(sql, args = []) {
    if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(sql)) return { rows: [] };
    if (sql.startsWith('WITH due AS')) {
      assert.match(sql, /FOR UPDATE SKIP LOCKED/);
      assert.match(sql, /LIMIT 5/);
      assert.match(sql, /tracking_next_check_at <= NOW\(\)/);
      assert.match(sql, /INTERVAL '15 minutes'/);
      const states = sql.match(/status IN \(([^)]+)\)/)[1].match(/'[^']+'/g).map(s => s.slice(1, -1));
      const due = orders.filter(o => o.awb_number && states.includes(o.status) && o.tracking_next_check_at <= now)
        .sort((a, b) => a.tracking_next_check_at - b.tracking_next_check_at || a.id - b.id).slice(0, 5);
      for (const order of due) order.tracking_next_check_at = now + 15 * 60000;
      return { rows: due.map(o => ({ id: o.id, awb_number: o.awb_number })) };
    }
    if (sql.startsWith('SELECT * FROM orders WHERE awb_number')) return { rows: orders.filter(o => o.awb_number === args[0]) };
    if (sql.startsWith('UPDATE orders SET status')) {
      const order = orders.find(o => o.id === args[0]);
      Object.assign(order, { status: args[1], tracking_status: args[2], estimated_delivery: args[3] || order.estimated_delivery,
        courier_name: args[4] || order.courier_name, tracking_event_at: args[5] || order.tracking_event_at,
        delivery_date: order.delivery_date || args[6] });
      return { rows: [order] };
    }
    throw Error('Unexpected query: ' + sql);
  } };
  const pool = { query: db.query, connect: async () => db };
  const tracking = createDeliveryTracking({ pool, invalidate: async id => invalidated.push(id) });
  let provider = async awb => ({ awb, srStatus: 'DELIVERED', eventAt: '2026-11-20T10:00:00Z' });
  const client = { async getTracking(awb) { calls.push(awb); return provider(awb); } };
  const newWorker = () => createTrackingReconciliation({ pool, client, tracking, onError: err => errors.push(err) });
  return { orders, calls, invalidated, errors, newWorker, run: newWorker(), advance: ms => { now += ms; }, respond: fn => { provider = fn; } };
}

test('a missed final webhook is recovered and terminal shipments stop polling', async () => {
  const f = fixture();
  await f.run();
  assert.equal(f.orders[0].status, 'Delivered');
  assert.equal(f.orders[0].tracking_status, 'DELIVERED');
  assert.equal(f.orders[0].delivery_date, '2026-11-20');
  assert.deepEqual(f.invalidated, [9]);
  f.advance(60 * 60000); await f.run();
  assert.deepEqual(f.calls, ['AWB1']);
});

function trackingAdapter(response) {
  return createShiprocketClient({ env: environment, fetchImpl: async url => ({ ok: true,
    json: async () => url.endsWith('/auth/login') ? { token: 'fixture' } : response }) });
}

test('real tracking response shape saves the delivery date when the final webhook is missed', async () => {
  const f = fixture([{ id: 1, status: 'Shipped', tracking_event_at: '2026-11-19T12:00:00Z' }]);
  const client = trackingAdapter({ tracking_data: { shipment_status: 7,
    shipment_track: [{ current_status: 'Delivered', delivered_date: '2026-11-20 00:15:00',
      updated_at: '2026-11-21 10:00:00', edd: '2026-11-20 23:59:00' }],
    shipment_track_activities: [{ date: '2026-11-20 00:16:00', 'sr-status': '7' }] } });
  f.respond(awb => client.getTracking(awb)); await f.run();
  assert.equal(f.orders[0].status, 'Delivered');
  assert.equal(f.orders[0].delivery_date, '2026-11-20');
  assert.equal(f.orders[0].tracking_event_at, '2026-11-19T18:45:00.000Z');
  assert.equal(f.orders[0].estimated_delivery, '2026-11-20');
});

test('polling recovers a missed exception from matching scan dates and ignores stale snapshots', async () => {
  const f = fixture([{ id: 1, status: 'Shipped', tracking_status: 'IN TRANSIT', tracking_event_at: '2026-11-20T04:30:00Z' }]);
  const response = { tracking_data: { shipment_status: 21,
    shipment_track: [{ current_status: 'Undelivered' }], shipment_track_activities: [
      { date: '2026-11-21 12:00:00', 'sr-status': '18', 'sr-status-label': 'IN TRANSIT' },
      { date: '2026-11-20 11:00:00', 'sr-status': '21' },
      { date: '2026-11-20 09:00:00', 'sr-status-label': 'UNDELIVERED' }
    ] } };
  const client = trackingAdapter(response);
  f.respond(awb => client.getTracking(awb)); await f.run();
  assert.equal(f.orders[0].tracking_status, 'Undelivered');
  assert.equal(f.orders[0].tracking_event_at, '2026-11-20T05:30:00.000Z');
  assert.equal(f.orders[0].status, 'Shipped');
  // A later unrelated activity cannot make an older IN TRANSIT snapshot new.
  response.tracking_data.shipment_status = 18;
  response.tracking_data.shipment_track[0].current_status = 'IN TRANSIT';
  response.tracking_data.shipment_track_activities = [
    { date: '2026-11-20 09:00:00', 'sr-status': '18' },
    { date: '2026-11-21 12:00:00', 'sr-status': '21', 'sr-status-label': 'UNDELIVERED' }
  ];
  f.advance(15 * 60000); await f.run();
  assert.equal(f.orders[0].tracking_status, 'Undelivered');
  assert.equal(f.orders[0].tracking_event_at, '2026-11-20T05:30:00.000Z');
});

test('tracking timestamp fallbacks reject invalid dates and never borrow another status scan', async () => {
  const response = { tracking_data: { shipment_status: 7, shipment_track: [{ current_status: 'Delivered', delivered_date: '0000-00-00 00:00:00' }],
    shipment_track_activities: [
      { date: '2026-11-20 11:00:00', 'sr-status-label': 'DELIVERED' },
      { date: '2026-02-30 11:00:00', 'sr-status': '7' },
      { date: '2026-11-21 12:00:00', 'sr-status-label': 'IN TRANSIT' }
    ] } };
  const client = trackingAdapter(response);
  assert.equal((await client.getTracking('AWB1')).eventAt, '2026-11-20T05:30:00.000Z');
  response.tracking_data.shipment_track_activities = [{ date: '2026-11-21 12:00:00', 'sr-status': '18' }];
  assert.equal((await client.getTracking('AWB1')).eventAt, null);
  response.tracking_data.shipment_track[0].updated_at = '2026-11-20T06:00:00Z';
  assert.equal((await client.getTracking('AWB1')).eventAt, '2026-11-20T06:00:00.000Z');
});

test('failed tracking reads retry after the persisted delay without starving other orders', async () => {
  const f = fixture([{ id: 1, status: 'Shipped' }, { id: 2, status: 'Confirmed' }]);
  f.respond(async awb => { if (awb === 'AWB1') throw Error('Offline'); return { awb, srStatus: 'DELIVERED' }; });
  await f.run();
  assert.equal(f.errors.length, 1);
  assert.equal(f.orders[0].status, 'Shipped');
  assert.equal(f.orders[1].status, 'Delivered');
  const restarted = f.newWorker();
  await restarted(); assert.equal(f.calls.length, 2);
  f.advance(15 * 60000);
  f.respond(async awb => ({ awb, srStatus: 'OUT FOR DELIVERY' }));
  await restarted();
  assert.equal(f.orders[0].status, 'Out for Delivery');
  assert.deepEqual(f.calls, ['AWB1', 'AWB2', 'AWB1']);
});

test('concurrent workers claim separate batches and skip unpaid, terminal and unassigned orders', async () => {
  const f = fixture([
    ...Array.from({ length: 7 }, (_, i) => ({ id: i + 1, status: 'Shipped' })),
    ...['Payment Pending', 'Delivered', 'Cancelled', 'RTO', 'Lost', 'Damaged', 'Destroyed', 'Returned'].map((status, i) => ({ id: 20 + i, status })),
    { id: 30, status: 'Paid', awb_number: null }, { id: 31, status: 'Confirmed', awb_number: '' }
  ]);
  await Promise.all([f.run(), f.newWorker()()]);
  assert.equal(f.calls.length, 7);
  assert.equal(new Set(f.calls).size, 7);
  assert.ok(f.calls.every(awb => /^AWB[1-7]$/.test(awb)));
});

test('older polling results cannot overwrite a newer courier event', async () => {
  const f = fixture([{ id: 1, status: 'Out for Delivery', tracking_status: 'OUT FOR DELIVERY', tracking_event_at: '2026-11-20T11:00:00Z' }]);
  f.respond(async awb => ({ awb, srStatus: 'IN TRANSIT', eventAt: '2026-11-20T10:00:00Z' }));
  await f.run();
  assert.equal(f.orders[0].status, 'Out for Delivery');
  assert.equal(f.orders[0].tracking_status, 'OUT FOR DELIVERY');
});

test('shipping worker runs reconciliation only when enabled and does not overlap ticks', async () => {
  for (const enabled of [false, true]) {
    let timer, reconciliations = 0, release;
    const pending = new Promise(resolve => { release = resolve; });
    const dependencies = {
      './db': { query: async () => ({ rows: [] }) },
      './redisClient': {}, './shiprocketService': {}, './shippingJobs': {},
      './deliveryTracking': { createDeliveryTracking: () => ({}) },
      './trackingReconciliation': { createTrackingReconciliation: () => async () => { reconciliations++; await pending; } }
    };
    const module = { exports: {} };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../orderFulfillment.js'), 'utf8'), {
      module, require: name => dependencies[name], console, process: { env: { SHIPROCKET_ENABLED: String(enabled) } },
      setInterval: fn => { timer = fn; return { unref() {} }; }
    });
    module.exports.startShippingWorker();
    await new Promise(resolve => setImmediate(resolve));
    timer(); await new Promise(resolve => setImmediate(resolve));
    assert.equal(reconciliations, enabled ? 1 : 0);
    release(); await new Promise(resolve => setImmediate(resolve));
  }
});
