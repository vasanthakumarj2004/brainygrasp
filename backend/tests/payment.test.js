'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { quote, validateAddress } = require('../checkoutService');
const { createPaymentService, validSignature, validateConfig } = require('../paymentService');

const { fixture, request, address, env, signature } = require('./helpers/paymentFixture');

test('server quote ignores browser prices/totals and validates promos', async () => {
  const f = fixture();
  const priced = await quote(f.pool, { ...request(), items: [{ id: 1, quantity: 2, price: 1, name: 'Forged' }] });
  assert.equal(priced.total, 900); assert.equal(priced.shipping, 0); assert.equal(priced.items[0].name, 'Catalog Toy');
  await assert.rejects(quote(f.pool, { ...request(), promo_code: '__proto__' }), { status: 400 });
});

test('invalid products, quantities, duplicate lines and IDs are rejected', async () => {
  for (const items of [[], [{ id: 99, quantity: 1 }], [{ id: 1, quantity: -1 }], [{ id: 1, quantity: 1.5 }], [{ id: 1, quantity: 101 }], [{ id: '1 OR 1=1', quantity: 1 }], [{ id: 1, quantity: 1 }, { id: 1, quantity: 1 }]]) {
    await assert.rejects(quote(fixture().pool, { items }), { status: 400 });
  }
  assert.throws(() => validateAddress({ ...address, phone: 'bad' }), { status: 400 });
});

test('pending order stores authoritative price; initialization retries reuse one gateway order', async () => {
  const f = fixture(), input = request();
  const results = await Promise.all([f.service.create(1, input), f.service.create(1, input)]);
  assert.equal(results[0].id, results[1].id); assert.equal(results[0].amount, 90000);
  assert.equal(f.state.orders.length, 1); assert.equal(f.calls.create, 1); assert.equal(f.state.orders[0].status, 'Payment Pending');
  assert.equal(f.state.cartWrites, 0); assert.equal(f.effects.length, 0);
});

test('changed basket with same retry key and another users address are rejected', async () => {
  const f = fixture(), input = request(); await f.service.create(1, input);
  await assert.rejects(f.service.create(1, { ...input, items: [{ id: 1, quantity: 1 }] }), { status: 409 });
  await assert.rejects(f.service.create(2, request()), { status: 400 });
});

test('gateway timeout preserves the pending order for retry', async () => {
  const f = fixture(), input = request(); f.calls.failCreate = true;
  await assert.rejects(f.service.create(1, input));
  assert.equal(f.state.orders.length, 1); assert.equal(f.state.orders[0].razorpay_order_id, undefined);
  f.calls.failCreate = false; await f.service.create(1, input);
  assert.equal(f.state.orders.length, 1); assert.equal(f.state.orders[0].status, 'Payment Pending');
});

test('lost remote creation response is recovered by receipt without creating another gateway order', async () => {
  const f = fixture(), input = request(); f.calls.loseCreateResponse = true;
  await assert.rejects(f.service.create(1, input));
  f.calls.loseCreateResponse = false;
  const result = await f.service.create(1, input);
  assert.equal(f.calls.create, 1); assert.equal(result.orderId, 'order_fixture1'); assert.equal(f.state.orders.length, 1);
});

test('forged signatures and ownership mismatches fail before gateway fetch', async () => {
  const f = fixture(); await f.service.create(1, request());
  await assert.rejects(f.service.verify(2, f.callback()), { status: 404 });
  await assert.rejects(f.service.verify(1, { ...f.callback(), razorpay_signature: '0'.repeat(64) }), { status: 400 });
  await assert.rejects(f.service.verify(1, { ...f.callback(), razorpay_order_id: 'order_other' }), { status: 400 });
  assert.equal(f.calls.fetch, 0);
});

test('amount, currency, order, capture and refund mismatches never confirm', async () => {
  for (const mismatch of [{ amount: 100 }, { currency: 'USD' }, { order_id: 'order_other' }, { captured: false }, { status: 'failed' }, { amount_refunded: 1 }]) {
    const f = fixture(); await f.service.create(1, request()); f.setPayment({ amount: 90000, ...mismatch });
    await assert.rejects(f.service.verify(1, f.callback()));
    assert.equal(f.state.orders[0].status, 'Payment Pending'); assert.equal(f.effects.length, 0);
  }
});

test('authorization remains pending until capture', async () => {
  const f = fixture(); await f.service.create(1, request()); f.setPayment({ amount: 90000, status: 'authorized', captured: false });
  const result = await f.service.verify(1, f.callback());
  assert.equal(result.pending, true); assert.equal(result.paid, false); assert.equal(f.state.cartWrites, 0);
});

