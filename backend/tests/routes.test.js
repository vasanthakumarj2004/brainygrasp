'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const express = require('express');
const jwt = require('jsonwebtoken');
const { fixture, request, env } = require('./helpers/paymentFixture');
const { validateConfig } = require('../paymentService');

function load(relative, dependencies, environment = {}) {
  const filename = path.join(__dirname, '..', relative);
  const localRequire = createRequire(filename);
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module, exports: module.exports, Buffer, console, process: { env: environment },
    require: name => Object.hasOwn(dependencies, name) ? dependencies[name] : localRequire(name),
  }, { filename });
  return module.exports;
}

async function api(t, shippingOptions = { env: { SHIPROCKET_ENABLED: 'false' } }) {
  const f = fixture();
  const auth = load('middleware/auth.js', {}, { JWT_SECRET: 'local-test-jwt-secret' });
  const cache = { getCached: async () => null, setCache: async () => {}, deleteCache: async () => {}, CACHE_KEYS: { USER_CART: id => id, USER_ORDERS: id => id } };
  const common = { '../db': f.pool, '../middleware/auth': auth, '../redisClient': cache,
    '../orderFulfillment': { afterConfirmation() {}, invalidateOrderCache: async () => {} },
    '../shippingCheckout': { prepareShipping: (priced, address, method) => require('../shippingCheckout').prepareShipping(priced, address, method, shippingOptions) } };
  const payments = load('routes/payment.js', { ...common, '../paymentService': { validateConfig, createPaymentService: () => f.service } }, env);
  const orders = load('routes/orders.js', common);
  const app = express();
  app.post('/api/webhooks/razorpay', express.raw({ type: 'application/json', limit: '256kb' }), payments.webhook);
  app.use(express.json()); app.use(orders); app.use(payments);
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  async function send(url, body, userId = 1) {
    const response = await fetch(base + url, { method: body === undefined ? 'GET' : 'POST',
      headers: { 'Content-Type': 'application/json', ...(userId ? { Authorization: `Bearer ${jwt.sign({ id: userId }, 'local-test-jwt-secret')}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() };
  }
  return { ...f, send, base };
}

test('HTTP order endpoint rejects fabricated online payment before any insert', async t => {
  const a = await api(t);
  const response = await a.send('/api/orders', { ...request(), payment_method: 'razorpay', payment_id: 'pay_forged' });
  assert.equal(response.status, 400); assert.equal(a.state.orders.length, 0);
});

test('HTTP payment routes require a valid JWT and bind status to its owner', async t => {
  const a = await api(t);
  assert.equal((await a.send('/api/payment/create-order', request(), null)).status, 401);
  const created = await a.send('/api/payment/create-order', request());
  assert.equal(created.status, 200); assert.equal(created.body.amount, 90000);
  assert.equal((await a.send('/api/payment/orders/1', undefined, 2)).status, 404);
});

test('HTTP COD calculates prices on the server and rejects another customers address', async t => {
  const a = await api(t);
  const rejected = await a.send('/api/orders', { ...request(), payment_method: 'cod' }, 2);
  assert.equal(rejected.status, 400); assert.equal(a.state.orders.length, 0);
  const changed = await a.send('/api/orders', { ...request(), payment_method: 'cod', expected_total: 1 });
  assert.equal(changed.status, 409); assert.equal(a.state.orders.length, 0);
  const placed = await a.send('/api/orders', { ...request(), payment_method: 'cod', expected_total: 900 });
  assert.equal(placed.status, 201); assert.equal(placed.body.total, 900);
  assert.equal(a.state.orders[0].status, 'Placed'); assert.equal(a.state.orders[0].payment_id, undefined);
});

test('HTTP verification distinguishes authorization from captured completion', async t => {
  const a = await api(t); await a.send('/api/payment/create-order', request());
  a.setPayment({ amount: 90000, status: 'authorized', captured: false });
  const pending = await a.send('/api/payment/verify', a.callback());
  assert.equal(pending.status, 202); assert.equal(pending.body.success, false);
  a.setPayment({ status: 'captured', captured: true });
  const paid = await a.send('/api/payment/verify', a.callback());
  assert.equal(paid.status, 200); assert.equal(paid.body.success, true); assert.equal(paid.body.id, 1);
  assert.equal(paid.body.key_secret, undefined);
});

test('HTTP webhook validates the original raw bytes, without a customer JWT', async t => {
  const a = await api(t); await a.send('/api/payment/create-order', request()); a.setPayment({ amount: 90000 });
  const [body, signature] = a.webhook();
  const headers = { 'Content-Type': 'application/json', 'X-Razorpay-Signature': signature };
  const bad = await fetch(a.base + '/api/webhooks/razorpay', { method: 'POST', headers, body: Buffer.concat([body, Buffer.from(' ')]) });
  assert.equal(bad.status, 400);
  const good = await fetch(a.base + '/api/webhooks/razorpay', { method: 'POST', headers, body });
  assert.equal(good.status, 200); assert.equal(a.state.orders[0].status, 'Paid');
});

test('HTTP payment requests are rate limited per authenticated user', async t => {
  const a = await api(t);
  let response;
  for (let i = 0; i < 31; i++) response = await a.send('/api/payment/verify', {});
  assert.equal(response.status, 429);
});

test('HTTP COD retries return the same order and queue exactly one shipment with snapshotted measurements', async t => {
  const { environment, shippingClient } = require('./helpers/shippingFixture');
  const a = await api(t, { env: environment, shippingClient });
  const input = { ...request(), payment_method: 'cod', expected_total: 900, parcel: { weight: 0.001 } };
  const results = await Promise.all([a.send('/api/orders', input), a.send('/api/orders', input)]);
  assert.deepEqual(results.map(r => r.status).sort(), [200, 201]);
  assert.equal(results[0].body.id, results[1].body.id);
  assert.equal(a.state.orders.length, 1); assert.equal(a.state.jobs.length, 1); assert.equal(a.state.cartWrites, 1);
  assert.equal(a.state.jobs[0].state, 'queued'); assert.equal(a.state.jobs[0].details.parcel.weight, 0.7);
  assert.equal(a.state.orders[0].shipping_snapshot.address.pincode, '600001');
  const mismatch = await a.send('/api/orders', { ...input, items: [{ id: 1, quantity: 1 }] });
  assert.equal(mismatch.status, 409); assert.equal(a.state.orders.length, 1);
  const otherMethod = await a.send('/api/payment/create-order', input);
  assert.equal(otherMethod.status, 409);
});

test('HTTP COD rejects an unavailable destination before saving order or clearing cart', async t => {
  const { environment } = require('./helpers/shippingFixture');
  const { ShippingError } = require('../shippingPolicy');
  const a = await api(t, { env: environment, shippingClient: { async checkServiceability() { throw new ShippingError('unserviceable', 'No delivery', { status: 409 }); } } });
  const response = await a.send('/api/orders', { ...request(), payment_method: 'cod' });
  assert.equal(response.status, 409); assert.equal(response.body.checkout_rejected, true);
  assert.equal(a.state.orders.length, 0); assert.equal(a.state.jobs.length, 0); assert.equal(a.state.cartWrites, 0);
});
