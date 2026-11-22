'use strict';

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const EMAIL = 'brainygrasp@gmail.com';

function reviewerEnabled(env = process.env) {
  return env.REVIEWER_LOGIN_ENABLED === 'true' && /^rzp_test_[A-Za-z0-9]+$/.test(env.RAZORPAY_KEY_ID || '') &&
    Boolean(env.RAZORPAY_KEY_SECRET) && env.SHIPROCKET_ENABLED !== 'true' &&
    /^\$2[ab]\$12\$[./A-Za-z0-9]{53}$/.test(env.REVIEWER_PASSWORD_HASH || '');
}
function reviewerVersion(env = process.env) {
  return crypto.createHash('sha256').update(env.REVIEWER_PASSWORD_HASH || '').digest('hex');
}
function validReviewerSession(user, env = process.env) {
  return reviewerEnabled(env) && user.reviewerVersion === reviewerVersion(env);
}

function createReviewerLogin({ pool, env = process.env }) {
  return async function login(input) {
    const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
    if (!reviewerEnabled(env)) fail(403, 'Verification sign-in is unavailable.');
    if (typeof input?.email !== 'string' || typeof input?.password !== 'string' || input.password.length > 72) {
      fail(401, 'Invalid verification credentials.');
    }
    const matches = await bcrypt.compare(input.password, env.REVIEWER_PASSWORD_HASH);
    if (input.email.trim().toLowerCase() !== EMAIL || !matches) fail(401, 'Invalid verification credentials.');
    // Use the existing role column; never convert an existing real account.
    const created = await pool.query(`INSERT INTO users(email,name,role) VALUES ($1,$2,'REVIEWER')
      ON CONFLICT (email) DO NOTHING RETURNING id,name,email,phone,profile_completed`, [EMAIL, 'Verification Tester']);
    let user = created.rows[0];
    if (!user) {
      const found = await pool.query(`SELECT id,name,email,phone,profile_completed FROM users WHERE email=$1 AND role='REVIEWER'`, [EMAIL]);
      user = found.rows[0];
    }
    if (!user) fail(409, 'This email already belongs to another account. Contact the store owner.');
    const token = jwt.sign({ id: user.id, reviewer: true, reviewerVersion: reviewerVersion(env) }, env.JWT_SECRET, { expiresIn: '8h' });
    return { token, user: { ...user, reviewer: true } };
  };
}

module.exports = { createReviewerLogin, reviewerEnabled, validReviewerSession };
