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

const permutations = [[0,1,2], [0,2,1], [1,0,2], [1,2,0], [2,0,1], [2,1,0]];
const scale = 10000; // Round units up and usable space down to 0.0001 cm.
const volume = sides => sides.reduce((a, b) => a * b, 1);
const fits = (unit, space) => unit.every((side, axis) => side <= space[axis]);
function rotations(sides) {
  const seen = new Set();
  return permutations.map(p => p.map(axis => sides[axis])).filter(s => {
    const key = s.join(',');
    if (seen.has(key)) return false;
    seen.add(key); return true;
  });
}

// Exact grid layouts handle large quantities of equally sized products cheaply.
// A placement is always recorded for every purchased unit, including mixed SKUs.
function gridLayout(units, inside) {
  if (!units.every(u => u.sides.every((side, axis) => side === units[0].sides[axis]))) return null;
  for (const size of rotations(units[0].sides)) {
    const counts = inside.map((side, axis) => Math.floor(side / size[axis]));
    if (volume(counts) < units.length) continue;
    return units.map((unit, i) => ({ unit, size, at: [i % counts[0] * size[0],
      Math.floor(i / counts[0]) % counts[1] * size[1], Math.floor(i / (counts[0] * counts[1])) * size[2]] }));
  }
  return null;
}

// Keep the previously supported stack layouts as a guaranteed fallback.
function stackLayout(units, inside) {
  const stack = [Math.max(...units.map(u => u.sides[0])), Math.max(...units.map(u => u.sides[1])),
    units.reduce((sum, u) => sum + u.sides[2], 0)];
  for (const axes of permutations) {
    if (!fits(axes.map(axis => stack[axis]), inside)) continue;
    let height = 0;
    return units.map(unit => {
      const at = axes.map(axis => axis === 2 ? height : 0);
      height += unit.sides[2];
      return { unit, at, size: axes.map(axis => unit.sides[axis]) };
    });
  }
  return null;
}

// Bounded, deterministic mixed-item packing. Each placed unit splits one empty
// cuboid into disjoint spaces; rotations and different split/order strategies
// find side-by-side layouts without treating volume alone as proof of fit.
// This is a heuristic, not an exhaustive solution to 3-D bin packing.
function mixedLayout(units, inside, budget) {
  const orders = [
    [...units].sort((a,b) => volume(b.sides) - volume(a.sides) || b.sides[0] - a.sides[0]),
    [...units].sort((a,b) => b.sides[0] - a.sides[0] || volume(b.sides) - volume(a.sides))
  ];
  for (const ordered of orders) for (const axes of permutations) {
    const spaces = [{ at: [0,0,0], size: inside }], placed = [];
    for (const unit of ordered) {
      let best;
      for (let index = 0; index < spaces.length; index++) for (const size of unit.rotations) {
        if (--budget.remaining < 0) return null;
        const space = spaces[index];
        if (!fits(size, space.size)) continue;
        const capacity = volume(space.size.map((side, axis) => Math.floor(side / size[axis])));
        const score = [volume(space.size), -capacity, ...axes.map(axis => space.size[axis] - size[axis])];
        if (!best || score.some((n, i) => n < best.score[i] && score.slice(0, i).every((v, j) => v === best.score[j]))) {
          best = { index, size, score };
        }
      }
      if (!best) break;
      const space = spaces.splice(best.index, 1)[0];
      placed.push({ unit, at: space.at, size: best.size });
      const remaining = [...space.size];
      for (const axis of axes) {
        if (remaining[axis] > best.size[axis]) {
          const at = [...space.at], size = [...remaining];
          at[axis] += best.size[axis]; size[axis] -= best.size[axis];
          spaces.push({ at, size });
        }
        remaining[axis] = best.size[axis];
      }
    }
    if (placed.length === units.length) return placed;
  }
  return null;
}

function packItems(items, boxes) {
  if (!Array.isArray(items) || !items.length || items.length > 100) throw new ShippingError('parcel', 'The parcel must contain 1–100 products.', { status: 400 });
  let grams = 0;
  const units = [];
  for (const [itemIndex, item] of items.entries()) {
    if (!Number.isInteger(item.quantity) || item.quantity < 1 || item.quantity > 100) throw new ShippingError('parcel', 'Invalid parcel quantity.', { status: 400 });
    let unit;
    try { unit = productShipping(item); }
    catch { throw new ShippingError('product_parcel', `Shipping measurements are missing for ${item.name || 'a cart product'}. Please contact the store.`, { status: 409 }); }
    const sides = [unit.shipping_length_cm, unit.shipping_breadth_cm, unit.shipping_height_cm].map(n => Math.ceil(n * scale)).sort((a,b) => b-a);
    const orientations = rotations(sides);
    for (let number = 1; number <= item.quantity; number++) units.push({ itemIndex, number, sides, rotations: orientations });
    grams += unit.shipping_weight_g * item.quantity;
  }
  const choices = boxes.filter(box => grams + box.tare_weight_g <= box.max_weight_kg * 1000)
    .sort((a,b) => a.length*a.breadth*a.height - b.length*b.breadth*b.height || a.tare_weight_g-b.tare_weight_g || a.code.localeCompare(b.code));
  const totalVolume = units.reduce((sum, u) => sum + volume(u.sides), 0);
  const budget = { remaining: 250000 };
  for (const box of choices) {
    const inside = [box.inner_length, box.inner_breadth, box.inner_height].map(n => Math.floor(n * scale));
    if (totalVolume > volume(inside) || units.some(u => !u.rotations.some(size => fits(size, inside)))) continue;
    const layout = gridLayout(units, inside) || stackLayout(units, inside) || mixedLayout(units, inside, budget);
    if (!layout) continue;
    return { parcel: parcelDetails({ weight: (grams + box.tare_weight_g) / 1000, length: box.length, breadth: box.breadth, height: box.height }),
      packageCode: box.code, packing: { method: 'orthogonal_v2', unitWeightGrams: grams, packagingWeightGrams: box.tare_weight_g,
        innerCm: { length: box.inner_length, breadth: box.inner_breadth, height: box.inner_height },
        placements: layout.map(({ unit, at, size }) => ({ itemIndex: unit.itemIndex, unit: unit.number,
          x: at[0] / scale, y: at[1] / scale, z: at[2] / scale,
          length: size[0] / scale, breadth: size[1] / scale, height: size[2] / scale })) } };
  }
  throw new ShippingError('parcel_fit', 'This basket needs a custom parcel. Please contact the store before ordering.', { status: 409 });
}

module.exports = { productShipping, packageProfiles, packItems, fields };
