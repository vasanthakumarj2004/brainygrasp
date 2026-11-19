'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');

const profile = { id: 1, name: 'Buyer', email: 'test@example.invalid', phone: '9999999999', address: 'Test Street', city: 'Chennai', state: 'Tamil Nadu', pincode: '600001' };
const cart = [{ id: 1, name: 'Toy', quantity: 2, price: 500 }];
const order = { id: 42, orderId: 'order_fixture', key: 'rzp_test_public', amount: 100000, currency: 'INR', items: cart, total: 1000, subtotal: 1000, discount: 0, shipping: 0, promo_code: '', paid: false, pending: false };
const saved = { id: 42, address: { name: 'Buyer', phone: '9999999999', line1: 'Test Street', city: 'Chennai', state: 'Tamil Nadu', pincode: '600001' }, request: { checkout_key: crypto.randomUUID() } };

async function browser({ attempt, codAttempt, method = 'razorpay', initialCart = cart, respond, cartSync } = {}) {
  const storage = new Map([['bg_token', 'fixture-token']]);
  if (attempt) storage.set('bg_payment_checkout_1', JSON.stringify(attempt));
  if (codAttempt) storage.set('bg_cod_checkout_1', JSON.stringify(codAttempt));
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) elements.set(id, { value: '', style: {}, disabled: false, textContent: '', innerHTML: '', handlers: {},
      classList: { add() {}, toggle() {} }, scrollIntoView() {}, addEventListener(event, fn) { this.handlers[event] = fn; } });
    return elements.get(id);
  };
  const radio = { value: method, checked: true, addEventListener() {} };
  const calls = [], windows = [];
  let init;
  const context = {
    console, AbortController, crypto: { randomUUID: crypto.randomUUID },
    setTimeout: () => 0, clearTimeout() {}, requestAnimationFrame: fn => fn(),
    localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) },
    window: { BG_CONFIG: { API_BASE: '' }, location: {} },
    document: { getElementById: element, querySelector: () => radio, querySelectorAll: () => [radio], addEventListener: (event, fn) => { init = fn; } },
    Razorpay: class {
      constructor(options) { this.options = options; this.handlers = {}; windows.push(this); }
      on(event, fn) { this.handlers[event] = fn; }
      open() { this.opened = true; }
    },
    fetch: async (url, options = {}) => {
      const body = options.body ? JSON.parse(options.body) : undefined;
      calls.push({ url, body });
      const override = await respond?.(url, body, calls);
      const result = override || { data: url === '/api/auth/me' ? profile : url === '/api/cart' ? initialCart : url === '/api/addresses' ? { id: 10 } : order };
      return { ok: !result.status || result.status < 400, status: result.status || 200, json: async () => result.data };
    }
  };
  context.window.CartSync = { flush: cartSync || (async () => {
    const response = await context.fetch('/api/cart');
    if (!response.ok) throw new Error('Cart could not sync');
    return response.json();
  }) };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../frontend/js/checkout_cod.js'), 'utf8'), context);
  await init();
  return { calls, windows, storage, element, click: () => element('btnPlaceOrder').handlers.click(), context };
}

test('double click creates one pending order and opens checkout with server amount', async () => {
  const b = await browser(); await Promise.all([b.click(), b.click()]);
  assert.equal(b.calls.filter(c => c.url === '/api/payment/create-order').length, 1);
  assert.equal(b.windows.length, 1); assert.equal(b.windows[0].options.amount, 100000);
  const request = b.calls.find(c => c.url === '/api/payment/create-order').body;
  assert.equal(request.amount, undefined); assert.equal(request.total, undefined);
  assert.ok(request.checkout_key); assert.equal(request.address_id, 10);
});

test('verified capture displays the existing order without posting a second shop order', async () => {
  const b = await browser({ respond: url => url === '/api/payment/verify' ? { data: { ...order, paid: true } } : undefined });
  await b.click();
  await b.windows[0].options.handler({ razorpay_order_id: order.orderId, razorpay_payment_id: 'pay_fixture', razorpay_signature: 'signature' });
  assert.equal(b.calls.find(c => c.url === '/api/payment/verify').body.order_id, 42);
  assert.equal(b.calls.filter(c => c.url === '/api/orders').length, 0);
  assert.equal(b.calls.filter(c => c.url === '/api/addresses').length, 1);
  assert.equal(b.storage.has('bg_payment_checkout_1'), false);
  assert.equal(b.element('successOverlay').style.display, 'flex');
  assert.equal(b.element('successOrderId').textContent, 'Order #42');
});

test('lost verification response keeps recovery data; retry checks status without repaying', async () => {
  let completed = false;
  const b = await browser({ respond: url => {
    if (url === '/api/payment/verify') { completed = true; throw new Error('Network unavailable'); }
    if (url === '/api/payment/orders/42' && completed) return { data: { ...order, paid: true } };
  } });
  await b.click();
  await b.windows[0].options.handler({ razorpay_order_id: order.orderId, razorpay_payment_id: 'pay_fixture', razorpay_signature: 'signature' });
  assert.equal(b.element('btnPlaceOrder').disabled, false);
  assert.match(b.element('coMsg').textContent, /pay_fixture/);
  assert.equal(b.storage.has('bg_payment_checkout_1'), true);
  await b.click(); assert.equal(b.windows.length, 1);
  assert.equal(b.element('successOverlay').style.display, 'flex');
});

