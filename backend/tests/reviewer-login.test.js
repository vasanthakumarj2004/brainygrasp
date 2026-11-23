'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { createReviewerLogin, reviewerConfigStatus, reviewerEnabled, validReviewerSession } = require('../reviewerLogin');

const env = {
  REVIEWER_LOGIN_ENABLED: 'true',
  RAZORPAY_KEY_ID: 'rzp_test_fixture',
  RAZORPAY_KEY_SECRET: 'test-key-secret',
  SHIPROCKET_ENABLED: 'false',
  JWT_SECRET: 'local-reviewer-test-secret',
};

test('verification login is enabled only with test payments, shipping off, and a bcrypt password hash', async t => {
  env.REVIEWER_PASSWORD_HASH = await bcrypt.hash('reviewer-test-password', 12);
  assert.equal(reviewerEnabled(env), true);
  assert.deepEqual(reviewerConfigStatus(env), {
    loginEnabled: true,
    razorpayTestKey: true,
    razorpaySecretPresent: true,
    shippingDisabled: true,
    passwordHashValid: true,
    enabled: true,
  });
  for (const [change, failedCheck] of [
    [{ REVIEWER_LOGIN_ENABLED: 'false' }, 'loginEnabled'],
    [{ RAZORPAY_KEY_ID: 'rzp_live_fixture' }, 'razorpayTestKey'],
    [{ RAZORPAY_KEY_SECRET: '' }, 'razorpaySecretPresent'],
    [{ SHIPROCKET_ENABLED: 'true' }, 'shippingDisabled'],
    [{ REVIEWER_PASSWORD_HASH: 'plaintext' }, 'passwordHashValid'],
  ]) {
    const status = reviewerConfigStatus({ ...env, ...change });
    assert.equal(status.enabled, false);
    assert.equal(status[failedCheck], false);
    assert.equal(Object.entries(status).filter(([key, value]) => key !== 'enabled' && value === false).length, 1);
  }
});

test('verification login accepts only its configured email and password', async () => {
  const password = 'reviewer-test-password';
  env.REVIEWER_PASSWORD_HASH = await bcrypt.hash(password, 12);
  let queries = 0;
  const user = { id: 42, name: 'Verification Tester', email: 'brainygrasp@gmail.com', phone: null, profile_completed: false };
  const pool = { async query(sql) {
    queries++;
    if (sql.startsWith('INSERT INTO users')) return { rows: [user] };
    throw new Error('Unexpected account lookup');
  } };
  const login = createReviewerLogin({ pool, env });

  const result = await login({ email: ' BrainyGrasp@gmail.com ', password });
  const claims = jwt.verify(result.token, env.JWT_SECRET);
  assert.equal(result.user.id, user.id);
  assert.equal(result.user.reviewer, true);
  assert.equal(claims.reviewer, true);
  assert.equal(claims.id, user.id);
  assert.equal(validReviewerSession(claims, env), true);
  assert.equal(queries, 1);
  await assert.rejects(login({ email: 'other@example.com', password }), { status: 401 });
  await assert.rejects(login({ email: user.email, password: 'wrong-password' }), { status: 401 });
  assert.equal(queries, 1);
});

test('verification login does not take over an existing non-reviewer account', async () => {
  env.REVIEWER_PASSWORD_HASH = await bcrypt.hash('reviewer-test-password', 12);
  const pool = { async query(sql) {
    if (sql.startsWith('INSERT INTO users')) return { rows: [] };
    if (sql.startsWith('SELECT id,name,email,phone,profile_completed')) return { rows: [] };
    throw new Error('Unexpected account query');
  } };
  const login = createReviewerLogin({ pool, env });
  await assert.rejects(login({ email: 'brainygrasp@gmail.com', password: 'reviewer-test-password' }), { status: 409 });
});
