'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { packItems, packageProfiles, productShipping } = require('../parcelPacking');
const { prepareShipping, confirmationJob } = require('../shippingCheckout');
const { shippingConfig, ShippingError } = require('../shippingPolicy');
const { advanceBooking } = require('../shipmentBooking');
const { createShiprocketClient } = require('../shiprocketService');
const { fixture, request, address } = require('./helpers/paymentFixture');
const { boxes, environment, item, shippingClient } = require('./helpers/shippingFixture');

test('packed weight includes every quantity and one outer box, and chooses a fitting box', () => {
  const result = packItems([item, { ...item, id: 2, quantity: 1, shipping_weight_g: 200, shipping_height_cm: 1 }], boxes);
  assert.deepEqual(result.parcel, { weight: 0.9, length: 22, breadth: 18, height: 12 });
  assert.equal(result.packing.stackCm.height, 9);
  assert.equal(result.packageCode, 'SMALL');
  assert.throws(() => packItems([{ ...item, quantity: 10 }], boxes), { code: 'parcel_fit' });
  assert.throws(() => packItems([{ ...item, shipping_weight_g: 100000 }], boxes), { code: 'parcel_fit' });
});

test('missing, fractional gram, invalid measurements and fabricated default boxes fail closed', () => {
  assert.throws(() => packItems([{ ...item, shipping_weight_g: null }], boxes), { code: 'product_parcel' });
  assert.throws(() => productShipping({ ...item, shipping_weight_g: 10.5 }), { status: 400 });
  assert.throws(() => productShipping({ ...item, shipping_height_cm: -1 }), { status: 400 });
  assert.equal(productShipping({}, { optional: true }).shipping_weight_g, null);
  for (const config of ['', 'invalid', '[]', JSON.stringify([{ ...boxes[0], inner_length: 999 }]), JSON.stringify([boxes[0], boxes[0]])]) {
    assert.throws(() => packageProfiles({ SHIPROCKET_PACKAGES: config }));
  }
  assert.throws(() => shippingConfig({ ...environment, SHIPROCKET_WEBHOOK_SECRET: 'replace_with_random_secret_32_characters' }), { code: 'configuration' });
});

test('checkout snapshots destination and parcel; availability gets weight, PINs, payment mode and value', async () => {
  let seen;
  const originalAddress = { ...address };
  const snapshot = await prepareShipping({ items: [item], total: 900 }, originalAddress, 'cod', {
    env: environment, shippingClient: { async checkServiceability(input) { seen = input; return { id: 12, name: 'Fixture' }; } }
  });
  originalAddress.pincode = '999999';
  assert.equal(snapshot.address.pincode, '600001');
  assert.equal(snapshot.parcel.weight, 0.7);
  assert.equal(snapshot.autoBook, true);
  assert.equal(seen.cod, true); assert.equal(seen.orderValue, 900);
  assert.equal(seen.pickupPostcode, '600002'); assert.equal(seen.deliveryPostcode, '600001');
});

test('disabled shipping never calls the courier and held orders do not auto-activate later', async () => {
  const snapshot = await prepareShipping({ items: [item] }, address, 'cod', { env: {}, shippingClient: { checkServiceability() { assert.fail('Unexpected live call'); } } });
  assert.equal(snapshot.autoBook, false);
  assert.equal(confirmationJob({ shipping_snapshot: snapshot }).state, 'awaiting_parcel');
  await assert.rejects(prepareShipping({ items: [item] }, address, 'razorpay', { env: { ...environment, RAZORPAY_KEY_ID: 'rzp_test_fixture' } }), { code: 'payment', checkoutRejected: true });
});

test('unserviceable online basket creates neither a local order nor a gateway order', async () => {
  const f = fixture({ environment, shippingClient: { async checkServiceability() { throw new ShippingError('unserviceable', 'No delivery', { status: 409 }); } } });
  await assert.rejects(f.service.create(1, request()), { code: 'unserviceable', checkoutRejected: true });
  assert.equal(f.state.orders.length, 0); assert.equal(f.calls.create, 0); assert.equal(f.state.jobs.length, 0);
});

test('online order queues exactly once after verified live capture, using saved parcel data', async () => {
  let checks = 0;
  const f = fixture({ environment, shippingClient: { async checkServiceability() { checks++; return { id: 12 }; } } });
  await f.service.create(1, request());
  assert.equal(f.state.jobs.length, 0);
  f.setPayment({ amount: 90000, status: 'authorized', captured: false });
  await f.service.verify(1, f.callback()); assert.equal(f.state.jobs.length, 0);
  f.setPayment({ status: 'captured', captured: true });
  await Promise.all([f.service.verify(1, f.callback()), f.service.webhook(...f.webhook()), f.service.verify(1, f.callback())]);
  assert.equal(checks, 1); assert.equal(f.state.jobs.length, 1); assert.equal(f.state.jobs[0].state, 'queued');
  assert.equal(f.state.jobs[0].details.parcel.weight, 0.7); assert.equal(f.state.jobs[0].details.reference, '910000000001');
  assert.equal(f.state.cartWrites, 1);
});

