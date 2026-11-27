'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const dotenv = require('dotenv');
const { packItems, packageProfiles } = require('../parcelPacking');
const { prepareShipping, confirmationJob } = require('../shippingCheckout');
const { createShiprocketClient } = require('../shiprocketService');
const { environment } = require('./helpers/shippingFixture');
const catalog = require('../catalog-products.json');

// Measured profiles under review; credentials and the private .env are never read.
const profiles = [
  { code: 'BOX_SMALL_0_5KG', length: 18, breadth: 16, height: 8, inner_length: 16, inner_breadth: 15.5, inner_height: 7, tare_weight_g: 70, max_weight_kg: 0.5 },
  { code: 'BOX_MEDIUM_2KG', length: 24, breadth: 18, height: 14, inner_length: 22, inner_breadth: 16, inner_height: 12, tare_weight_g: 120, max_weight_kg: 2 },
  { code: 'BOX_LARGE_5KG', length: 35, breadth: 25, height: 20, inner_length: 32, inner_breadth: 23, inner_height: 18, tare_weight_g: 250, max_weight_kg: 5 },
  { code: 'BOX_BULK_15KG', length: 75, breadth: 30, height: 25, inner_length: 70, inner_breadth: 26, inner_height: 22, tare_weight_g: 500, max_weight_kg: 15 }
];
const product = (id, sides, quantity = 1, grams = 100) => ({ id, name: `Product ${id}`, price: 500, quantity,
  shipping_length_cm: sides[0], shipping_breadth_cm: sides[1], shipping_height_cm: sides[2], shipping_weight_g: grams });
const cube = (side = 10) => ({ code: 'CUBE', length: side + 1, breadth: side + 1, height: side + 1,
  inner_length: side, inner_breadth: side, inner_height: side, tare_weight_g: 100, max_weight_kg: 20 });

// Independently verify the physical layout, rather than mirroring the search.
function verifyLayout(result, items, boxes) {
  const box = boxes.find(b => b.code === result.packageCode);
  const positions = result.packing.placements;
  assert.equal(positions.length, items.reduce((sum, i) => sum + i.quantity, 0));
  const expected = new Set(items.flatMap((item, index) => Array.from({ length: item.quantity }, (_, unit) => `${index}:${unit + 1}`)));
  for (const p of positions) {
    assert.ok(expected.delete(`${p.itemIndex}:${p.unit}`), 'Every purchased unit occurs exactly once');
    const original = items[p.itemIndex];
    const sizes = [p.length, p.breadth, p.height].sort((a,b) => a-b);
    const originalSizes = [original.shipping_length_cm, original.shipping_breadth_cm, original.shipping_height_cm].sort((a,b) => a-b);
    sizes.forEach((side, axis) => {
      assert.ok(side + 1e-10 >= originalSizes[axis], 'Unit dimensions must never shrink');
      assert.ok(side - originalSizes[axis] < 0.000101, 'Only conservative rounding is allowed');
    });
    for (const [axis, size] of [['x', 'length'], ['y', 'breadth'], ['z', 'height']]) {
      assert.ok(p[axis] >= 0);
      assert.ok(p[axis] + p[size] <= box[`inner_${size}`] + 1e-10, 'Unit remains inside the usable box');
    }
  }
  assert.equal(expected.size, 0);
  for (let i = 0; i < positions.length; i++) for (let j = i + 1; j < positions.length; j++) {
    const a = positions[i], b = positions[j];
    assert.ok([['x','length'], ['y','breadth'], ['z','height']].some(([axis, size]) =>
      a[axis] + a[size] <= b[axis] + 1e-10 || b[axis] + b[size] <= a[axis] + 1e-10), 'Units must not overlap');
  }
  const grams = items.reduce((sum, item) => sum + item.quantity * item.shipping_weight_g, 0) + box.tare_weight_g;
  assert.equal(result.parcel.weight, grams / 1000);
  assert.ok(grams <= box.max_weight_kg * 1000);
  assert.deepEqual(result.parcel, { weight: grams / 1000, length: box.length, breadth: box.breadth, height: box.height });
}

test('single-line quoted package JSON survives dotenv and validates every package code', () => {
  const parsed = dotenv.parse(`SHIPROCKET_PACKAGES='${JSON.stringify(profiles)}'\nSHIPROCKET_ENABLED=false\n`);
  assert.deepEqual(packageProfiles(parsed), profiles);
  assert.equal(parsed.SHIPROCKET_ENABLED, 'false');
  assert.throws(() => packageProfiles({ SHIPROCKET_PACKAGES: JSON.stringify([{ ...profiles[0], code: 'BOX_SMALL_0.5KG' }]) }), { code: 'packages' });
  assert.throws(() => packageProfiles(dotenv.parse('SHIPROCKET_PACKAGES=[\n{}\n]')), { code: 'packages' });
});

test('catalog quantity regressions choose smaller boxes with valid rotated grid layouts', () => {
  const expected = [
    [0, 1, 'BOX_SMALL_0_5KG', 0.39], [1, 1, 'BOX_MEDIUM_2KG', 0.7],
    [0, 6, 'BOX_LARGE_5KG', 2.17], [1, 6, 'BOX_LARGE_5KG', 3.73],
    [0, 12, 'BOX_BULK_15KG', 4.34], [1, 12, 'BOX_BULK_15KG', 7.46]
  ];
  for (const [index, quantity, code, weight] of expected) {
    const items = [{ ...catalog[index], quantity }];
    const result = packItems(items, profiles);
    assert.equal(result.packageCode, code);
    assert.equal(result.parcel.weight, weight);
    verifyLayout(result, items, profiles);
  }
});

