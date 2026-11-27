/**
 * routes/auth.js — BrainyGrasp
 * ─────────────────────────────────────────────────────────────────────────────
 * User Authentication & Profile management routes.
 *
 * Endpoints:
 *   POST /api/auth/request-otp  — Send OTP to user email
 *   POST /api/auth/verify-otp   — Verify OTP & return JWT token
 *   GET  /api/auth/me           — Get logged-in user profile
 *   POST /api/auth/profile      — Save/update user profile details
 *   GET  /api/auth/profile-status — Check if user completed profile setup
 */

'use strict';

const express = require('express');
const router  = express.Router();
const pool    = require('../db'); // shared pool — no duplicate connections

const { sendOTP } = require('../otpService');
const { authenticateToken } = require('../middleware/auth');

const { profile: validateProfile } = require('../../frontend/js/customer-validation');


const { otpLimiter } = require('../middleware/rateLimiters');


// Preflight OPTIONS handled by the global CORS middleware in server.js

// OTPs are verified only against an atomic, attempt-limited database challenge.
router.post('/api/auth/request-otp', otpLimiter, async (req, res) => {
  const security = require('../authSecurity').security();
  const email = security.emailAddress(req.body?.email);
  if (!email) return res.status(400).json({ error: 'A valid email is required' });
  try {
    await security.throttle(req, 'otp-request', email, 5);
    const otp = await security.challenge(email);
    if (!await sendOTP('email', email, otp)) {
      await security.invalidateChallenge(email, otp);
      return res.status(500).json({ error: 'Failed to send OTP. Please try again.' });
    }
    res.json({ success: true, message: 'OTP sent to your email' });
  } catch (err) {
    res.status(err.status === 429 ? 429 : 503).json({ error: err.status === 429 ? err.message : 'Failed to send OTP' });
  }
});

router.post('/api/auth/verify-otp', otpLimiter, async (req, res) => {
  const security = require('../authSecurity').security();
  const email = security.emailAddress(req.body?.email);
  if (!email) return res.status(400).json({ error: 'A valid email and OTP are required' });
  try {
    await security.throttle(req, 'otp-verify', email, 15);
    const result = await security.consume(email, req.body?.otp);
    if (!result) return res.status(401).json({ error: 'Invalid or expired OTP' });
    res.set('Cache-Control', 'no-store');
    res.json(result);
  } catch (err) {
    res.status(err.status === 429 ? 429 : 503).json({ error: err.status === 429 ? err.message : 'Verification failed' });
  }
});

// All three login roles revoke the server session before clearing browser storage.
router.post('/api/auth/logout', (req, res, next) => require('../authSecurity').security().authenticate()(req, res, next), async (req, res) => {
  try {
    await require('../authSecurity').security().revoke(req.session.sid);
    res.set('Cache-Control', 'no-store');
    res.json({ success: true });
  } catch { res.status(503).json({ error: 'Unable to sign out. Please retry.' }); }
});

// 3. Get User Profile
router.get('/api/auth/me', authenticateToken, async (req, res) => {
  res.set('Cache-Control', 'private, no-store');
  try {
    const result = await pool.query('SELECT id, name, email, phone, gender, address, city, state, pincode, country, profile_completed, created_at FROM users WHERE id=$1', [req.user.id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'User not found' });

    const profile = result.rows[0];
    res.json(profile);
  } catch (err) {
    console.error('Profile fetch error:', err);
    res.status(500).json({ error: 'Server Error' });
  }
});

// 4. Save/Update User Profile
const handleProfileSave = async (req, res) => {
  let clean;
  try { clean = validateProfile(req.body); }
  catch (err) { return res.status(400).json({ error: err.message }); }
  const { name: cleanName, gender: cleanGender, phone: cleanPhone, address: cleanAddress,
    city: cleanCity, state: cleanState, pincode: cleanPincode, country: cleanCountry } = clean;

  try {
    const currentUser = await pool.query('SELECT phone FROM users WHERE id=$1', [req.user.id]);
    if (!currentUser.rows[0]) return res.status(404).json({ error: 'User not found' });
    const currentPhone = currentUser.rows[0].phone;

    if (cleanPhone && cleanPhone !== currentPhone) {
      const variants = cleanCountry.toLowerCase() === 'india' ? [cleanPhone, '91' + cleanPhone, '0' + cleanPhone] : [cleanPhone.replace(/\D/g, '')];
      const phoneCheck = await pool.query("SELECT id FROM users WHERE id != $2 AND (phone=$1 OR regexp_replace(phone, '[^0-9]', '', 'g') = ANY($3::text[]))", [cleanPhone, req.user.id, variants]);
      if (phoneCheck.rows.length > 0) {
        return res.status(400).json({ error: 'Phone number is already in use by another account' });
      }
    }

    const result = await pool.query(`
      UPDATE users 
      SET name=$1, gender=$2, phone=$3, address=$4, city=$5, state=$6, pincode=$7, country=$8, profile_completed=TRUE, updated_at=NOW()
      WHERE id=$9
      RETURNING id, name, email, phone, gender, address, city, state, pincode, country, profile_completed
    `, [cleanName, cleanGender, cleanPhone, cleanAddress, cleanCity, cleanState, cleanPincode, cleanCountry, req.user.id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Profile reads use PostgreSQL; a cache outage cannot revert a saved edit.
    res.json({ success: true, message: 'Profile updated successfully', user: result.rows[0] });
  } catch (err) {
    console.error('Profile save error:', err);
    if (err.code === '23505') {
      res.status(400).json({ error: 'Phone number is already in use by another account' });
    } else {
      res.status(500).json({ error: 'Failed to save profile' });
    }
  }
};

router.post('/api/auth/profile', authenticateToken, handleProfileSave);
router.put('/api/auth/profile', authenticateToken, handleProfileSave);

// 5. Profile Status
router.get('/api/auth/profile-status', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query('SELECT profile_completed FROM users WHERE id=$1', [req.user.id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'User not found' });

    const profileCompleted = result.rows[0].profile_completed !== undefined ? result.rows[0].profile_completed : false;
    res.json({ profile_completed: profileCompleted });
  } catch (err) {
    console.error('Profile status error:', err);
    res.json({ profile_completed: false });
  }
});

module.exports = router;