function bookingFixture() {
  const calls = { create: 0, awb: 0, pickup: 0, label: 0, manifest: 0 };
  const config = shippingConfig(environment);
  const order = { id: 1, status: 'Placed', payment_method: 'cod', subtotal: 1000, shipping: 0, discount: 100, total: 900, items: [item] };
  const job = { phase: 'new', details: { parcel: packItems([item], boxes).parcel, config, reference: '910000000001' } };
  const remote = { remoteOrderId: '10', shipmentId: '20', awb: '', pickupConfirmed: false };
  let exists = false;
  const client = {
    ...shippingClient, async findOrder() { return exists ? '10' : null; }, async getOrder() { return { ...remote }; },
    async createShipment() { calls.create++; exists = true; return { remoteOrderId: '10', shipmentId: '20' }; },
    async assignAWB() { calls.awb++; remote.awb = 'AWB123'; return { awb: remote.awb }; },
    async generatePickup() { calls.pickup++; remote.pickupConfirmed = true; return { pickupConfirmed: true }; },
    async generateDocument(kind) { calls[kind]++; return `https://example.invalid/${kind}.pdf`; }
  };
  const saved = [];
  const run = () => advanceBooking({ job, order, address, user: {}, config, client, save: async j => { saved.push(structuredClone(j)); } });
  return { job, order, remote, client, calls, saved, run };
}

test('booking creates order, AWB, pickup, label and manifest once; completed resume is a no-op', async () => {
  const f = bookingFixture(); await f.run(); await f.run();
  assert.deepEqual(f.calls, { create: 1, awb: 1, pickup: 1, label: 1, manifest: 1 });
  assert.equal(f.job.phase, 'complete');
  assert.ok(f.saved.some(j => j.phase === 'create_pending' && !j.details.remoteOrderId));
  assert.ok(f.saved.some(j => j.phase === 'awb_pending' && !j.details.awb));
  assert.ok(f.saved.some(j => j.phase === 'pickup_pending' && !j.details.pickupConfirmed));
});

for (const [operation, phase] of [['createShipment', 'create_pending'], ['assignAWB', 'awb_pending'], ['generatePickup', 'pickup_pending']]) {
  test(`lost ${operation} response reconciles without duplicating the external action`, async () => {
    const f = bookingFixture(); const original = f.client[operation];
    f.client[operation] = async (...args) => { await original(...args); throw new ShippingError('network', 'Response lost', { ambiguous: true, retryable: true }); };
    await assert.rejects(f.run()); assert.equal(f.job.phase, phase);
    if (operation === 'generatePickup') f.order.status = 'Shipped';
    await f.run();
    assert.equal(f.job.phase, 'complete'); assert.equal(f.calls.create, 1); assert.equal(f.calls.awb, 1); assert.equal(f.calls.pickup, 1);
  });
}

test('an unknown creation result is read again, never blindly recreated', async () => {
  const f = bookingFixture();
  f.client.createShipment = async () => { f.calls.create++; throw new ShippingError('network', 'Unknown', { ambiguous: true, retryable: true }); };
  await assert.rejects(f.run()); await assert.rejects(f.run(), { code: 'create_uncertain' });
  assert.equal(f.calls.create, 1); assert.equal(f.calls.awb, 0);
});

test('document retry after tracking advances does not repeat the pickup', async () => {
  const f = bookingFixture(); const generate = f.client.generateDocument;
  f.client.generateDocument = async kind => { if (kind === 'manifest') throw new ShippingError('document_pending', 'Wait', { retryable: true }); return generate(kind); };
  await assert.rejects(f.run()); assert.equal(f.job.details.pickupConfirmed, true);
  f.order.status = 'Shipped'; f.client.generateDocument = generate; await f.run();
  assert.deepEqual(f.calls, { create: 1, awb: 1, pickup: 1, label: 1, manifest: 1 });
});

test('unpaid, test-paid and changed pickup configuration cannot create shipments', async () => {
  for (const patch of [{ status: 'Payment Pending' }, { payment_method: 'razorpay' }, { payment_method: 'razorpay', payment_verified_at: '2026-11-12', payment_id: 'pay_test', razorpay_order_id: 'order_test', razorpay_key_id: 'rzp_test_fixture' }]) {
    const f = bookingFixture(); Object.assign(f.order, patch); await assert.rejects(f.run()); assert.equal(f.calls.create, 0);
  }
  const f = bookingFixture(); f.job.details.config = { ...f.job.details.config, pickup: 'Other' };
  await assert.rejects(f.run(), { code: 'configuration_changed' }); assert.equal(f.calls.create, 0);
});

test('Shiprocket adapter sends authenticated serviceability, pickup, label and manifest contracts', async () => {
  const requests = [];
  const client = createShiprocketClient({ env: environment, fetchImpl: async (url, options) => {
    requests.push({ url, options, body: options.body && JSON.parse(options.body) });
    const data = url.endsWith('/auth/login') ? { token: 'fixture-token' }
      : url.includes('/serviceability/') ? { data: { available_courier_companies: [{ courier_company_id: 12, courier_name: 'Fixture', rate: 75 }] } }
      : url.endsWith('/pickup') ? { pickup_status: 1 }
      : url.endsWith('/label') ? { label_created: 1, label_url: 'https://example.invalid/label.pdf' }
      : { status: 1, manifest_url: 'https://example.invalid/manifest.pdf' };
    return { ok: true, json: async () => data };
  } });
  const parcel = packItems([item], boxes).parcel;
  await client.checkServiceability({ pickupPostcode: '600002', deliveryPostcode: '600001', parcel, cod: true, orderValue: 900 });
  await client.generatePickup('20'); await client.generateDocument('label', '20'); await client.generateDocument('manifest', '20');
  assert.equal(requests.filter(r => r.url.endsWith('/auth/login')).length, 1);
  const query = new URL(requests[1].url).searchParams;
  assert.equal(query.get('weight'), '0.7'); assert.equal(query.get('cod'), '1'); assert.equal(query.get('declared_value'), '900');
  for (const r of requests.slice(2)) { assert.deepEqual(r.body.shipment_id, [20]); assert.equal(r.options.headers.Authorization, 'Bearer fixture-token'); }
});
