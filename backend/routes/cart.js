'use strict';

const router = require('express').Router();
const pool = require('../db');
const { authenticateToken } = require('../middleware/auth');
const { applyMutation } = require('../cartService');
const { sendError } = require('../checkoutService');

// Read committed PostgreSQL state, never a cache that can race with checkout.
router.get('/api/cart', authenticateToken, async (req, res) => {
  res.set('Cache-Control', 'private, no-store');
  try {
    const result = await pool.query('SELECT cart FROM users WHERE id = $1', [req.user.id]);
    if (!result.rows[0]) return res.status(404).json({ error: 'User not found' });
    res.json(result.rows[0].cart || []);
  } catch (err) { sendError(res, err); }
});

router.post('/api/cart/sync', authenticateToken, async (req, res) => {
  res.set('Cache-Control', 'private, no-store');
  try { res.json({ success: true, cart: await applyMutation(pool, req.user.id, req.body || {}) }); }
  catch (err) { sendError(res, err); }
});

module.exports = router;
