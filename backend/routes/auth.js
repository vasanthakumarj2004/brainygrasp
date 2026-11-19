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
const jwt     = require('jsonwebtoken');
const pool    = require('../db'); // shared pool — no duplicate connections

const { sendOTP } = require('../otpService');
const { getCached, setCache, deleteCache, CACHE_KEYS, TTL } = require('../redisClient');
const { authenticateToken } = require('../middleware/auth');

const SECRET_KEY = process.env.JWT_SECRET;
const { profile: validateProfile } = require('../../frontend/js/customer-validation');


const { otpLimiter } = require('../middleware/rateLimiters');


// Preflight OPTIONS handled by the global CORS middleware in server.js

// 1. Request OTP (Email Only)
router.post('/api/auth/request-otp', otpLimiter, async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email is required' });

  const otp = Math.floor(100000 + Math.random() * 900000).toString();
  const expires = new Date(Date.now() + 10 * 60 * 1000);

  try {
    const redisOtpData = { email, otp, expires: expires.toISOString() };
    await setCache(CACHE_KEYS.OTP(email), redisOtpData, TTL.OTP);
    
    await pool.query(`
      INSERT INTO users (email, otp, otp_expires)
      VALUES ($1, $2, $3)
      ON CONFLICT (email) DO UPDATE SET otp=$2, otp_expires=$3
    `, [email, otp, expires]);

    const otpSent = await sendOTP('email', email, otp);
    if (!otpSent) {
      return res.status(500).json({ error: 'Failed to send OTP. Please try again.' });
    }

    res.json({ success: true, message: 'OTP sent to your email' });
  } catch (err) {
    console.error('❌ OTP request error:', err);
    res.status(500).json({ error: 'Failed to send OTP' });
  }
});

// 2. Verify OTP
router.post('/api/auth/verify-otp', async (req, res) => {
  const { email, otp } = req.body;
  if (!email || !otp) return res.status(400).json({ error: 'Email and OTP required' });

  try {
    const cachedOTP = await getCached(CACHE_KEYS.OTP(email));
    let otpData = cachedOTP;

    if (!otpData) {
      const result = await pool.query('SELECT * FROM users WHERE email=$1', [email]);
      if (result.rows.length === 0) return res.status(401).json({ error: 'Invalid or expired OTP' });
      
      const user = result.rows[0];
      if (!user.otp || new Date() > new Date(user.otp_expires)) {
        return res.status(401).json({ error: 'Invalid or expired OTP' });
      }
      
      otpData = { email: user.email, otp: user.otp, expires: user.otp_expires };
    }

    if (otpData.otp !== otp || new Date() > new Date(otpData.expires)) {
      return res.status(401).json({ error: 'Invalid or expired OTP' });
    }

    const userResult = await pool.query('SELECT id, name, email, phone FROM users WHERE email=$1', [email]);
    if (userResult.rows.length === 0) return res.status(401).json({ error: 'Invalid or expired OTP' });

    const user = userResult.rows[0];
    await deleteCache(CACHE_KEYS.OTP(email));
    await pool.query('UPDATE users SET otp=NULL, otp_expires=NULL WHERE id=$1', [user.id]);

    const token = jwt.sign({ id: user.id }, SECRET_KEY, { expiresIn: '7d' });
    res.json({ token, user: { id: user.id, name: user.name, phone: user.phone, email: user.email } });
  } catch (err) {
    console.error('OTP verification error:', err);
    res.status(500).json({ error: 'Verification failed' });
  }
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
