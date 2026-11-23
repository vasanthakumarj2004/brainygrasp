'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const script = fs.readFileSync(path.join(__dirname, '../../frontend/js/reviewer-login.js'), 'utf8');

for (const profileCompleted of [false, true]) {
  test(`successful reviewer login opens profile setup when profile_completed is ${profileCompleted}`, async () => {
    const values = new Map([['redirectAfterLogin', 'checkout_cod.html']]);
    const elements = new Map([
      ['reviewerLoginForm', { addEventListener(name, callback) { this[name] = callback; } }],
      ['reviewerLoginBtn', { disabled: false, textContent: 'Sign in' }],
      ['reviewerError', { style: {} }],
      ['reviewerEmail', { value: 'brainygrasp@gmail.com' }],
      ['reviewerPassword', { value: 'test-password' }],
    ]);
    const redirects = [];
    const requests = [];
    const context = {
      window: {
        BG_CONFIG: { API_BASE: '' },
        location: { href: 'https://brainygrasp.com/login.html', origin: 'https://brainygrasp.com',
          replace: target => redirects.push(target) },
        AuthUnified: { storeAuth() {}, async syncCartOnLogin() { return true; } },
      },
      document: { getElementById: id => elements.get(id) },
      localStorage: {
        getItem: key => values.get(key) || null,
        setItem: (key, value) => values.set(key, value),
        removeItem: key => values.delete(key),
      },
      URL,
      fetch: async (url, options) => {
        requests.push({ url, options });
        return {
          headers: { get: () => 'application/json' },
          ok: true,
          async json() {
            return { token: 'test-token', user: { email: 'brainygrasp@gmail.com', profile_completed: profileCompleted } };
          },
        };
      },
    };
    vm.runInNewContext(script, context);

    let prevented = false;
    await elements.get('reviewerLoginForm').submit({ preventDefault() { prevented = true; } });

    assert.equal(prevented, true);
    assert.deepEqual(redirects, ['profile-setup.html']);
    assert.equal(values.get('postProfileRedirect'), 'checkout_cod.html');
    assert.equal(values.has('redirectAfterLogin'), false);
    assert.equal(elements.get('reviewerPassword').value, '');
    assert.equal(requests.length, 1);
    assert.match(requests[0].url, /\/api\/auth\/reviewer-login$/);
  });
}
