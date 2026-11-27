'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const express = require('express');
const { smtpOptions, smtpErrorMessage } = require('../smtpConfig');

function load(relative, mocks, environment, logs = []) {
  const filename = path.join(__dirname, '..', relative);
  const localRequire = createRequire(filename), module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module, exports: module.exports, __dirname: path.dirname(filename),
    process: { env: environment },
    console: { log: (...args) => logs.push(args.join(' ')), error: (...args) => logs.push(args.join(' ')) },
    require: key => Object.hasOwn(mocks, key) ? mocks[key] : localRequire(key),
    fetch: () => { throw new Error('OTP must never call an HTTP email provider'); },
  }, { filename });
  return module.exports;
}

function mailer(mode, outcome, credentials = true) {
  const logs = [], messages = [], configs = [], envPaths = [];
  let closed = 0;
  const environment = { NODE_ENV: mode, RESEND_API_KEY: 'ignored-test-key',
    ...(credentials ? { EMAIL_USER: 'sender@gmail.com', EMAIL_PASS: 'abcd efgh ijkl mnop' } : {}) };
  const service = load('otpService.js', {
    dotenv: { config: options => envPaths.push(options.path) },
    './smtpConfig': { smtpOptions: () => smtpOptions(environment), smtpErrorMessage },
    nodemailer: { createTransport(options) {
      configs.push(options);
      return { async sendMail(message) { messages.push(message); if (outcome instanceof Error) throw outcome; return outcome; }, close() { closed++; } };
    } },
  }, environment, logs);
  return { service, logs, messages, configs, envPaths, closed: () => closed };
}

for (const mode of ['development', 'production']) {
  test(`${mode}: SMTP acceptance sends the OTP using Gmail even with a Resend key present`, async () => {
    const f = mailer(mode, { accepted: ['customer@example.com'] });
    assert.equal(await f.service.sendOTP('email', 'customer@example.com', '654321'), true);
    assert.equal(f.messages.length, 1);
    assert.equal(f.configs[0].host, 'smtp.gmail.com'); assert.equal(f.configs[0].port, 465);
    assert.equal(f.configs[0].secure, true); assert.equal(f.configs[0].tls.rejectUnauthorized, true);
    assert.equal(f.configs[0].auth.pass, 'abcdefghijklmnop');
    assert.equal(f.messages[0].from.address, 'sender@gmail.com');
    assert.match(f.messages[0].text, /654321/); assert.match(f.messages[0].html, /654321/);
    assert.equal(f.closed(), 1); assert.equal(f.logs.length, 0);
    assert.equal(f.envPaths[0], path.resolve(__dirname, '../.env'));
  });

  test(`${mode}: missing credentials and SMTP failures never report success or leak secrets`, async () => {
    const missing = mailer(mode, {}, false);
    assert.equal(await missing.service.sendOTPEmail('customer@example.com', '654321'), false);
    assert.equal(missing.configs.length, 0);
    for (const code of ['EAUTH', 'ETIMEDOUT', 'EDNS', 'EENVELOPE']) {
      const f = mailer(mode, Object.assign(new Error('private response abcdefghijklmnop 654321'), { code }));
      assert.equal(await f.service.sendOTPEmail('customer@example.com', '654321'), false);
      assert.equal(f.closed(), 1);
      assert.ok(f.logs.length > 0);
      assert.doesNotMatch(f.logs.join(' '), /abcdefghijklmnop|654321|customer@example.com/);
    }
    const rejected = mailer(mode, { accepted: [], rejected: ['customer@example.com'] });
    assert.equal(await rejected.service.sendOTPEmail('customer@example.com', '654321'), false);
    assert.equal(rejected.closed(), 1);
  });
}

test('unsupported OTP channels do not report success', async () => {
  const f = mailer('development', {});
  assert.equal(await f.service.sendOTP('phone', '1234567890', '654321'), false);
  assert.equal(await f.service.sendOTP('other', 'customer@example.com', '654321'), false);
  assert.equal(f.messages.length, 0);
});

test('OTP API reports an email error on SMTP failure and success only on acceptance', async t => {
  let sent = false;
  const sessions = require('./helpers/authFixture').authFixture();
  const router = load('routes/auth.js', {
    '../authSecurity': { security: () => sessions.security },
    '../db': { query: async () => ({ rows: [] }) },
    '../otpService': { sendOTP: async () => sent },
    '../redisClient': { setCache: async () => {}, CACHE_KEYS: { OTP: email => email }, TTL: { OTP: 600 } },
    '../middleware/auth': { authenticateToken: (req, res, next) => next() },
    '../middleware/rateLimiters': { otpLimiter: (req, res, next) => next() },
  }, { JWT_SECRET: 'test-only' });
  const app = express(); app.use(express.json()); app.use(router);
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const request = () => fetch(`http://127.0.0.1:${server.address().port}/api/auth/request-otp`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'customer@example.com' }),
  });
  const failed = await request(); assert.equal(failed.status, 500);
  const failure = await failed.json(); assert.match(failure.error, /Failed to send OTP/); assert.ok(!failure.success);
  sent = true;
  const accepted = await request(); assert.equal(accepted.status, 200);
  assert.equal((await accepted.json()).success, true);
});
