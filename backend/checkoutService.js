'use strict';

const crypto = require('crypto');
const { ShippingError } = require('./shippingPolicy');
const { confirmationJob } = require('./shippingCheckout');
const { payable, credit } = require('./commissionSecurity');
const { normalizePhone } = require('../frontend/js/customer-validation');

class CheckoutError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function checkoutIdentity(input) {
  if (typeof input.checkout_key !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(input.checkout_key)) {
    throw new CheckoutError(400, 'A valid checkout request key is required');
  }
  if (!Array.isArray(input.items)) throw new CheckoutError(400, 'Cart items are required');
  return crypto.createHash('sha256').update(JSON.stringify({ address: input.address_id,
    items: input.items.map(item => ({ id: item?.id, quantity: item?.quantity })), promo: input.promo_code || '', affiliate: input.affiliate_ref || null })).digest('hex');
}

function positiveId(value) {
  if (!/^[1-9]\d*$/.test(String(value)) || !Number.isSafeInteger(Number(value)) || Number(value) > 2147483647) {
    throw new CheckoutError(400, 'Invalid record ID');
  }
  return Number(value);
}

function validateAddress(input = {}) {
  const limits = { full_name: 100, phone: 40, line1: 255, city: 100, state: 100, pincode: 6 };
  const address = {};
  for (const [key, max] of Object.entries(limits)) {
    if (typeof input[key] !== 'string' || !input[key].trim() || input[key].trim().length > max) {
      throw new CheckoutError(400, 'Please provide a complete delivery address');
    }
    address[key] = input[key].trim();
  }
  address.phone = normalizePhone(address.phone);
  if (!address.phone || !/^[1-9]\d{5}$/.test(address.pincode)) {
    throw new CheckoutError(400, 'Invalid delivery phone number or PIN code');
  }
  return address;
}

// Product prices and promotions are authoritative here, never in the request.
async function quote(db, input = {}) {
  if (!Array.isArray(input.items) || !input.items.length || input.items.length > 100) {
    throw new CheckoutError(400, 'Cart must contain between 1 and 100 products');
  }
  const quantities = new Map();
  for (const item of input.items) {
    const id = positiveId(item?.id);
    const quantity = item?.quantity;
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 100 || quantities.has(id)) {
      throw new CheckoutError(400, 'Invalid or duplicate cart quantity');
    }
    quantities.set(id, quantity);
  }
  const { rows } = await db.query(`SELECT id, name, price, image, shipping_weight_g, shipping_length_cm,
    shipping_breadth_cm, shipping_height_cm FROM products WHERE id = ANY($1::int[])`, [[...quantities.keys()]]);
  if (rows.length !== quantities.size) throw new CheckoutError(400, 'A cart product is no longer available');
  const items = rows.map(product => {
    if (!Number.isSafeInteger(product.price) || product.price <= 0) throw new CheckoutError(409, 'Product price is unavailable');
    return { id: product.id, name: product.name, price: product.price, image: product.image, quantity: quantities.get(product.id),
      shipping_weight_g: product.shipping_weight_g, shipping_length_cm: product.shipping_length_cm,
      shipping_breadth_cm: product.shipping_breadth_cm, shipping_height_cm: product.shipping_height_cm };
  }).sort((a, b) => a.id - b.id);
  const subtotal = items.reduce((sum, item) => sum + item.price * item.quantity, 0);
  if (input.promo_code != null && typeof input.promo_code !== 'string') throw new CheckoutError(400, 'Invalid promo code');
  const promoCode = (input.promo_code || '').trim().toUpperCase();
  const promotions = { BRAINY10: 10, BRAINY15: 15, FLAT50: 50 };
  if (promoCode && !Object.hasOwn(promotions, promoCode)) throw new CheckoutError(400, 'Invalid promo code');
  const discount = promoCode === 'FLAT50' ? 50 : Math.round(subtotal * (promotions[promoCode] || 0) / 100);
  const shipping = subtotal >= 999 ? 0 : 60;
  const total = subtotal + shipping - discount;
  if (!Number.isSafeInteger(total) || total < 1 || total > 500000) throw new CheckoutError(400, 'Order total is outside the supported range');
  return { items, subtotal, total, shipping, discount, promoCode };
}

