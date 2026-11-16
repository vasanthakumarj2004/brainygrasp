/**
 * routes/orders.js — BrainyGrasp
 * ─────────────────────────────────────────────────────────────────────────────
 * Customer order & address endpoints (all require user authentication).
 *
 * Endpoints:
 *   POST /api/addresses    — Save a new delivery address
 *   POST /api/orders       — Place a COD order (online orders use payment routes)
 *   GET  /api/orders       — Fetch user's order history (Redis-cached, 1 h)
 */

'use strict';

const express   = require('express');
const router    = express.Router();
const pool      = require('../db');
const { getCached, setCache, deleteCache, CACHE_KEYS, TTL } = require('../redisClient');
const { authenticateToken } = require('../middleware/auth');
const { CheckoutError, checkoutIdentity, validateAddress, quote, ownedAddress, affiliate, confirmEffects, sendError } = require('../checkoutService');
const { prepareShipping } = require('../shippingCheckout');
const { afterConfirmation } = require('../orderFulfillment');

// ── POST /api/addresses ───────────────────────────────────────────────────────
router.post('/api/addresses', authenticateToken, async (req, res) => {
  try {
    const { full_name, phone, line1, city, state, pincode } = validateAddress(req.body);
    const result = await pool.query(`
      INSERT INTO addresses (user_id, full_name, phone, line1, city, state, pincode)
      VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id
    `, [req.user.id, full_name, phone, line1, city, state, pincode]);
    res.status(201).json(result.rows[0]);
  } catch (err) {
    sendError(res, err);
  }
});

// ── POST /api/orders ──────────────────────────────────────────────────────────
// Place a COD order. Handles affiliate commission in a transaction,
// Validate shipping before confirmation; book from the durable queue after commit.
router.post('/api/orders', authenticateToken, async (req, res) => {
  if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
    return res.status(400).json({ error: 'Order details are required' });
  }
  // Online orders can only be confirmed by the payment service after capture.
  if ((req.body.payment_method || 'cod') !== 'cod' || req.body.payment_id) {
    return res.status(400).json({ error: 'Online orders must use the verified payment checkout' });
  }
  let client;
  try {
    const fingerprint = checkoutIdentity(req.body);
    client = await pool.connect();
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(71345, $1)', [req.user.id]);
    const existing = await client.query('SELECT * FROM orders WHERE user_id = $1 AND checkout_key = $2 FOR UPDATE', [req.user.id, req.body.checkout_key]);
    if (existing.rows[0]) {
      const order = existing.rows[0];
      if (order.payment_method !== 'cod' || order.checkout_fingerprint !== fingerprint) {
        throw new CheckoutError(409, 'This checkout request already belongs to a different basket or payment method');
      }
      await client.query('COMMIT');
      return res.status(200).json({ id: order.id, total: order.total, status: order.status });
    }
    const address = await ownedAddress(client, req.user.id, req.body.address_id);
    const priced = await quote(client, req.body);
    if (req.body.expected_total !== undefined && req.body.expected_total !== priced.total) {
      throw Object.assign(new CheckoutError(409, 'Cart prices have changed. Refresh checkout before confirming your order.'), { checkoutRejected: true });
    }
    const shippingSnapshot = await prepareShipping(priced, address, 'cod');
    const affiliateId = await affiliate(client, req.body.affiliate_ref);
    const { rows } = await client.query(`INSERT INTO orders
      (user_id, address_id, items, subtotal, total, status, payment_method, affiliate_id, shipping, discount, promo_code,
       checkout_key, checkout_fingerprint, shipping_snapshot)
      VALUES ($1,$2,$3,$4,$5,'Placed','cod',$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
    [req.user.id, address.id, JSON.stringify(priced.items), priced.subtotal, priced.total,
      affiliateId, priced.shipping, priced.discount, priced.promoCode, req.body.checkout_key, fingerprint, JSON.stringify(shippingSnapshot)]);
    const order = rows[0];
    await confirmEffects(client, order);
    await client.query('COMMIT');
    await deleteCache(CACHE_KEYS.USER_CART(req.user.id)).catch(() => {});
    await deleteCache(CACHE_KEYS.USER_ORDERS(req.user.id)).catch(() => {});
    afterConfirmation(order);
    res.status(201).json({ id: order.id, total: order.total });
  } catch (err) {
    if (client) await client.query('ROLLBACK');
    sendError(res, err);
  } finally { if (client) client.release(); }
});

router.get('/api/orders', authenticateToken, async (req, res) => {
  try {
    res.set('Cache-Control', 'private, no-store');
    // Dashboard polling must see committed courier events even if a cache invalidation failed.
    const fresh = req.query.fresh === '1';
    const cachedOrders = fresh ? null : await getCached(CACHE_KEYS.USER_ORDERS(req.user.id));
    if (cachedOrders) {
      return res.json(cachedOrders);
    }

    const result = await pool.query(`
      SELECT o.*,
             a.full_name, a.line1, a.line2,
             a.city,      a.state, a.pincode
      FROM orders o
      LEFT JOIN addresses a ON o.address_id = a.id
      WHERE o.user_id = $1
      ORDER BY o.created_at DESC
    `, [req.user.id]);

    if (!fresh) await setCache(CACHE_KEYS.USER_ORDERS(req.user.id), result.rows, TTL.USER_ORDERS);
    res.json(result.rows);
  } catch (err) {
    console.error('Orders fetch error:', err);
    res.status(500).json({ error: 'Failed to fetch orders' });
  }
});

module.exports = router;
