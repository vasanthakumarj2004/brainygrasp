'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');

const profile = { id: 1, name: 'Buyer', email: 'test@example.invalid', phone: '9999999999', address: 'Test Street', city: 'Chennai', state: 'Tamil Nadu', pincode: '600001' };
const cart = [{ id: 1, name: 'Toy', quantity: 2, price: 500 }];
const order = { id: 42, orderId: 'order_fixture', key: 'rzp_test_public', amount: 100000, currency: 'INR', items: cart, total: 1000, subtotal: 1000, discount: 0, shipping: 0, promo_code: '', paid: false, pending: false, resumable: true };
const saved = { id: 42, address: { name: 'Buyer', phone: '9999999999', line1: 'Test Street', city: 'Chennai', state: 'Tamil Nadu', pincode: '600001' }, request: { checkout_key: crypto.randomUUID() } };
const changedCart = [{ ...cart[0], quantity: 3 }];
const freshOrder = { ...order, id: 43, orderId: 'order_replacement', items: changedCart, subtotal: 1500, total: 1500, amount: 150000 };
const staleOrder = { id: 42, stale: true, resumable: false, paid: false, pending: false, current_cart: { ...freshOrder, resumable: false } };

test('late captured payment shows review instructions without reopening Razorpay', async () => {
  const b = await browser({ attempt: saved, respond: url => url.includes('/api/payment/') ? { data: {
    ...order, resumable: false, review_required: true, review_message: 'Payment received. Contact support for refund review.'
  } } : undefined });
  await b.click();
  assert.equal(b.windows.length, 0);
  assert.ok([...b.storage.values()].some(value => String(value).includes('42')));
});

const profileToken = (id = 1, exp = Math.floor(Date.now() / 1000) + 3600) =>
  `fixture.${Buffer.from(JSON.stringify({ id, exp })).toString('base64url')}.signature`;

