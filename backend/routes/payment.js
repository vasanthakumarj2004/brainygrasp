'use strict';

const express = require('express');
const Razorpay = require('razorpay');
const rateLimit = require('express-rate-limit');
const pool = require('../db');
const { authenticateToken } = require('../middleware/auth');
const { createPaymentService, validateConfig } = require('../paymentService');
const { afterConfirmation, invalidateOrderCache } = require('../orderFulfillment');
const { sendError } = require('../checkoutService');
const router = express.Router();

let client;
function gateway() {
  validateConfig(process.env);
  if (!client) {
    client = new Razorpay({ key_id: process.env.RAZORPAY_KEY_ID, key_secret: process.env.RAZORPAY_KEY_SECRET });
    client.api.rq.defaults.timeout = 10000;
  }
  return client;
}
const service = createPaymentService({ pool, gateway, env: process.env, afterConfirmation, invalidateOrderCache });
const limiter = rateLimit({ windowMs: 60 * 1000, limit: 30, standardHeaders: true, legacyHeaders: false,
  keyGenerator: req => String(req.user.id), message: { error: 'Too many payment requests. Please wait a minute.' } });

router.post('/api/payment/create-order', authenticateToken, limiter, async (req, res) => {
  try { res.json(await service.create(req.user.id, req.body)); } catch (err) { sendError(res, err); }
});
router.post('/api/payment/verify', authenticateToken, limiter, async (req, res) => {
  try {
    const result = await service.verify(req.user.id, req.body);
    res.status(result.pending ? 202 : 200).json({ ...result, success: result.paid });
  } catch (err) { sendError(res, err); }
});
router.get('/api/payment/orders/:id', authenticateToken, limiter, async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try { res.json(await service.status(req.user.id, req.params.id)); } catch (err) { sendError(res, err); }
});
router.post('/api/payment/orders/:id/abandon', authenticateToken, limiter, async (req, res) => {
  try { res.json(await service.abandon(req.user.id, req.params.id)); } catch (err) { sendError(res, err); }
});
// Mounted with express.raw BEFORE the application's JSON parser.
router.webhook = async (req, res) => {
  try { await service.webhook(req.body, req.get('x-razorpay-signature')); res.json({ received: true }); }
  catch (err) { sendError(res, err); }
};
module.exports = router;
module.exports.paymentService = service;