// Lock the saved cart while taking a checkout snapshot. Request items and stored
// cart prices are never authoritative: quantities come from users, prices from products.
async function quoteCart(db, userId, promoCode, { allowEmpty = false } = {}) {
  const { rows } = await db.query('SELECT cart FROM users WHERE id = $1 FOR UPDATE', [userId]);
  if (!rows[0]) throw new CheckoutError(404, 'User not found');
  const items = Array.isArray(rows[0].cart) ? rows[0].cart : [];
  if (allowEmpty && !items.length) {
    return { items: [], subtotal: 0, total: 0, shipping: 0, discount: 0, promoCode: promoCode || '' };
  }
  return quote(db, { items, promo_code: promoCode });
}

function matchesQuote(order, priced) {
  const lines = items => JSON.stringify(items.map(item => ({
    id: Number(item.id), quantity: item.quantity, price: item.price,
  })).sort((a, b) => a.id - b.id));
  return lines(order.items) === lines(priced.items) &&
    ['subtotal', 'total', 'shipping', 'discount'].every(key => order[key] === priced[key]) &&
    (order.promo_code || '') === priced.promoCode &&
    order.amount_paise === priced.total * 100 && order.currency === 'INR';
}

async function ownedAddress(db, userId, addressId) {
  const { rows } = await db.query('SELECT * FROM addresses WHERE id = $1 AND user_id = $2', [positiveId(addressId), userId]);
  if (!rows[0]) throw new CheckoutError(400, 'Delivery address does not belong to this account');
  return { ...rows[0], ...validateAddress(rows[0]) };
}

async function affiliate(db, ref) {
  if (!ref) return null;
  if (typeof ref !== 'string' || ref.length > 100) throw new CheckoutError(400, 'Invalid referral');
  const { rows } = await db.query("SELECT id FROM affiliates WHERE UPPER(affiliate_code) = UPPER($1) AND status = 'ACTIVE'", [ref.trim()]);
  return rows[0]?.id || null;
}

// Called in the same transaction as confirmation, and only once per order.
async function confirmEffects(db, order) {
  if (order.affiliate_id) {
    const { rows } = await db.query("SELECT commission_pct FROM affiliates WHERE id = $1 AND status = 'ACTIVE'", [order.affiliate_id]);
    if (rows[0]) {
      const pct = Number(rows[0].commission_pct);
      if (!Number.isFinite(pct) || pct < 0 || pct > 100) throw new Error('Invalid affiliate commission configuration');
      const amount = Math.round(order.total * pct / 100);
      const result = await db.query(`INSERT INTO commissions (affiliate_id, order_id, order_amount, commission_pct, commission_amount, status)
        VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (order_id) DO NOTHING RETURNING id`,
      [order.affiliate_id, order.id, order.total, pct, amount, payable(order) ? 'APPROVED' : 'PENDING']);
      if (result.rows.length && payable(order)) {
        await credit(db, { id: result.rows[0].id, affiliate_id: order.affiliate_id,
          order_id: order.id, commission_amount: amount });
      }
    }
  }
  // Do not discard products added after this checkout began.
  const { rows } = await db.query('SELECT cart FROM users WHERE id = $1 FOR UPDATE', [order.user_id]);
  const purchased = new Map(order.items.map(item => [Number(item.id), item.quantity]));
  const remaining = (Array.isArray(rows[0]?.cart) ? rows[0].cart : []).flatMap(item => {
    const quantity = (Number(item.quantity) || 1) - (purchased.get(Number(item.id)) || 0);
    return quantity > 0 ? [{ ...item, quantity }] : [];
  });
  await db.query('UPDATE users SET cart = $1 WHERE id = $2', [JSON.stringify(remaining), order.user_id]);
  const job = confirmationJob(order);
  await db.query(`INSERT INTO shipping_jobs(order_id,state,details,last_error) VALUES ($1,$2,$3,$4)
    ON CONFLICT (order_id) DO NOTHING`, [order.id, job.state, JSON.stringify(job.details), job.error]);
}

function sendError(res, err) {
  if (err instanceof CheckoutError || err instanceof ShippingError) return res.status(err.status).json({ error: err.message, code: err.code,
    ...(err.checkoutRejected ? { checkout_rejected: true } : {}) });
  // SDK errors may contain HTTP credentials; never log the full error object.
  console.error('Checkout operation failed:', err.code || err.name || 'upstream_error');
  return res.status(503).json({ error: 'Unable to confirm checkout right now. Please retry the same order.' });
}

module.exports = { CheckoutError, checkoutIdentity, positiveId, validateAddress, quote, quoteCart, matchesQuote, ownedAddress, affiliate, confirmEffects, sendError };
