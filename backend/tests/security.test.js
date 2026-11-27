'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const express = require('express');
const { authFixture } = require('./helpers/authFixture');
const { databaseConfig } = require('../databaseConfig');
const { customerOrder } = require('../customerOrder');
const { payable } = require('../commissionSecurity');
const { fixture, request, env } = require('./helpers/paymentFixture');
const root = path.resolve(__dirname, '../..');

test('OTP is normalized, hashed, expires and stops after five guesses', async () => {
  const f = authFixture(), email = f.security.emailAddress(' CUSTOMER@Example.com ');
  assert.equal(email, 'customer@example.com');
  assert.equal(f.security.emailAddress({ email }), null);
  assert.equal(f.security.emailAddress('bad-address'), null);
  const otp = await f.security.challenge(email);
  assert.match(otp, /^\d{6}$/);
  assert.notEqual(f.state.challenges.get(email).verifier, otp);
  for (let i = 0; i < 5; i++) assert.equal(await f.security.consume(email, 'bad'), null);
  assert.equal(await f.security.consume(email, otp), null);
  const next = await f.security.challenge(email);
  f.state.challenges.get(email).valid = false;
  assert.equal(await f.security.consume(email, next), null);
});

test('concurrent OTP submissions create exactly one session and replay fails', async () => {
  const f = authFixture(), email = 'customer@example.com';
  const otp = await f.security.challenge(email);
  const results = await Promise.all(Array.from({ length: 10 }, () => f.security.consume(email, otp)));
  assert.equal(results.filter(Boolean).length, 1);
  assert.equal(f.state.sessions.size, 1);
  assert.equal(await f.security.consume(email, otp), null);
  const fresh = await f.security.challenge(email);
  await f.security.invalidateChallenge(email, otp); // A failed older email cannot delete a newer code.
  assert.ok(await f.security.consume(email, fresh));
});

test('login limits apply per account across IP changes and to localhost IPs', async () => {
  const f = authFixture();
  for (let i = 0; i < 10; i++) await f.security.throttle({ ip: '192.0.2.' + i }, 'admin-login', 'admin');
  await assert.rejects(f.security.throttle({ ip: '192.0.2.100' }, 'admin-login', 'admin'), { status: 429 });
  for (let i = 0; i < 60; i++) await f.security.throttle({ ip: '127.0.0.1' }, 'affiliate-login', 'account' + i);
  await assert.rejects(f.security.throttle({ ip: '127.0.0.1' }, 'affiliate-login', 'new-account'), { status: 429 });
});

test('logout, role separation, credential changes and affiliate suspension reject existing tokens', async () => {
  const f = authFixture();
  const token = await f.security.issue({ id: 1 });
  assert.ok(await f.security.verify(token, 'customer'));
  assert.equal(await f.security.verify(token, 'admin'), null);
  await f.security.revoke(jwt.decode(token).sid);
  assert.equal(await f.security.verify(token, 'customer'), null);
  assert.equal(await f.security.verify(jwt.sign({ id: 1 }, f.env.JWT_SECRET), 'customer'), null);
  const admin = await f.security.issue({ role: 'admin', username: 'admin' });
  assert.ok(await f.security.verify(admin, 'admin'));
  f.env.ADMIN_PASSWORD = 'rotated';
  assert.equal(await f.security.verify(admin, 'admin'), null);
  const affiliate = await f.security.issue({ id: 1, affiliate_id: 7, role: 'affiliate' }, f.security.digest(f.state.passwordHash));
  assert.ok(await f.security.verify(affiliate, 'affiliate'));
  f.state.active = false;
  assert.equal(await f.security.verify(affiliate, 'affiliate'), null);
  f.state.active = true; f.state.passwordHash = 'new-password-hash';
  assert.equal(await f.security.verify(affiliate, 'affiliate'), null);
});

test('authentication fails closed on a session database outage', async () => {
  const f = authFixture(), token = f.token({ id: 1 });
  f.db.query = async () => { throw Error('offline'); };
  const response = { status(code) { this.code = code; return this; }, json(body) { this.body = body; } };
  let allowed = false;
  await f.security.authenticate('customer')({ headers: { authorization: 'Bearer ' + token } }, response, () => { allowed = true; });
  assert.equal(response.code, 503); assert.equal(allowed, false);
});