async function browser({ attempt, codAttempt, method = 'razorpay', initialCart = cart, respond, cartSync,
  cachedProfile, token = profileToken(), profileTimeout = false } = {}) {
  const storage = new Map([['bg_token', token]]);
  if (cachedProfile !== undefined) storage.set('bg_user', typeof cachedProfile === 'string' ? cachedProfile : JSON.stringify(cachedProfile));
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
    console, AbortController, atob, crypto: { randomUUID: crypto.randomUUID },
    setTimeout: (fn, ms) => { if (profileTimeout && ms === 15000) queueMicrotask(fn); return 0; },
    clearTimeout() {}, requestAnimationFrame: fn => fn(),
    localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) },
    window: { BG_CONFIG: { API_BASE: '' }, location: {}, CustomerValidation: require('../../frontend/js/customer-validation') },
    document: { getElementById: element, querySelector: () => radio, querySelectorAll: () => [radio], addEventListener: (event, fn) => { init = fn; } },
    Razorpay: class {
      constructor(options) { this.options = options; this.handlers = {}; windows.push(this); }
      on(event, fn) { this.handlers[event] = fn; }
      open() { this.opened = true; }
    },
    fetch: async (url, options = {}) => {
      const body = options.body ? JSON.parse(options.body) : undefined;
      calls.push({ url, body });
      const override = await respond?.(url, body, calls, { storage, options });
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

const profileFields = { codName: 'name', codPhone: 'phone', codLine1: 'address', codCity: 'city', codState: 'state', codPincode: 'pincode' };
function assertProfileFields(b, expected) {
  for (const [id, key] of Object.entries(profileFields)) assert.equal(b.element(id).value, expected[key] || '', id);
}

test('fresh profile replaces stale cache and fills every delivery field', async () => {
  const b = await browser({ cachedProfile: { ...profile, address: 'Old Street', city: 'Old City' } });
  assertProfileFields(b, profile);
  assert.equal(b.element('profileLoadNotice').style.display, 'none');
  assert.equal(JSON.parse(b.storage.get('bg_user')).address, profile.address);
  await b.click();
  assert.equal(b.calls.find(c => c.url === '/api/addresses').body.line1, profile.address);
});

for (const failure of ['http', 'network', 'timeout']) {
  test(`profile ${failure} failure restores all saved address fields and allows reviewed checkout`, async () => {
    const b = await browser({ cachedProfile: profile, profileTimeout: failure === 'timeout', respond: async (url, body, calls, { options }) => {
      if (url !== '/api/auth/me') return;
      assert.equal(options.cache, 'no-store');
      if (failure === 'http') return { status: 503, data: { error: 'Unavailable' } };
      if (failure === 'network') throw new Error('Offline');
      await new Promise((resolve, reject) => {
        if (options.signal.aborted) reject(new Error('Aborted'));
        else options.signal.addEventListener('abort', () => reject(new Error('Aborted')), { once: true });
      });
    } });
    assertProfileFields(b, profile);
    assert.match(b.element('profileLoadNotice').textContent, /saved profile.*review/);
    assert.equal(b.element('profileLoadNotice').style.display, 'block');
    b.element('codLine1').value = 'Reviewed Street';
    await b.click();
    assert.equal(b.calls.find(c => c.url === '/api/addresses').body.line1, 'Reviewed Street');
    assert.equal(b.windows.length, 1);
  });
}

test('profile failure without usable account cache blocks checkout with a clear retry message', async () => {
  for (const cachedProfile of [undefined, '{invalid', null, { ...profile, id: 2 }]) {
    const b = await browser({ cachedProfile, respond: url => url === '/api/auth/me' ? { status: 500, data: {} } : undefined });
    assert.equal(b.element('btnPlaceOrder').disabled, true);
    assert.equal(b.element('codLine1').value, '');
    assert.match(b.element('profileLoadNotice').textContent, /refresh to retry/i);
    assert.equal(b.windows.length, 0);
    assert.equal(b.calls.some(c => c.url === '/api/addresses' || c.url === '/api/payment/create-order'), false);
  }
});

test('expired or unreadable session cannot select cached profile on API failure', async () => {
  for (const token of ['invalid-token', profileToken(1, 1)]) {
    const b = await browser({ token, cachedProfile: profile, respond: url => url === '/api/auth/me' ? { status: 503, data: {} } : undefined });
    assert.equal(b.element('btnPlaceOrder').disabled, true); assert.equal(b.element('codLine1').value, '');
  }
});

test('unauthorized profile redirects to login instead of using cached delivery details', async () => {
  for (const status of [401, 403]) {
    const b = await browser({ cachedProfile: profile, respond: url => url === '/api/auth/me' ? { status, data: {} } : undefined });
    assert.equal(b.context.window.location.href, 'login');
    assert.equal(b.storage.has('bg_token'), false); assert.equal(b.storage.has('bg_user'), false);
    assert.equal(b.element('codLine1').value, ''); assert.equal(b.element('btnPlaceOrder').disabled, true);
  }
});

test('profile response from a previous sign-in cannot replace the current account cache', async () => {
  const other = { ...profile, id: 2, address: 'Other Account Street' };
  const b = await browser({ respond: (url, body, calls, { storage }) => {
    if (url !== '/api/auth/me') return;
    storage.set('bg_token', profileToken(2)); storage.set('bg_user', JSON.stringify(other));
    return { data: profile };
  } });
  assert.equal(JSON.parse(b.storage.get('bg_user')).id, 2);
  assert.equal(b.element('codLine1').value, ''); assert.equal(b.element('btnPlaceOrder').disabled, true);
  assert.match(b.element('profileLoadNotice').textContent, /sign-in changed/);
});

test('partial cached profile remains editable and missing delivery details prevent payment', async () => {
  const b = await browser({ cachedProfile: { id: 1, name: profile.name }, respond: url => url === '/api/auth/me' ? { status: 500, data: {} } : undefined });
  assert.equal(b.element('codName').value, profile.name);
  await b.click();
  assert.match(b.element('coMsg').textContent, /fill all delivery address fields/);
  assert.equal(b.windows.length, 0);
});

test('cached-profile warning remains visible when recovering an existing checkout', async () => {
  const b = await browser({ cachedProfile: profile, attempt: saved, respond: url => url === '/api/auth/me' ? { status: 500, data: {} } : undefined });
  assert.match(b.element('profileLoadNotice').textContent, /saved profile/);
  assert.equal(b.element('profileLoadNotice').style.display, 'block');
  assert.equal(b.element('codLine1').value, saved.address.line1);
});

test('COD confirmation submits the complete recovered profile address', async () => {
  const b = await browser({ method: 'cod', cachedProfile: profile, respond: url => url === '/api/auth/me' ? { status: 500, data: {} } : undefined });
  assertProfileFields(b, profile);
  await b.click(); await b.element('btnFinalConfirmOrder').handlers.click();
  assert.deepEqual(b.calls.find(c => c.url === '/api/addresses').body, {
    full_name: profile.name, phone: profile.phone, line1: profile.address,
    city: profile.city, state: profile.state, pincode: profile.pincode
  });
  assert.equal(b.calls.filter(c => c.url === '/api/orders').length, 1);
  assert.equal(b.element('successOverlay').style.display, 'flex');
});

test('missing server account never falls back to a saved profile', async () => {
  const b = await browser({ cachedProfile: profile, respond: url => url === '/api/auth/me' ? { status: 404, data: {} } : undefined });
  assert.equal(b.element('btnPlaceOrder').disabled, true);
  assert.equal(b.element('codLine1').value, '');
  assert.match(b.element('profileLoadNotice').textContent, /refresh to retry/i);
});

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

test('reload with a changed cart discards old resume details and pays a fresh order', async () => {
  const b = await browser({ attempt: saved, initialCart: changedCart, respond: url => {
    if (url === '/api/payment/orders/42') return { data: staleOrder };
    if (url.startsWith('/api/payment/')) return { data: freshOrder };
  } });
  assert.equal(b.storage.has('bg_payment_checkout_1'), false);
  assert.match(b.element('coItems').innerHTML, /Qty: 3/);
  assert.match(b.element('coItems').innerHTML, /1500/);
  assert.match(b.element('btnPlaceOrder').innerHTML, /Pay Now/);
  assert.equal(b.element('codPincode').readOnly, false);
  await b.click();
  assert.equal(b.windows.length, 1);
  assert.equal(b.windows[0].options.order_id, 'order_replacement');
  assert.equal(b.windows[0].options.amount, 150000);
  assert.notEqual(b.calls.find(c => c.url === '/api/payment/create-order').body.checkout_key, saved.request.checkout_key);
});

test('cart edits after dismissal are flushed before resume and replace the stale payment', async () => {
  let changed = false;
  const b = await browser({ cartSync: async () => changed ? changedCart : cart, respond: url => {
    if (!changed) return;
    if (url === '/api/payment/orders/42') return { data: staleOrder };
    if (url.startsWith('/api/payment/')) return { data: freshOrder };
  } });
  await b.click(); b.windows[0].options.modal.ondismiss(); changed = true;
  await b.click();
  assert.equal(b.windows.length, 2); assert.equal(b.windows[1].options.amount, 150000);
  assert.notEqual(b.windows[1].options.order_id, b.windows[0].options.order_id);
  const requests = b.calls.filter(c => c.url === '/api/payment/create-order');
  assert.equal(requests.length, 2); assert.equal(requests[1].body.items[0].quantity, 3);
});

test('lost create response followed by a cart edit retires the old key before replacement', async () => {
  let lost = false;
  const b = await browser({ respond: url => {
    if (url === '/api/payment/create-order') {
      if (!lost) { lost = true; throw new Error('Response lost'); }
      return { data: b.calls.filter(c => c.url === url).length === 2 ? staleOrder : freshOrder };
    }
    if (url === '/api/payment/orders/43') return { data: freshOrder };
  } });
  await b.click(); await b.click();
  const requests = b.calls.filter(c => c.url === '/api/payment/create-order');
  assert.equal(requests.length, 3);
  assert.equal(requests[0].body.checkout_key, requests[1].body.checkout_key);
  assert.notEqual(requests[1].body.checkout_key, requests[2].body.checkout_key);
  assert.equal(b.windows.length, 1); assert.equal(b.windows[0].options.order_id, 'order_replacement');
});

test('empty changed cart cancels resume without opening a payment', async () => {
  const b = await browser({ attempt: saved, initialCart: [], respond: url => url === '/api/payment/orders/42'
    ? { data: { ...staleOrder, current_cart: { items: [], total: 0, subtotal: 0, shipping: 0, discount: 0 } } } : undefined });
  assert.equal(b.storage.has('bg_payment_checkout_1'), false);
  assert.equal(b.element('btnPlaceOrder').disabled, true);
  assert.equal(b.windows.length, 0); assert.match(b.element('coItems').innerHTML, /cart is empty/);
});

test('resume never opens Razorpay when the latest cart cannot sync', async () => {
  let syncs = 0;
  const b = await browser({ attempt: saved, cartSync: async () => {
    if (++syncs > 1) throw new Error('Cart could not sync');
    return cart;
  } });
  await b.click();
  assert.equal(b.windows.length, 0); assert.match(b.element('coMsg').textContent, /could not sync/);
});

test('pending payments show status checking instead of offering resume payment', async () => {
  const b = await browser({ attempt: saved, respond: url => url === '/api/payment/orders/42'
    ? { data: { ...order, pending: true, resumable: false } } : undefined });
  assert.equal(b.element('btnPlaceOrder').textContent, 'Check Existing Payment');
  await b.click(); assert.equal(b.windows.length, 0);
});

test('checkout and payment service replace qty 1 with qty 3 and fulfill only the new snapshot', async () => {
  const { fixture } = require('./helpers/paymentFixture');
  const f = fixture();
  f.state.products[0].price = 743;
  f.state.cart = [{ id: 1, quantity: 1 }];
  const b = await browser({
    cartSync: async () => f.state.cart.map(item => ({ ...f.state.products.find(p => p.id === item.id), ...item })),
    respond: async (url, body) => {
      if (url === '/api/payment/create-order') return { data: await f.service.create(1, body) };
      if (url.startsWith('/api/payment/orders/')) return { data: await f.service.status(1, url.split('/').pop()) };
      if (url === '/api/payment/verify') return { data: await f.service.verify(1, body) };
    }
  });
  await b.click(); b.windows[0].options.modal.ondismiss();
  assert.equal(b.windows[0].options.amount, 80300);
  f.state.cart[0].quantity = 3;
  await b.click();
  assert.equal(b.windows[1].options.amount, 222900);
  assert.notEqual(b.windows[0].options.order_id, b.windows[1].options.order_id);
  assert.deepEqual(f.state.orders.map(o => o.status), ['Cancelled', 'Payment Pending']);
  assert.match(b.element('coItems').innerHTML, /Qty: 3/);
  f.setPayment({ id: 'pay_replacement', order_id: f.state.orders[1].razorpay_order_id, amount: 222900 });
  await b.windows[1].options.handler(f.callback(2));
  assert.deepEqual(f.state.orders.map(o => o.status), ['Cancelled', 'Paid']);
  assert.equal(f.state.orders[1].items[0].quantity, 3);
  assert.deepEqual(f.effects, [2]); assert.equal(f.state.jobs.length, 1);
  assert.equal(b.element('successOrderId').textContent, 'Order #2');
});
