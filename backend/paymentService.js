'use strict';

const crypto = require('crypto');
const { CheckoutError, checkoutIdentity, positiveId, quoteCart, matchesQuote, ownedAddress, affiliate, confirmEffects } = require('./checkoutService');
const { prepareShipping } = require('./shippingCheckout');

function validSignature(payload, signature, secret) {
  if (!secret || typeof signature !== 'string' || !/^[a-f0-9]{64}$/i.test(signature)) return false;
  const expected = crypto.createHmac('sha256', secret).update(payload).digest();
  return crypto.timingSafeEqual(expected, Buffer.from(signature, 'hex'));
}

function validateConfig(env) {
  if (!/^rzp_(test|live)_[a-zA-Z0-9]+$/.test(env.RAZORPAY_KEY_ID || '') || !env.RAZORPAY_KEY_SECRET) {
    throw new CheckoutError(503, 'Online payments are not configured');
  }
  if (env.RAZORPAY_KEY_ID.startsWith('rzp_live_') && (!env.RAZORPAY_WEBHOOK_SECRET || env.RAZORPAY_WEBHOOK_SECRET.length < 32)) {
    throw new CheckoutError(503, 'Live payments require a strong webhook secret');
  }
}

function createPaymentService({ pool, gateway, env, afterConfirmation, invalidateOrderCache, shippingClient }) {
  function checkoutResponse(order, pending = false) {
    return {
      id: order.id, orderId: order.razorpay_order_id, key: order.razorpay_key_id,
      amount: order.amount_paise, currency: order.currency, paid: Boolean(order.payment_verified_at),
      pending, resumable: !pending && !order.payment_verified_at && order.status === 'Payment Pending',
      items: order.items, subtotal: order.subtotal, total: order.total,
      discount: order.discount, shipping: order.shipping, promo_code: order.promo_code,
    };
  }

  async function create(userId, input = {}) {
    validateConfig(env);
    const fingerprint = checkoutIdentity(input);
    const db = await pool.connect();
    let order;
    try {
      await db.query('BEGIN');
      await db.query('SELECT pg_advisory_xact_lock(71345, $1)', [userId]);
      const existing = await db.query('SELECT * FROM orders WHERE user_id = $1 AND checkout_key = $2 FOR UPDATE', [userId, input.checkout_key]);
      order = existing.rows[0];
      if (order) {
        if (order.checkout_fingerprint !== fingerprint || order.payment_method !== 'razorpay') throw new CheckoutError(409, 'This checkout request already belongs to a different basket or payment method');
      } else {
        const address = await ownedAddress(db, userId, input.address_id);
        const priced = await quoteCart(db, userId, input.promo_code);
        const shippingSnapshot = await prepareShipping(priced, address, 'razorpay', { env, shippingClient });
        const affiliateId = await affiliate(db, input.affiliate_ref);
        const result = await db.query(`INSERT INTO orders
          (user_id, address_id, items, subtotal, total, status, payment_method, affiliate_id,
           checkout_key, checkout_fingerprint, amount_paise, currency, razorpay_key_id, shipping, discount, promo_code, shipping_snapshot)
          VALUES ($1,$2,$3,$4,$5,'Payment Pending','razorpay',$6,$7,$8,$9,'INR',$10,$11,$12,$13,$14) RETURNING *`,
        [userId, address.id, JSON.stringify(priced.items), priced.subtotal, priced.total, affiliateId,
          input.checkout_key, fingerprint, priced.total * 100, env.RAZORPAY_KEY_ID, priced.shipping, priced.discount, priced.promoCode, JSON.stringify(shippingSnapshot)]);
        order = result.rows[0];
      }
      await db.query('COMMIT');
    } catch (err) { await db.query('ROLLBACK'); throw err; }
    finally { db.release(); }
    await invalidateOrderCache(userId);
    return initialize(order.id, userId);
  }

  async function initialize(id, userId) {
    const db = await pool.connect();
    try {
      await db.query('BEGIN');
      const { rows } = await db.query('SELECT * FROM orders WHERE id = $1 AND user_id = $2 FOR UPDATE', [positiveId(id), userId]);
      let order = rows[0];
      if (!order || order.payment_method !== 'razorpay' || !order.checkout_key) throw new CheckoutError(404, 'Payment order not found');
      if (order.razorpay_key_id !== env.RAZORPAY_KEY_ID) throw new CheckoutError(409, 'This order uses a previous payment configuration. Contact support.');
      if (order.payment_verified_at) {
        await db.query('COMMIT');
        return checkoutResponse(order);
      }
      if (!['Payment Pending', 'Cancelled'].includes(order.status)) throw new CheckoutError(409, 'Order requires support review');
      const receipt = 'bg_' + crypto.createHash('sha256').update(`${order.user_id}:${order.checkout_key}`).digest('hex').slice(0, 32);
      if (!order.razorpay_order_id && order.status === 'Payment Pending') {
        // Recover an order created remotely even if its original response was lost.
        const remoteOrders = await gateway().orders.all({ receipt, count: 100 });
        if (!Array.isArray(remoteOrders.items)) throw new Error('Invalid gateway order list');
        const matches = remoteOrders.items.filter(candidate => candidate.receipt === receipt);
        if (matches.length > 1) throw new CheckoutError(409, 'Payment initialization requires support review');
        const remote = matches[0];
        if (remote) {
          if (!/^order_[a-zA-Z0-9]+$/.test(remote.id) || remote.amount !== order.amount_paise || remote.currency !== order.currency) {
            throw new Error('Invalid gateway order response');
          }
          order = (await db.query('UPDATE orders SET razorpay_order_id = $1 WHERE id = $2 RETURNING *', [remote.id, order.id])).rows[0];
        }
      }
      if (order.razorpay_order_id) {
        // Resolve an in-flight payment before invalidating its basket. A late
        // capture on a cancelled order is rejected by confirm, never fulfilled.
        const payments = await gateway().orders.fetchPayments(order.razorpay_order_id);
        if (!Array.isArray(payments.items)) throw new Error('Invalid gateway payment list');
        const captured = payments.items.find(payment => payment.status === 'captured');
        if (captured) {
          await db.query('COMMIT');
          // Release this connection in finally before confirmation acquires one.
          return confirm(captured, order.id);
        }
        if (payments.items.some(payment => ['authorized', 'created'].includes(payment.status))) {
          if (order.status === 'Cancelled') throw new CheckoutError(409, 'Order requires support review');
          await db.query('COMMIT');
          return checkoutResponse(order, true);
        }
      }
      const priced = await quoteCart(db, userId, order.promo_code, { allowEmpty: true });
      if (order.status === 'Cancelled' || !matchesQuote(order, priced)) {
        await db.query("UPDATE orders SET status = 'Cancelled' WHERE id = $1", [order.id]);
        await db.query('COMMIT');
        await invalidateOrderCache(userId);
        // Do not return the obsolete gateway ID or amount to checkout.
        return { id: order.id, stale: true, resumable: false, paid: false, pending: false,
          current_cart: { ...priced, promo_code: priced.promoCode } };
      }
      if (!order.razorpay_order_id) {
        const remote = await gateway().orders.create({ amount: order.amount_paise, currency: order.currency,
          receipt, notes: { shop_order_id: String(order.id) }, partial_payment: false });
        if (!/^order_[a-zA-Z0-9]+$/.test(remote.id) || remote.amount !== order.amount_paise || remote.currency !== order.currency) {
          throw new Error('Invalid gateway order response');
        }
        const result = await db.query('UPDATE orders SET razorpay_order_id = $1 WHERE id = $2 RETURNING *', [remote.id, order.id]);
        order = result.rows[0];
      }
      await db.query('COMMIT');
      return checkoutResponse(order);
    } catch (err) { await db.query('ROLLBACK'); throw err; }
    finally { db.release(); }
  }

  async function ownedOrder(id, userId) {
    const { rows } = await pool.query("SELECT * FROM orders WHERE id = $1 AND user_id = $2 AND payment_method = 'razorpay'", [positiveId(id), userId]);
    if (!rows[0]?.razorpay_order_id) throw new CheckoutError(404, 'Payment order not found');
    if (rows[0].razorpay_key_id !== env.RAZORPAY_KEY_ID) throw new CheckoutError(409, 'This order uses a previous payment configuration. Contact support.');
    return rows[0];
  }

  async function confirm(payment, expectedOrderId) {
    const db = await pool.connect();
    let order;
    let changed = false;
    try {
      await db.query('BEGIN');
      const { rows } = await db.query('SELECT * FROM orders WHERE razorpay_order_id = $1 FOR UPDATE', [payment.order_id]);
      order = rows[0];
      if (!order || (expectedOrderId && order.id !== expectedOrderId)) throw new CheckoutError(400, 'Payment does not belong to this order');
      if (order.payment_method !== 'razorpay' || order.razorpay_key_id !== env.RAZORPAY_KEY_ID ||
          payment.amount !== order.amount_paise || payment.currency !== order.currency ||
          !/^pay_[a-zA-Z0-9]+$/.test(payment.id)) throw new CheckoutError(400, 'Payment details do not match this order');
      if (order.payment_verified_at) {
        if (order.payment_id !== payment.id) throw new CheckoutError(409, 'Order already has a different payment');
      } else {
        if (payment.status !== 'captured' || payment.captured !== true || Number(payment.amount_refunded || 0) !== 0) {
          throw new CheckoutError(409, 'Payment has not been captured in full');
        }
        if (order.status !== 'Payment Pending') throw new CheckoutError(409, 'Order requires support review');
        const result = await db.query("UPDATE orders SET status = 'Paid', payment_id = $1, payment_verified_at = NOW() WHERE id = $2 RETURNING *", [payment.id, order.id]);
        order = result.rows[0];
        await confirmEffects(db, order);
        changed = true;
      }
      await db.query('COMMIT');
    } catch (err) { await db.query('ROLLBACK'); throw err; }
    finally { db.release(); }
    await invalidateOrderCache(order.user_id);
    if (changed) afterConfirmation(order);
    return checkoutResponse(order);
  }

  async function verify(userId, input = {}) {
    validateConfig(env);
    const order = await ownedOrder(input.order_id, userId);
    if (input.razorpay_order_id !== order.razorpay_order_id || !/^pay_[a-zA-Z0-9]+$/.test(input.razorpay_payment_id || '') ||
        !validSignature(`${order.razorpay_order_id}|${input.razorpay_payment_id}`, input.razorpay_signature, env.RAZORPAY_KEY_SECRET)) {
      throw new CheckoutError(400, 'Payment verification failed');
    }
    const payment = await gateway().payments.fetch(input.razorpay_payment_id);
    if (payment.id !== input.razorpay_payment_id || payment.order_id !== order.razorpay_order_id ||
        payment.amount !== order.amount_paise || payment.currency !== order.currency) throw new CheckoutError(400, 'Payment details do not match this order');
    if (payment.status === 'authorized' || payment.status === 'created') return checkoutResponse(order, true);
    return confirm(payment, order.id);
  }

  async function status(userId, id) {
    validateConfig(env);
    return initialize(id, userId);
  }

  async function webhook(raw, signature) {
    if (!env.RAZORPAY_WEBHOOK_SECRET) throw new CheckoutError(503, 'Webhook is not configured');
    if (!Buffer.isBuffer(raw) || !validSignature(raw, signature, env.RAZORPAY_WEBHOOK_SECRET)) throw new CheckoutError(400, 'Invalid webhook signature');
    let event;
    try { event = JSON.parse(raw.toString('utf8')); } catch { throw new CheckoutError(400, 'Invalid webhook body'); }
    // A failed attempt must not cancel an order that may be paid by a later retry.
    if (!['payment.captured', 'order.paid'].includes(event.event)) return;
    const entity = event.payload?.payment?.entity;
    if (!entity || !/^pay_[a-zA-Z0-9]+$/.test(entity.id || '')) throw new CheckoutError(400, 'Missing webhook payment');
    const { rows } = await pool.query('SELECT id FROM orders WHERE razorpay_order_id = $1', [entity.order_id]);
    if (!rows.length) return;
    const payment = await gateway().payments.fetch(entity.id);
    if (payment.id !== entity.id || payment.order_id !== entity.order_id) throw new CheckoutError(400, 'Webhook payment mismatch');
    await confirm(payment, rows[0].id);
  }

  return { create, verify, status, webhook };
}

module.exports = { createPaymentService, validSignature, validateConfig };