test('admin and affiliate password endpoints enforce limits before password verification', async t => {
  const catalog = require('./helpers/catalogFixture').createCatalogFixture();
  const f = authFixture();
  const filename = path.join(root, 'backend/routes/affiliate.js'), module = { exports: {} };
  const mocks = { express, '../db': { query: async () => ({ rows: [] }) },
    '../authSecurity': { security: () => f.security }, bcryptjs: { compare() { throw Error('Unknown accounts must not reach password comparison'); } } };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), { module, exports: module.exports, console, process: { env: f.env }, require: key => mocks[key] });
  catalog.app.use(module.exports);
  const server = catalog.app.listen(0, '127.0.0.1'); await new Promise(r => server.once('listening', r));
  t.after(() => new Promise(r => { server.close(r); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  for (const role of ['admin', 'affiliate']) {
    const body = role === 'admin' ? { username: 'catalog-review', password: 'wrong' } : { email: 'partner@example.com', password: 'wrong' };
    for (let i = 0; i < 11; i++) {
      const response = await fetch(base + '/api/' + role + '/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      assert.equal(response.status, i < 10 ? 401 : 429, role + ' attempt ' + (i + 1));
    }
  }
});

test('HTTP logout revokes a token that previously accessed a protected route', async t => {
  const f = authFixture(), app = express();
  const filename = path.join(root, 'backend/routes/auth.js'), module = { exports: {} };
  const mocks = { express, '../db': f.db, '../authSecurity': { security: () => f.security },
    '../otpService': { sendOTP: async () => true }, '../middleware/auth': { authenticateToken: f.security.authenticate('customer') },
    '../middleware/rateLimiters': { otpLimiter: (req, res, next) => next() }, '../../frontend/js/customer-validation': {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), { module, exports: module.exports, console, process: { env: f.env }, require: key => mocks[key] });
  app.use(express.json()); app.use(module.exports);
  app.get('/protected', f.security.authenticate('customer'), (req, res) => res.json({ ok: true }));
  const server = app.listen(0, '127.0.0.1'); await new Promise(r => server.once('listening', r));
  t.after(() => new Promise(r => { server.close(r); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}`, headers = { Authorization: 'Bearer ' + f.token({ id: 1 }) };
  assert.equal((await fetch(base + '/protected', { headers })).status, 200);
  assert.equal((await fetch(base + '/api/auth/logout', { method: 'POST', headers })).status, 200);
  assert.equal((await fetch(base + '/protected', { headers })).status, 401);
});

test('only verified live payments or delivered and collected COD commissions are payable', () => {
  const live = { payment_method: 'razorpay', payment_verified_at: '2026-11-26', payment_id: 'pay_testfixture', razorpay_key_id: 'rzp_live_fixture', status: 'Paid' };
  assert.equal(payable(live), true);
  for (const patch of [{ razorpay_key_id: 'rzp_test_fixture' }, { payment_verified_at: null }, { payment_review: {} }, { status: 'Cancelled' }]) {
    assert.equal(payable({ ...live, ...patch }), false);
  }
  assert.equal(payable({ payment_method: 'cod', status: 'Placed' }), false);
  assert.equal(payable({ payment_method: 'cod', status: 'Delivered' }), false);
  assert.equal(payable({ payment_method: 'cod', status: 'Delivered', cod_collected_at: '2026-11-26' }), true);
});

test('concurrent verified live capture still credits exactly one commission', async () => {
  const f = fixture({ environment: { ...env, RAZORPAY_KEY_ID: 'rzp_live_fixture' } });
  const created = await f.service.create(1, { ...request(), affiliate_ref: 'PARTNER' });
  // The gateway is entirely in memory; the live prefix exercises eligibility only.
  f.setPayment({ amount: created.amount, order_id: created.orderId });
  await Promise.all([f.service.verify(1, f.callback()), f.service.verify(1, f.callback())]);
  assert.equal(f.state.walletCredits, 1);
  assert.deepEqual(f.state.commissionStatuses, ['APPROVED']);
});

test('customer order projection strips internal data even from legacy cached rows', () => {
  const safe = customerOrder({ id: 1, total: 100, status: 'Paid', admin_note: 'private', user_id: 3,
    checkout_fingerprint: 'secret', shipping_snapshot: { config: { password: 'secret' } },
    payment_review: { payment_id: 'private' }, shipment_progress: { state: 'queued', config: 'secret' } });
  assert.equal(safe.id, 1); assert.equal(safe.payment_review, true);
  for (const field of ['admin_note', 'user_id', 'checkout_fingerprint', 'shipping_snapshot']) assert.equal(Object.hasOwn(safe, field), false);
  assert.equal(safe.shipment_progress.config, undefined);
});

test('PostgreSQL TLS validates certificates and cannot be weakened by URL parameters', () => {
  const config = databaseConfig({ DATABASE_URL: 'postgres://u:p@db.example/store?sslmode=require&sslrootcert=ignored&ssl=false' });
  assert.equal(config.ssl.rejectUnauthorized, true);
  assert.doesNotMatch(config.connectionString, /ssl/);
  const ca = databaseConfig({ DB_SSL: 'true', DB_SSL_CA: 'line1\\nline2' });
  assert.equal(ca.ssl.ca, 'line1\nline2');
  assert.equal(databaseConfig({ DB_HOST: 'db', DB_SSL: 'false' }).ssl, false);
  assert.throws(() => databaseConfig({ DATABASE_URL: 'postgres://db/store?sslmode=no-verify' }), /TLS mode/);
});

test('profile names and payout text render as text, including stored attack payloads', async () => {
  const source = fs.readFileSync(path.join(root, 'frontend/js/common.js'), 'utf8');
  const btn = { setAttribute() {} }, attack = '<svg/onload=alert(1)>';
  const context = { document: { getElementById: () => btn }, localStorage: { getItem: key => key === 'bg_token' ? 'token' : JSON.stringify({ name: attack }) } };
  vm.runInNewContext(source.slice(source.indexOf('function escapeHTML('), source.indexOf('window.escapeHTML')) +
    source.slice(source.indexOf('function syncAuthHeader('), source.indexOf('window.syncAuthHeader')) + '\nsyncAuthHeader();', context);
  assert.doesNotMatch(btn.innerHTML, /<svg/); assert.match(btn.innerHTML, /&lt;svg/);
  const body = { innerHTML: '' };
  const walletContext = { document: { addEventListener() {}, getElementById: () => body }, getAffToken: () => 'token', API_BASE: '',
    AbortController, setTimeout, clearTimeout, console, fetch: async () => ({ ok: true, json: async () => [{ status: attack, payment_reference: attack, admin_note: attack }] }) };
  vm.createContext(walletContext);
  vm.runInContext(fs.readFileSync(path.join(root, 'frontend/affiliate/js/wallet.js'), 'utf8'), walletContext);
  await walletContext.loadPayouts();
  assert.doesNotMatch(body.innerHTML, /<svg/); assert.equal((body.innerHTML.match(/&lt;svg/g) || []).length, 3);
});
