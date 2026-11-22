'use strict';
const express = require('express');
const rateLimit = require('express-rate-limit');
const pool = require('../db');
const { createReviewerLogin, reviewerEnabled } = require('../reviewerLogin');
const router = express.Router();
const login = createReviewerLogin({ pool });
const limiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: true, legacyHeaders: false,
  skipSuccessfulRequests: true, message: { error: 'Too many verification sign-in attempts. Try again in 15 minutes.' } });

router.get('/api/auth/reviewer-config', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ enabled: reviewerEnabled() });
});
router.post('/api/auth/reviewer-login', limiter, async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try { res.json(await login(req.body)); }
  catch (err) { res.status(err.status || 503).json({ error: err.status ? err.message : 'Verification sign-in failed. Please retry.' }); }
});
module.exports = router;