test('authorized payment remains pending and resume does not open another payment', async () => {
  let authorized = false;
  const b = await browser({ respond: url => {
    if (url === '/api/payment/verify') { authorized = true; return { data: { ...order, pending: true } }; }
    if (authorized && url === '/api/payment/orders/42') return { data: { ...order, pending: true } };
  } });
  await b.click(); await b.windows[0].options.handler({ razorpay_payment_id: 'pay_fixture' });
  assert.notEqual(b.element('successOverlay').style.display, 'flex');
  await b.click(); assert.equal(b.windows.length, 1); assert.match(b.element('coMsg').textContent, /do not pay again/);
});

test('reload recovers captured payment even after webhook emptied the cart', async () => {
  const b = await browser({ attempt: saved, initialCart: [], respond: url => url === '/api/payment/orders/42' ? { data: { ...order, paid: true } } : undefined });
  assert.equal(b.element('successOverlay').style.display, 'flex'); assert.equal(b.windows.length, 0);
  assert.equal(b.storage.has('bg_payment_checkout_1'), false);
});

test('dismissal re-enables checkout and reuses the same saved order', async () => {
  const b = await browser(); await b.click(); b.windows[0].options.modal.ondismiss();
  assert.equal(b.element('btnPlaceOrder').disabled, false); await b.click();
  assert.equal(b.calls.filter(c => c.url === '/api/payment/create-order').length, 1);
  assert.equal(b.windows[1].options.order_id, b.windows[0].options.order_id);
});

test('lost create response retries the identical request key without saving another address', async () => {
  let first = true;
  const b = await browser({ respond: url => {
    if (url === '/api/payment/create-order' && first) { first = false; throw new Error('Network unavailable'); }
  } });
  await b.click(); await b.click();
  const requests = b.calls.filter(c => c.url === '/api/payment/create-order');
  assert.equal(requests.length, 2); assert.deepEqual(requests[0].body, requests[1].body);
  assert.equal(b.calls.filter(c => c.url === '/api/addresses').length, 1);
});

test('validation failure before initialization releases the invalid checkout attempt', async () => {
  const b = await browser({ respond: url => url === '/api/payment/create-order' ? { status: 400, data: { error: 'A cart product is no longer available' } } : undefined });
  await b.click(); assert.equal(b.storage.has('bg_payment_checkout_1'), false);
  assert.equal(b.windows.length, 0); assert.match(b.element('coMsg').textContent, /no longer available/);
});

test('COD double confirmation sends one keyed request and no online payment', async () => {
  const b = await browser({ method: 'cod' });
  await b.click();
  await Promise.all([b.element('btnFinalConfirmOrder').handlers.click(), b.element('btnFinalConfirmOrder').handlers.click()]);
  const requests = b.calls.filter(call => call.url === '/api/orders');
  assert.equal(requests.length, 1); assert.ok(requests[0].body.checkout_key);
  assert.equal(b.windows.length, 0); assert.equal(b.storage.has('bg_cod_checkout_1'), false);
  assert.equal(b.element('successOverlay').style.display, 'flex');
});

test('COD lost response retains request and reload with empty cart resumes the same order', async () => {
  const b = await browser({ method: 'cod', respond: url => { if (url === '/api/orders') throw new Error('Response lost'); } });
  await b.click(); await b.element('btnFinalConfirmOrder').handlers.click();
  const attempt = JSON.parse(b.storage.get('bg_cod_checkout_1'));
  assert.ok(attempt.request.checkout_key);
  const resumed = await browser({ codAttempt: attempt, initialCart: [] });
  await resumed.click(); await resumed.element('btnFinalConfirmOrder').handlers.click();
  assert.deepEqual(resumed.calls.find(call => call.url === '/api/orders').body, attempt.request);
  assert.equal(resumed.calls.filter(call => call.url === '/api/addresses').length, 0);
  assert.equal(resumed.windows.length, 0);
  assert.equal(resumed.element('successOverlay').style.display, 'flex');
});

test('pre-order delivery rejection unlocks address without opening payment', async () => {
  const b = await browser({ respond: url => url === '/api/payment/create-order'
    ? { status: 409, data: { error: 'No courier for this PIN', checkout_rejected: true } } : undefined });
  await b.click();
  assert.equal(b.storage.has('bg_payment_checkout_1'), false); assert.equal(b.windows.length, 0);
  assert.equal(b.element('codPincode').readOnly, false);
});

test('checkout waits for the latest cart save before creating an address or payment', async () => {
  let calls = 0, release;
  const waiting = new Promise(resolve => { release = resolve; });
  const b = await browser({ cartSync: async () => {
    if (++calls > 1) await waiting;
    return cart;
  } });
  const click = b.click();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(b.calls.filter(c => c.url === '/api/addresses' || c.url === '/api/payment/create-order').length, 0);
  release(); await click;
  assert.equal(b.calls.filter(c => c.url === '/api/payment/create-order').length, 1);
});

test('checkout blocks payment when cart saving fails', async () => {
  let calls = 0;
  const b = await browser({ cartSync: async () => {
    if (++calls > 1) throw new Error('Cart could not sync');
    return cart;
  } });
  await b.click();
  assert.equal(b.calls.filter(c => c.url === '/api/addresses' || c.url === '/api/payment/create-order').length, 0);
  assert.match(b.element('coMsg').textContent, /could not sync/);
});