test('mixed product IDs with equal dimensions share a grid and retain their quantities', () => {
  const items = catalog.map(p => ({ ...p, quantity: 3 }));
  const result = packItems(items, [...profiles].reverse());
  assert.equal(result.packageCode, 'BOX_LARGE_5KG');
  assert.equal(result.parcel.weight, 2.95);
  verifyLayout(result, items, profiles);
  assert.deepEqual(result, packItems(items, profiles), 'Configuration order must not affect box selection');
});

test('different-sized products pack side by side when the old single stack cannot fit', () => {
  const items = [product(1, [6,5,5], 2), product(2, [4,5,5], 2)];
  const boxes = [cube()];
  const result = packItems(items, boxes);
  verifyLayout(result, items, boxes);
  assert.equal(result.packageCode, 'CUBE');
  assert.deepEqual(packItems(items, boxes), result, 'Repeated selection must be deterministic');
});

test('a rotated ten-unit grid fits an exact boundary, but eleven units are rejected', () => {
  const items = [product(1, [10,8,4], 10)];
  const boxes = [{ ...cube(), length: 22, breadth: 18, height: 12, inner_length: 20, inner_breadth: 16, inner_height: 10 }];
  verifyLayout(packItems(items, boxes), items, boxes);
  assert.throws(() => packItems([{ ...items[0], quantity: 11 }], boxes), { code: 'parcel_fit' });
});

test('weight capacity includes tare and can force a larger box despite geometric fit', () => {
  const items = [product(1, [1,1,1], 1, 431)];
  assert.equal(packItems(items, profiles).packageCode, 'BOX_MEDIUM_2KG');
  items[0].shipping_weight_g = 430;
  assert.equal(packItems(items, profiles).packageCode, 'BOX_SMALL_0_5KG');
  assert.throws(() => packItems([product(1, [1,1,1], 1, 15000)], profiles), { code: 'parcel_fit' });
});

test('volume alone cannot allow an oversized unit or overlapping units', () => {
  assert.throws(() => packItems([product(1, [11,1,1])], [cube()]), { code: 'parcel_fit' });
  assert.throws(() => packItems([product(1, [6,6,6], 2)], [cube()]), { code: 'parcel_fit' });
  assert.throws(() => packItems([product(1, [10.00001,10,10])], [cube()]), { code: 'parcel_fit' });
});

test('mixed layouts remain non-overlapping and within bounds across deterministic varied orders', () => {
  let seed = 731;
  const random = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed; };
  for (let run = 0; run < 40; run++) {
    const items = Array.from({ length: 5 }, (_, i) => product(i, [1 + random()%9, 1 + random()%9, 1 + random()%9], 1 + random()%4));
    const boxes = [cube(25)];
    verifyLayout(packItems(items, boxes), items, boxes);
  }
});

test('maximum checkout quantities use a bounded grid and invalid quantities fail before packing', () => {
  const items = Array.from({ length: 100 }, (_, i) => product(i, [1,1,1], 100, 1));
  const result = packItems(items, [cube(100)]);
  assert.equal(result.packing.placements.length, 10000);
  assert.equal(result.parcel.weight, 10.1);
  assert.throws(() => packItems([product(1, [1,1,1], 101)], profiles), { code: 'parcel' });
  assert.throws(() => packItems([product(1, [1,1,1], 0)], profiles), { code: 'parcel' });
});

test('checkout, saved shipping job and Shiprocket payload retain the chosen parcel for COD and prepaid', async () => {
  const env = { ...environment, SHIPROCKET_PACKAGES: JSON.stringify(profiles) };
  const address = { full_name: 'Fixture', phone: '9876543210', line1: 'Fixture street', city: 'Chennai', state: 'Tamil Nadu', pincode: '600001' };
  const items = [{ ...catalog[0], id: 1, quantity: 6 }];
  const priced = { items, subtotal: 3294, shipping: 0, discount: 0, total: 3294 };
  const adapter = createShiprocketClient({ env, fetchImpl: () => assert.fail('No live requests allowed') });
  for (const method of ['cod', 'razorpay']) {
    let availability;
    const snapshot = await prepareShipping(priced, address, method, { env,
      shippingClient: { async checkServiceability(input) { availability = structuredClone(input); return { id: 12 }; } } });
    const order = { ...priced, id: 9, status: method === 'cod' ? 'Placed' : 'Paid', created_at: '2026-11-27T00:00:00Z',
      payment_method: method, payment_verified_at: '2026-11-27T00:00:00Z', payment_id: 'pay_fixture', razorpay_order_id: 'order_fixture',
      razorpay_key_id: 'rzp_live_fixture', shipping_snapshot: JSON.parse(JSON.stringify(snapshot)) };
    const job = confirmationJob(order);
    assert.equal(job.state, 'queued');
    assert.equal(job.details.packageCode, 'BOX_LARGE_5KG');
    assert.deepEqual(job.details.packing, snapshot.packing);
    assert.deepEqual(availability.parcel, job.details.parcel);
    assert.equal(availability.cod, method === 'cod');
    const payload = adapter.shipmentPayload(order, address, {}, job.details.parcel, snapshot.config, '910000000009');
    assert.equal(payload.weight, 2.17);
    assert.deepEqual([payload.length, payload.breadth, payload.height], [35,25,20]);
    assert.equal(payload.payment_method, method === 'cod' ? 'COD' : 'Prepaid');
    verifyLayout(snapshot, items, profiles);
  }
});
