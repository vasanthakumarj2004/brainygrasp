'use strict';

const { ShippingError, parcelDetails } = require('./shippingPolicy');
const fields = ['shipping_weight_g', 'shipping_length_cm', 'shipping_breadth_cm', 'shipping_height_cm'];

function productShipping(input, { optional = false } = {}) {
  const values = fields.map(key => input[key]);
  if (optional && values.every(value => value == null || value === '')) return Object.fromEntries(fields.map(key => [key, null]));
  const result = {};
  for (const key of fields) {
    const value = input[key];
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 ||
        value > (key === 'shipping_weight_g' ? 100000 : 300) ||
        (key === 'shipping_weight_g' && !Number.isInteger(value))) {
      throw new ShippingError('product_parcel', 'Provide unit weight in whole grams and all three unit dimensions in cm.', { status: 400 });
    }
    result[key] = value;
  }
  return result;
}

function packageProfiles(env) {
  let boxes;
  try { boxes = JSON.parse(env.SHIPROCKET_PACKAGES || '[]'); } catch { /* validated below */ }
  if (!Array.isArray(boxes) || !boxes.length || boxes.length > 50) {
    throw new ShippingError('packages', 'Shipping boxes have not been configured. Please contact the store.', { status: 503 });
  }
  const codes = new Set();
  return boxes.map(box => {
    if (!box || typeof box.code !== 'string' || !/^[A-Za-z0-9_-]{1,40}$/.test(box.code) || codes.has(box.code)) {
      throw new ShippingError('packages', 'Each shipping box needs a unique code.', { status: 503 });
    }
    codes.add(box.code);
    parcelDetails({ ...box, weight: box.max_weight_kg });
    for (const dimension of ['length', 'breadth', 'height']) {
      const inner = box['inner_' + dimension];
      if (typeof inner !== 'number' || !Number.isFinite(inner) || inner <= 0 || inner > box[dimension]) {
        throw new ShippingError('packages', 'Configure usable inner dimensions for every shipping box.', { status: 503 });
      }
    }
    if (!Number.isInteger(box.tare_weight_g) || box.tare_weight_g <= 0 || box.tare_weight_g >= box.max_weight_kg * 1000) {
      throw new ShippingError('packages', 'Configure box and protective packaging weight in grams.', { status: 503 });
    }
    return box;
  });
}

// Conservative single stack: longest sides form the base; shortest sides stack.
// Unit measurements include their individual protective packaging. This proves
// fit, rather than assuming volume alone proves that arbitrary items can fit.
function packItems(items, boxes) {
  if (!Array.isArray(items) || !items.length) throw new ShippingError('parcel', 'The parcel is empty.', { status: 400 });
  let grams = 0, length = 0, breadth = 0, height = 0;
  for (const item of items) {
    if (!Number.isInteger(item.quantity) || item.quantity < 1) throw new ShippingError('parcel', 'Invalid parcel quantity.', { status: 400 });
    let unit;
    try { unit = productShipping(item); }
    catch { throw new ShippingError('product_parcel', `Shipping measurements are missing for ${item.name || 'a cart product'}. Please contact the store.`, { status: 409 }); }
    const sides = [unit.shipping_length_cm, unit.shipping_breadth_cm, unit.shipping_height_cm].sort((a,b) => b-a);
    length = Math.max(length, sides[0]); breadth = Math.max(breadth, sides[1]); height += sides[2] * item.quantity;
    grams += unit.shipping_weight_g * item.quantity;
  }
  const stack = [length, breadth, height].sort((a,b) => b-a);
  const choices = boxes.filter(box => {
    const inside = [box.inner_length, box.inner_breadth, box.inner_height].sort((a,b) => b-a);
    return stack.every((side, index) => side <= inside[index]) && grams + box.tare_weight_g <= box.max_weight_kg * 1000;
  }).sort((a,b) => a.length*a.breadth*a.height - b.length*b.breadth*b.height || a.tare_weight_g-b.tare_weight_g || a.code.localeCompare(b.code));
  const box = choices[0];
  if (!box) throw new ShippingError('parcel_fit', 'This basket needs a custom parcel. Please contact the store before ordering.', { status: 409 });
  return { parcel: parcelDetails({ weight: (grams + box.tare_weight_g) / 1000, length: box.length, breadth: box.breadth, height: box.height }),
    packageCode: box.code, packing: { method: 'single_stack_v1', unitWeightGrams: grams, packagingWeightGrams: box.tare_weight_g,
      stackCm: { length, breadth, height }, innerCm: { length: box.inner_length, breadth: box.inner_breadth, height: box.inner_height } } };
}

module.exports = { productShipping, packageProfiles, packItems, fields };