test('concurrent callbacks and webhook confirm once with one commission and shipment', async () => {
  const f = fixture(); await f.service.create(1, { ...request(), affiliate_ref: 'TEST' }); f.setPayment({ amount: 90000 });
  // Edits made after payment starts must survive confirmation of its snapshot.
  f.state.cart = [{ id: 1, quantity: 3 }, { id: 2, quantity: 1 }];
  await Promise.all([f.service.verify(1, f.callback()), f.service.webhook(...f.webhook()), f.service.verify(1, f.callback())]);
  assert.equal(f.state.orders[0].status, 'Paid'); assert.equal(f.state.cartWrites, 1);
  assert.equal(f.state.commissions, 1); assert.equal(f.state.walletCredits, 1); assert.deepEqual(f.effects, [1]);
  assert.deepEqual(f.state.cart, [{ id: 1, quantity: 1 }, { id: 2, quantity: 1 }]);
});

test('online creation uses database quantities and catalog prices, ignoring request cart and amounts', async () => {
  const f = fixture();
  f.state.cart = [{ id: 1, quantity: 3, price: 1 }];
  const order = await f.service.create(1, { ...request(), items: [{ id: 2, quantity: 1, price: 1 }], amount: 1, total: 1 });
  assert.equal(order.items[0].id, 1); assert.equal(order.items[0].quantity, 3);
  assert.equal(order.total, 1350); assert.equal(order.amount, 135000);
});

test('changed quantity cancels the old order and a fresh request creates a new gateway order', async () => {
  const f = fixture(), input = request();
  const old = await f.service.create(1, input);
  f.state.cart[0].quantity = 3;
  const stale = await f.service.status(1, old.id);
  assert.equal(stale.stale, true); assert.equal(stale.resumable, false);
  assert.equal(stale.orderId, undefined); assert.equal(stale.amount, undefined);
  assert.equal(stale.current_cart.total, 1350);
  assert.equal(f.state.orders[0].status, 'Cancelled');
  const fresh = await f.service.create(1, request());
  assert.notEqual(fresh.id, old.id); assert.notEqual(fresh.orderId, old.orderId);
  assert.equal(fresh.amount, 135000); assert.equal(f.calls.create, 2);
  assert.equal(f.state.orders[0].amount_paise, old.amount);
  // A lost response or another tab cannot revive the cancelled request key.
  assert.equal((await f.service.create(1, input)).stale, true);
});

test('unchanged cart, including reordered lines, resumes the same gateway order', async () => {
  const f = fixture(); f.state.cart.push({ id: 2, quantity: 1 });
  const old = await f.service.create(1, request());
  f.state.cart.reverse();
  const resumed = await f.service.status(1, old.id);
  assert.equal(resumed.resumable, true); assert.equal(resumed.orderId, old.orderId);
  assert.equal(f.calls.create, 1); assert.equal(f.state.orders[0].status, 'Payment Pending');
});

test('different products with the same total still invalidate a pending order', async () => {
  const f = fixture(); const old = await f.service.create(1, request());
  f.state.cart = [{ id: 2, quantity: 2 }];
  const stale = await f.service.status(1, old.id);
  assert.equal(stale.current_cart.total, old.total); assert.equal(stale.stale, true);
});

test('price changes and removed items invalidate the saved quote', async () => {
  for (const change of [f => { f.state.products[0].price = 700; }, f => { f.state.cart[0].quantity = 1; }, f => { f.state.cart = []; }]) {
    const f = fixture(); const old = await f.service.create(1, request()); change(f);
    const stale = await f.service.status(1, old.id);
    assert.equal(stale.stale, true); assert.equal(f.state.orders[0].status, 'Cancelled');
    assert.equal(f.state.cartWrites, 0); assert.equal(f.effects.length, 0);
  }
});

test('stale lost-create retries are invalidated even before a gateway order was initialized', async () => {
  const f = fixture(), input = request(); f.calls.failCreate = true;
  await assert.rejects(f.service.create(1, input));
  f.calls.failCreate = false; f.state.cart[0].quantity = 3;
  const stale = await f.service.create(1, input);
  assert.equal(stale.stale, true); assert.equal(f.state.orders[0].razorpay_order_id, undefined);
  assert.equal(f.calls.create, 1);
});

test('lost remote response is recovered and checked before cancelling a changed basket', async () => {
  const f = fixture(), input = request(); f.calls.loseCreateResponse = true;
  await assert.rejects(f.service.create(1, input));
  f.calls.loseCreateResponse = false; f.state.cart[0].quantity = 3;
  const stale = await f.service.create(1, input);
  assert.equal(stale.stale, true); assert.equal(f.state.orders[0].razorpay_order_id, 'order_fixture1');
  assert.equal(f.calls.create, 1);
});

