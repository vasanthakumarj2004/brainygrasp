'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { Pool } = require('pg');
const { ensureAuthSchema, createAuthSecurity } = require('../authSecurity');
const { ensureCommissionSecurity, confirmCodCollection } = require('../commissionSecurity');

// Deliberately fixed to the disposable local container, never DATABASE_URL or .env.
test('PostgreSQL security transactions and migration', { skip: process.env.SECURITY_TEST_PG !== '1' }, async t => {
  const config = { host: '127.0.0.1', port: 15439, user: 'security_test', password: 'local-security-fixture-only', database: 'security_test', ssl: false };
  const admin = new Pool(config), schema = 'security_' + crypto.randomBytes(8).toString('hex');
  await admin.query(`CREATE SCHEMA ${schema}`);
  const db = new Pool({ ...config, options: `-c search_path=${schema}` });
  t.after(async () => { await db.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); });
  await db.query(`CREATE TABLE users(id SERIAL PRIMARY KEY, email TEXT UNIQUE, name TEXT, phone TEXT, otp TEXT, otp_expires TIMESTAMP, role TEXT, password_hash TEXT);
    CREATE TABLE affiliates(id SERIAL PRIMARY KEY, user_id INTEGER REFERENCES users(id), status TEXT);
    CREATE TABLE orders(id SERIAL PRIMARY KEY, payment_method TEXT, status TEXT, razorpay_key_id TEXT, payment_verified_at TIMESTAMP, payment_id TEXT, payment_review JSONB);
    CREATE TABLE commissions(id SERIAL PRIMARY KEY, affiliate_id INTEGER, order_id INTEGER UNIQUE, commission_amount INTEGER, status TEXT);
    CREATE TABLE affiliate_wallets(affiliate_id INTEGER UNIQUE, current_balance INTEGER, total_earned INTEGER, updated_at TIMESTAMP);
    CREATE TABLE wallet_transactions(id SERIAL PRIMARY KEY, affiliate_id INTEGER, transaction_type TEXT, amount INTEGER, description TEXT, reference_id INTEGER)`);
  await ensureAuthSchema(db);
  await ensureAuthSchema(db);
  const auth = createAuthSecurity(db, { JWT_SECRET: 'isolated-security-test-secret', ADMIN_USERNAME: 'admin', ADMIN_PASSWORD: 'fixture' });

  await t.test('row locking consumes one OTP once across ten simultaneous connections', async () => {
    const email = 'concurrent@example.com', otp = await auth.challenge(email);
    const results = await Promise.all(Array.from({ length: 10 }, () => auth.consume(email, otp)));
    assert.equal(results.filter(Boolean).length, 1);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM auth_sessions')).rows[0].n, 1);
    const claims = await auth.verify(results.find(Boolean).token, 'customer');
    assert.ok(claims);
    await auth.revoke(claims.sid);
    assert.equal(await auth.verify(results.find(Boolean).token, 'customer'), null);
  });
  await t.test('failed guesses and shared account limits remain atomic under concurrency', async () => {
    const email = 'attempts@example.com', otp = await auth.challenge(email);
    await Promise.all(Array.from({ length: 10 }, () => auth.consume(email, 'wrong')));
    assert.equal((await db.query('SELECT attempts FROM auth_challenges WHERE email=$1', [email])).rows[0].attempts, 5);
    assert.equal(await auth.consume(email, otp), null);
    const outcomes = await Promise.allSettled(Array.from({ length: 20 }, (_, i) => auth.throttle({ ip: '192.0.2.' + i }, 'login', email, 5)));
    assert.equal(outcomes.filter(r => r.status === 'fulfilled').length, 5);
    assert.ok(outcomes.filter(r => r.status === 'rejected').every(r => r.reason.status === 429));
  });
  await t.test('expired OTPs and sessions fail using database time', async () => {
    const email = 'expired@example.com', otp = await auth.challenge(email);
    await db.query("UPDATE auth_challenges SET expires_at=NOW()-INTERVAL '1 second' WHERE email=$1", [email]);
    assert.equal(await auth.consume(email, otp), null);
    const token = await auth.issue({ role: 'admin', username: 'admin' });
    await db.query("UPDATE auth_sessions SET expires_at=NOW()-INTERVAL '1 second'");
    assert.equal(await auth.verify(token, 'admin'), null);
    await auth.cleanup();
  });
  await t.test('session insertion failure rolls back OTP consumption and new user creation', async () => {
    const email = 'rollback@example.com', otp = await auth.challenge(email);
    await db.query("ALTER TABLE auth_sessions ADD CONSTRAINT fixture_failure CHECK (role <> 'customer')");
    await assert.rejects(auth.consume(email, otp), /fixture_failure/);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM users WHERE email=$1', [email])).rows[0].n, 0);
    await db.query('ALTER TABLE auth_sessions DROP CONSTRAINT fixture_failure');
    assert.ok(await auth.consume(email, otp));
  });
  await t.test('migration holds old unpaid COD/test credits once; collected COD releases once', async () => {
    await db.query(`INSERT INTO orders(id,payment_method,status,razorpay_key_id,payment_verified_at,payment_id) VALUES
      (1,'cod','Delivered',NULL,NULL,NULL), (2,'razorpay','Paid','rzp_test_fixture',NOW(),'pay_test'),
      (3,'razorpay','Paid','rzp_live_fixture',NOW(),'pay_live'), (4,'cod','Placed',NULL,NULL,NULL);
      INSERT INTO commissions(affiliate_id,order_id,commission_amount,status) VALUES
      (7,1,180,'APPROVED'), (7,2,200,'APPROVED'), (7,3,300,'APPROVED'), (7,4,100,'PENDING');
      INSERT INTO affiliate_wallets(affiliate_id,current_balance,total_earned) VALUES(7,680,680)`);
    await ensureCommissionSecurity(db); await ensureCommissionSecurity(db);
    const balance = async () => (await db.query('SELECT current_balance FROM affiliate_wallets WHERE affiliate_id=7')).rows[0].current_balance;
    assert.equal(await balance(), 300);
    assert.equal((await db.query("SELECT count(*)::int AS n FROM wallet_transactions WHERE transaction_type='REVERSAL'")).rows[0].n, 2);
    await assert.rejects(confirmCodCollection(db, 4), { status: 409 });
    await assert.rejects(confirmCodCollection(db, 2), { status: 409 });
    await Promise.all([confirmCodCollection(db, 1), confirmCodCollection(db, 1)]);
    assert.equal(await balance(), 480);
    assert.equal((await db.query("SELECT count(*)::int AS n FROM wallet_transactions WHERE transaction_type='COMMISSION'")).rows[0].n, 1);
    await ensureCommissionSecurity(db); assert.equal(await balance(), 480);
  });
});
