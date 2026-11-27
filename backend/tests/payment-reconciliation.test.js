'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createPaymentReconciliation } = require('../paymentReconciliation');
const { fixture, request, env } = require('./helpers/paymentFixture');

test('worker recovers missed payment with shipping disabled, respects claim deadline and stops after confirmation', async () => {
  const f = fixture(); const o = await f.service.create(1, request());
  let due = true, now = 0, deadline = 0; const errors = [];
  const pool = { async query(sql, args) {
    assert.match(sql, /FOR UPDATE SKIP LOCKED/); assert.match(sql, /LIMIT 5/);
    assert.match(sql, /payment_review IS NULL/); assert.match(sql, /payment_verified_at IS NULL/);
    assert.match(sql, /'Payment Pending','Cancelled'/); assert.match(sql, /INTERVAL '15 minutes'/);
    assert.equal(args[0], env.RAZORPAY_KEY_ID);
    if (!due || now < deadline || f.state.orders[0].payment_verified_at) return { rows: [] };
    deadline = now + 900000; return { rows: [{ id: o.id, user_id: 1 }] };
  } };
  const makeWorker = () => createPaymentReconciliation({ pool, service: f.service, env: { ...env, SHIPROCKET_ENABLED: 'false' }, onError: e => errors.push(e) });
  f.calls.failFetch = true; await makeWorker()(); assert.equal(errors.length, 1);
  f.calls.failFetch = false;
  f.setPayments([{ id: 'pay_fixture', order_id: o.orderId, amount: o.amount, currency: 'INR', status: 'captured', captured: true }]);
  await makeWorker()(); assert.equal(f.state.orders[0].status, 'Payment Pending');
  now = 900000; await Promise.all([makeWorker()(), makeWorker()()]);
  assert.equal(f.state.orders[0].status, 'Paid'); assert.equal(f.state.cartWrites, 1); assert.equal(f.state.jobs.length, 1);
  now += 900000; await makeWorker()(); assert.equal(f.state.cartWrites, 1);
});

test('worker isolates failures, skips unavailable credentials and does not overlap ticks', async () => {
  let release, reads = 0; const called = [], errors = [];
  const pool = { async query() { reads++; return { rows: [{ id: 1, user_id: 7 }, { id: 2, user_id: 8 }] }; } };
  const service = { async reconcile(uid, id) { called.push([uid,id]); if (id === 1) throw Error('Offline'); await new Promise(resolve => { release = resolve; }); } };
  const worker = createPaymentReconciliation({ pool, service, env, onError: e => errors.push(e) });
  const first = worker(); await new Promise(resolve => setImmediate(resolve));
  await worker(); assert.equal(reads, 1); assert.equal(errors.length, 1);
  release(); await first; assert.deepEqual(called, [[7,1],[8,2]]);
  await createPaymentReconciliation({ pool, service, env: {} })(); assert.equal(reads, 1);
});