test('in-flight payments on changed carts are checked without enabling another payment', async () => {
  for (const status of ['created', 'authorized']) {
    const f = fixture(); const old = await f.service.create(1, request());
    f.state.cart[0].quantity = 3;
    f.setPayments([{ id: 'pay_fixture', order_id: old.orderId, status }]);
    const result = await f.service.status(1, old.id);
    assert.equal(result.pending, true); assert.equal(result.resumable, false);
    assert.equal(f.state.orders[0].status, 'Payment Pending'); assert.equal(f.calls.create, 1);
  }
});

test('late capture for a cancelled order cannot fulfill it or its replacement', async () => {
  const f = fixture(); const old = await f.service.create(1, request());
  f.state.cart[0].quantity = 3; await f.service.status(1, old.id);
  await f.service.create(1, request()); f.setPayment({ amount: old.amount });
  await assert.rejects(f.service.verify(1, f.callback(old.id)), { status: 409 });
  await assert.rejects(f.service.webhook(...f.webhook()), { status: 409 });
  assert.deepEqual(f.state.orders.map(o => o.status), ['Cancelled', 'Payment Pending']);
  assert.equal(f.state.cartWrites, 0); assert.equal(f.state.jobs.length, 0); assert.equal(f.effects.length, 0);
});

test('gateway failure leaves a changed order pending and cannot authorize stale checkout', async () => {
  const f = fixture(); const old = await f.service.create(1, request());
  f.state.cart[0].quantity = 3; f.calls.failFetch = true;
  await assert.rejects(f.service.status(1, old.id));
  assert.equal(f.state.orders[0].status, 'Payment Pending'); assert.equal(f.calls.create, 1);
});

test('confirmation rolls back on DB failure and retries safely', async () => {
  const f = fixture(); await f.service.create(1, { ...request(), affiliate_ref: 'TEST' }); f.setPayment({ amount: 90000 });
  f.calls.failEffects = true; await assert.rejects(f.service.verify(1, f.callback()));
  assert.equal(f.state.orders[0].status, 'Payment Pending'); assert.equal(f.state.commissions, 0); assert.equal(f.effects.length, 0);
  f.calls.failEffects = false; await f.service.verify(1, f.callback()); assert.equal(f.effects.length, 1);
});

test('signed webhook recovers payment with no browser callback; tampered body is rejected', async () => {
  const f = fixture(); await f.service.create(1, request()); f.setPayment({ amount: 90000 });
  const [body, sig] = f.webhook();
  await assert.rejects(f.service.webhook(Buffer.concat([body, Buffer.from(' ')]), sig), { status: 400 });
  await f.service.webhook(body, sig); assert.equal(f.state.orders[0].status, 'Paid');
  await f.service.webhook(...f.webhook('payment.failed')); assert.equal(f.state.orders[0].status, 'Paid');
});

test('status endpoint enforces ownership and recovers captured payments', async () => {
  const f = fixture(); await f.service.create(1, request());
  await assert.rejects(f.service.status(2, 1), { status: 404 });
  f.setPayments([{ id: 'pay_fixture', order_id: 'order_fixture1', amount: 90000, currency: 'INR', status: 'captured', captured: true }]);
  const result = await f.service.status(1, 1); assert.equal(result.paid, true); assert.deepEqual(f.effects, [1]);
  await f.service.status(1, 1); assert.deepEqual(f.effects, [1]);
});

test('unavailable gateway never marks pending orders paid', async () => {
  const f = fixture(); await f.service.create(1, request()); f.calls.failFetch = true;
  await assert.rejects(f.service.verify(1, f.callback())); await assert.rejects(f.service.status(1, 1));
  assert.equal(f.state.orders[0].status, 'Payment Pending');
});

test('signature input validation and live configuration fail closed', () => {
  assert.equal(validSignature('payload', signature('payload'), env.RAZORPAY_KEY_SECRET), true);
  for (const invalid of [undefined, '', 'abc', 'z'.repeat(64), 'a'.repeat(65)]) assert.equal(validSignature('payload', invalid, env.RAZORPAY_KEY_SECRET), false);
  assert.throws(() => validateConfig({}), { status: 503 });
  assert.throws(() => validateConfig({ ...env, RAZORPAY_KEY_ID: 'rzp_live_fixture', RAZORPAY_WEBHOOK_SECRET: '' }), { status: 503 });
  assert.doesNotThrow(() => validateConfig(env));
});
