/* ============================================================
   checkout_cod.js – BrainyGrasp Production Checkout
   Handles: Auth gate, cart load, profile prefill, COD + Razorpay
   ============================================================ */

(() => {
const API_BASE = (window.BG_CONFIG && window.BG_CONFIG.API_BASE) || '';

// ── State ─────────────────────────────────────────────────────
let activeCart  = [];
let activeTotal = 0;
let activeSubtotal = 0;
let shipping    = 0;
let promoDiscount = 0;
let appliedPromoCode = '';
let paymentBusy = false;
let paymentResumeAllowed = false;
let serverQuote = null;
let currentTab  = 'profile'; // 'profile' | 'new'
let userProfile = null;

// ── Helpers ───────────────────────────────────────────────────
const esc = s => String(s)
  .replace(/&/g,'&amp;').replace(/</g,'&lt;')
  .replace(/>/g,'&gt;').replace(/"/g,'&quot;');

function showMsg(text, type = 'error') {
  const el = document.getElementById('coMsg');
  el.className = type;
  el.textContent = text;
  el.style.display = 'block';
  el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}
function clearMsg() {
  const el = document.getElementById('coMsg');
  el.style.display = 'none';
  el.textContent = '';
}

// ── Tab Switching ─────────────────────────────────────────────
window.switchTab = function(tab) {
  if (tab === 'new' && (readPaymentAttempt() || readCodAttempt())) {
    showMsg('The delivery address is saved with your pending checkout. Resume that checkout to check its status.', 'info');
    return;
  }
  currentTab = tab;
  document.getElementById('tabProfile').classList.toggle('active', tab === 'profile');
  document.getElementById('tabNew').classList.toggle('active', tab === 'new');
  document.getElementById('profileAddrPanel').style.display = tab === 'profile' ? 'block' : 'none';
  document.getElementById('newAddrPanel').style.display    = tab === 'new'     ? 'block' : 'none';
};

document.querySelectorAll('[data-checkout-tab]').forEach(button => {
  button.addEventListener('click', () => window.switchTab(button.dataset.checkoutTab));
});
document.getElementById('applyPromoBtn')?.addEventListener('click', () => window.applyPromo());
document.getElementById('promoInput')?.addEventListener('keydown', event => {
  if (event.key === 'Enter') {
    event.preventDefault();
    window.applyPromo();
  }
});
document.querySelectorAll('[data-promo-code]').forEach(btn => {
  if (!btn?.dataset?.promoCode) return;
  btn.addEventListener('click', () => {
    const input = document.getElementById('promoInput');
    if (input) input.value = btn.dataset.promoCode;
    window.applyPromo();
  });
});
document.getElementById('checkoutBackLink')?.addEventListener('click', event => {
  if (window.history.length > 1) {
    event.preventDefault();
    window.history.back();
  }
});

// ── Collect Address from active tab ───────────────────────────
function getAddress() {
  if (currentTab === 'profile') {
    return {
      name   : document.getElementById('codName').value.trim(),
      phone  : document.getElementById('codPhone').value.trim(),
      line1  : document.getElementById('codLine1').value.trim(),
      city   : document.getElementById('codCity').value.trim(),
      state  : document.getElementById('codState').value.trim(),
      pincode: document.getElementById('codPincode').value.trim(),
    };
  } else {
    return {
      name   : document.getElementById('newName').value.trim(),
      phone  : document.getElementById('newPhone').value.trim(),
      line1  : document.getElementById('newLine1').value.trim(),
      city   : document.getElementById('newCity').value.trim(),
      state  : document.getElementById('newState').value.trim(),
      pincode: document.getElementById('newPincode').value.trim(),
    };
  }
}

function validateAddress(a) {
  if (!a.name || !a.phone || !a.line1 || !a.city || !a.state || !a.pincode) {
    showMsg('⚠️ Please fill all delivery address fields.');
    return false;
  }
  a.phone = window.CustomerValidation.normalizePhone(a.phone);
  if (!a.phone) {
    showMsg('⚠️ Enter a valid 10-digit phone number.');
    return false;
  }
  if (!/^[1-9]\d{5}$/.test(a.pincode)) {
    showMsg('⚠️ Enter a valid 6-digit PIN code.');
    return false;
  }
  for (const [key, max] of Object.entries({ name: 100, line1: 255, city: 100, state: 100 })) {
    if (a[key].length > max) { showMsg(`Please shorten ${key} to ${max} characters.`); return false; }
  }
  return true;
}

// ── Render Order Summary ───────────────────────────────────────
function renderSummary() {
  const wrap = document.getElementById('coItems');
  const countBadge = document.getElementById('coItemCountBadge');
  if (!activeCart || !activeCart.length) {
    if (countBadge) countBadge.textContent = '0 items';
    wrap.innerHTML = `
      <div class="empty-cart">
        <i class="fas fa-shopping-bag"></i>
        <p>Your cart is empty.</p>
        <a href="index" style="color:var(--primary);font-weight:700">Continue Shopping</a>
      </div>`;
    document.getElementById('btnPlaceOrder').disabled = true;
    return false;
  }

  activeSubtotal = serverQuote?.subtotal ?? activeCart.reduce((s, i) => s + i.price * (i.quantity || 1), 0);
  shipping = serverQuote?.shipping ?? (activeSubtotal >= 999 ? 0 : 60);
  const promoPercent = { BRAINY10: 10, BRAINY15: 15 }[appliedPromoCode] || 0;
  promoDiscount = serverQuote?.discount ?? (appliedPromoCode === 'FLAT50' ? 50 : Math.round(activeSubtotal * promoPercent / 100));
  activeTotal = serverQuote?.total ?? (activeSubtotal + shipping - promoDiscount);
  if (activeTotal < 0) activeTotal = 0;

  const totalUnits = activeCart.reduce((sum, item) => sum + (item.quantity || 1), 0);
  if (countBadge) countBadge.textContent = `${totalUnits} item${totalUnits === 1 ? '' : 's'}`;

  const shipPct = Math.min(100, Math.round((activeSubtotal / 999) * 100));
  const shipBannerHTML = shipping === 0
    ? `<div class="co-ship-banner unlocked"><div class="co-ship-top"><i class="fas fa-check-circle"></i><span>You unlocked <strong>FREE delivery</strong>!</span></div><div class="co-ship-track"><div class="co-ship-fill" style="width:100%"></div></div></div>`
    : `<div class="co-ship-banner"><div class="co-ship-top"><i class="fas fa-truck"></i><span>Add <strong>₹${Math.max(0, 999 - activeSubtotal)}</strong> more for <strong>FREE delivery</strong></span></div><div class="co-ship-track"><div class="co-ship-fill" style="width:${shipPct}%"></div></div></div>`;

  const itemsHTML = activeCart.map(item => {
    const qty = item.quantity || 1;
    const thumb = item.image
      ? `<img class="oi-thumb" src="${esc(item.image)}" alt="${esc(item.name)}" data-image-fallback="cart">`
      : '';
    return `
      <div class="order-item-row">
        <div class="oi-left">
          ${thumb}
          <div class="oi-thumb-placeholder" style="${item.image ? 'display:none' : ''}"><i class="fas fa-puzzle-piece"></i></div>
          <div class="oi-details">
            <div class="oi-name">${esc(item.name)}</div>
            <div class="oi-qty">Qty: ${qty} × ₹${item.price}</div>
          </div>
        </div>
        <div class="oi-price">₹${item.price * qty}</div>
      </div>`;
  }).join('');

  const shippingHTML = shipping === 0
    ? '<span class="free-ship">FREE</span>'
    : `₹${shipping}`;

  const discountRow = promoDiscount > 0
    ? `<div class="tot-row tot-discount"><span>Promo Discount${appliedPromoCode ? ` (${esc(appliedPromoCode)})` : ''}</span><span>− ₹${promoDiscount}</span></div>`
    : '';

  wrap.innerHTML = `
    ${shipBannerHTML}
    <div class="oi-list">${itemsHTML}</div>
    <div class="totals-block">
      <div class="tot-row"><span>Items Subtotal (${totalUnits} item${totalUnits > 1 ? 's' : ''})</span><span>₹${activeSubtotal}</span></div>
      <div class="tot-row"><span>Delivery</span><span>${shippingHTML}</span></div>
      ${discountRow}
      <div class="tot-row grand"><span>Total Payable</span><span style="color:var(--orange)">₹${activeTotal}</span></div>
    </div>`;

  return true;
}

// ── Promo Code (stub — extend with real API) ───────────────────
window.applyPromo = function() {
  if (paymentBusy || readPaymentAttempt() || readCodAttempt()) { showMsg('Resume your existing checkout before changing the promo code.', 'info'); return; }
  serverQuote = null;
  const code   = document.getElementById('promoInput').value.trim().toUpperCase();
  const msgEl  = document.getElementById('promoMsg');
  const PROMOS = { 'BRAINY10': 10, 'BRAINY15': 15, 'FLAT50': 50 };

  appliedPromoCode = '';
  if (!code) { promoDiscount = 0; msgEl.style.display = 'none'; renderSummary(); return; }

  if (Object.hasOwn(PROMOS, code)) {
    appliedPromoCode = code;
    // percentage if ≤ 20, flat otherwise
    if (PROMOS[code] <= 20) {
      promoDiscount = Math.round(activeSubtotal * PROMOS[code] / 100);
      msgEl.textContent = `✅ ${PROMOS[code]}% off applied! You save ₹${promoDiscount}`;
    } else {
      promoDiscount = PROMOS[code];
      msgEl.textContent = `✅ Flat ₹${promoDiscount} off applied!`;
    }
    msgEl.style.color   = 'var(--green-dark)';
    msgEl.style.display = 'block';
  } else {
    promoDiscount = 0;
    msgEl.textContent   = '❌ Invalid promo code.';
    msgEl.style.color   = '#c53030';
    msgEl.style.display = 'block';
  }
  renderSummary();
};

// ── Profile Prefill ────────────────────────────────────────────
function fillProfile(u) {
  userProfile = u;
  const name = typeof u.name === 'string' ? u.name : '';
  document.getElementById('profileInitial').textContent = (name || 'U')[0].toUpperCase();
  document.getElementById('profileName').textContent = name || 'Your Name';
  document.getElementById('profileEmail').textContent = typeof u.email === 'string' ? u.email : '';
  const fields = { codName: 'name', codPhone: 'phone', codLine1: 'address', codCity: 'city', codState: 'state', codPincode: 'pincode' };
  for (const [id, key] of Object.entries(fields)) {
    const field = document.getElementById(id);
    field.value = typeof u[key] === 'string' ? u[key] : '';
    field.classList.toggle('prefilled', Boolean(field.value));
  }
}

function cachedProfileFor(token) {
  try {
    // This only selects the account's local cache; API authentication remains
    // server-side. Never use another account's cached delivery address.
    const encoded = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    const claims = JSON.parse(atob(encoded.padEnd(Math.ceil(encoded.length / 4) * 4, '=')));
    const cached = JSON.parse(localStorage.getItem('bg_user') || 'null');
    if (!Number.isSafeInteger(claims.id) || claims.id <= 0 || cached?.id !== claims.id ||
        !Number.isFinite(claims.exp) || claims.exp * 1000 <= Date.now()) return null;
    return cached;
  } catch { return null; }
}

function profileNotice(message) {
  const notice = document.getElementById('profileLoadNotice');
  notice.textContent = message;
  notice.style.display = message ? 'block' : 'none';
}

async function prefillProfile(token) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  const sameSession = () => localStorage.getItem('bg_token') === token;
  const sessionChanged = () => {
    profileNotice('Your sign-in changed while checkout was loading. Refresh to load the correct profile.');
    return false;
  };
  try {
    const res = await fetch(`${API_BASE}/api/auth/me`, {
      headers: { 'Authorization': `Bearer ${token}` },
      cache: 'no-store', signal: controller.signal
    });
    if (!sameSession()) return sessionChanged();
    if (res.status === 401 || res.status === 403) {
      if (window.AuthUnified?.clearAuth) window.AuthUnified.clearAuth();
      else {
        localStorage.removeItem('bg_token');
        localStorage.removeItem('bg_user');
      }
      localStorage.setItem('redirectAfterLogin', 'checkout');
      window.location.href = 'login';
      return false;
    }
    if (!res.ok) throw Object.assign(new Error('Profile could not load'), { status: res.status });
    const u = await res.json();
    if (!sameSession()) return sessionChanged();
    if (!u || !Number.isSafeInteger(u.id) || u.id <= 0) throw new Error('Invalid profile response');
    localStorage.setItem('bg_user', JSON.stringify(u));
    fillProfile(u);
    profileNotice('');
    return true;
  } catch (e) {
    if (!sameSession()) return sessionChanged();
    const cached = e.status === 404 ? null : cachedProfileFor(token);
    if (cached) {
      fillProfile(cached);
      profileNotice('Your latest profile could not load. Showing your saved profile; please review and complete the delivery address before ordering. Refresh to try again.');
      return true;
    }
    document.getElementById('profileName').textContent = 'Profile unavailable';
    profileNotice('Your profile could not load and no matching saved profile is available. Please refresh to retry before checking out.');
    return false;
  } finally { clearTimeout(timer); }
}

// ── Load Cart (DB-first) ───────────────────────────────────────
async function loadCart(token) {
  activeCart = await window.CartSync.flush();
}

// ── Save Address → Create Order ────────────────────────────────
async function apiRequest(path, token, body) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25000);
  try {
    const res = await fetch(`${API_BASE}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: controller.signal, cache: 'no-store'
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(data.error || 'Checkout request failed. Please try again.');
      err.status = res.status;
      err.checkoutRejected = data.checkout_rejected === true;
      throw err;
    }
    return data;
  } catch (err) {
    if (err.name === 'AbortError') throw new Error('The request timed out. Check the same order again before making another payment.');
    throw err;
  } finally { clearTimeout(timer); }
}

function paymentStorageKey() {
  return userProfile?.id ? `bg_payment_checkout_${userProfile.id}` : null;
}
function readPaymentAttempt() {
  const key = paymentStorageKey();
  if (!key) return null;
  try { return JSON.parse(localStorage.getItem(key) || 'null'); } catch { return null; }
}
function codStorageKey() { return userProfile?.id ? `bg_cod_checkout_${userProfile.id}` : null; }
function readCodAttempt() {
  const key = codStorageKey();
  try { return key ? JSON.parse(localStorage.getItem(key) || 'null') : null; } catch { return null; }
}
function savePaymentAttempt(attempt) {
  const key = paymentStorageKey();
  if (!key) throw new Error('Please sign in again before making a payment.');
  localStorage.setItem(key, JSON.stringify(attempt));
  restoreSavedAddress(attempt);
}
function restoreSavedAddress(attempt) {
  const fields = { codName: 'name', codPhone: 'phone', codLine1: 'line1', codCity: 'city', codState: 'state', codPincode: 'pincode' };
  for (const [id, key] of Object.entries(fields)) {
    const field = document.getElementById(id);
    if (attempt?.address) field.value = attempt.address[key] || '';
    field.readOnly = Boolean(attempt);
  }
  document.getElementById('promoInput').disabled = Boolean(attempt);
  document.getElementById('tabNew').disabled = Boolean(attempt);
  // A pending Razorpay checkout must not lock the customer into online payment.
  // They can cancel that attempt and place the same current basket as COD.
  document.querySelectorAll('input[name="payMethod"]').forEach(radio => { radio.disabled = false; });
  if (attempt) window.switchTab('profile');
}
function resetPaymentButton() {
  paymentBusy = false;
  const btn = document.getElementById('btnPlaceOrder');
  btn.disabled = !activeCart.length && !readPaymentAttempt() && !readCodAttempt();
  updatePayBtn();
  if (readCodAttempt()) btn.textContent = 'Resume / Confirm Existing COD Order';
}
async function saveAddress(token, addr) {
  return apiRequest('/api/addresses', token, {
    full_name: addr.name, phone: addr.phone, line1: addr.line1,
    city: addr.city, state: addr.state, pincode: addr.pincode
  });
}
async function refreshCartAfterOrder(token) {
  // The server removes only purchased quantities; drain newer edits safely.
  try {
    await window.CartSync.flush();
  } catch { /* The next page will fetch the server cart. */ }
}
async function finishOnlineOrder(token, order) {
  const key = paymentStorageKey();
  if (key) localStorage.removeItem(key);
  paymentBusy = true;
  document.getElementById('btnPlaceOrder').disabled = true;
  await refreshCartAfterOrder(token);
  showSuccess(order.id, 'Online payment confirmed. Your order is confirmed.');
}
function showSavedQuote(order) {
  paymentResumeAllowed = !order.pending && order.resumable === true;
  serverQuote = order;
  activeCart = order.items;
  appliedPromoCode = order.promo_code || '';
  renderSummary();
}

function discardStalePayment(order) {
  const key = paymentStorageKey();
  if (key) localStorage.removeItem(key);
  restoreSavedAddress(null);
  showSavedQuote(order.current_cart);
  updatePayBtn();
  showMsg('Your cart changed. The previous unpaid order was cancelled. Checkout now uses your current cart.', 'info');
}

async function placeOrder(token, payMethod) {
  if (payMethod !== 'cod' || paymentBusy) return null;
  const onlineAttempt = readPaymentAttempt();
  if (onlineAttempt?.id) {
    try {
      const result = await apiRequest(`/api/payment/orders/${onlineAttempt.id}/abandon`, token, {});
      if (result.paid) {
        await finishOnlineOrder(token, result);
        return null;
      }
      if (result.pending || result.review_required) {
        showMsg(result.review_message || `Order #${onlineAttempt.id} still has an online payment in progress. Check its status before placing a COD order.`);
        return null;
      }
      if (!result.cancelled) throw new Error('The online checkout could not be cancelled. Please check its payment status and retry.');
      const key = paymentStorageKey();
      if (key) localStorage.removeItem(key);
      restoreSavedAddress(null);
    } catch (err) {
      showMsg(err.message);
      return null;
    }
  } else if (onlineAttempt) {
    // No order was created yet, so discard only the local draft.
    const key = paymentStorageKey();
    if (key) localStorage.removeItem(key);
    restoreSavedAddress(null);
  }
  let attempt = readCodAttempt();
  const addr = attempt?.address || getAddress();
  if (!validateAddress(addr)) return null;
  paymentBusy = true;
  const btn = document.getElementById('btnPlaceOrder');
  btn.disabled = true;
  btn.textContent = 'Processing...';
  try {
    if (!attempt) {
      await loadCart(token);
      serverQuote = null;
      if (!renderSummary()) throw new Error('Your cart is empty. Add items before checking out.');
      const address = await saveAddress(token, addr);
      attempt = { address: addr, items: activeCart, total: activeTotal, request: {
        checkout_key: crypto.randomUUID(), address_id: address.id,
        items: activeCart.map(item => ({ id: item.id, quantity: item.quantity || 1 })),
        promo_code: appliedPromoCode, expected_total: activeTotal,
        payment_method: 'cod', affiliate_ref: localStorage.getItem('bg_ref') || null
      } };
      if (!codStorageKey()) throw new Error('Please sign in again before ordering.');
      localStorage.setItem(codStorageKey(), JSON.stringify(attempt));
      restoreSavedAddress(attempt);
    }
    const order = await apiRequest('/api/orders', token, attempt.request);
    localStorage.removeItem(codStorageKey());
    await refreshCartAfterOrder(token);
    activeCart = [];
    return order.id;
  } catch (err) {
    if (err.status === 400 || err.checkoutRejected) {
      localStorage.removeItem(codStorageKey());
      restoreSavedAddress(null);
    }
    showMsg(err.message);
    resetPaymentButton();
    return null;
  }
}

function currentPayMethod() {
  return document.querySelector('input[name="payMethod"]:checked')?.value || 'cod';
}

// ── Success Overlay ────────────────────────────────────────────
function showSuccess(orderId, payNote) {
  document.getElementById('successOrderId').textContent  = `Order #${orderId}`;
  document.getElementById('successPayNote').textContent  = payNote;
  document.getElementById('successOverlay').style.display = 'flex';
  document.getElementById('stepConfirm').classList.add('active');
  // Animate progress bar then redirect
  requestAnimationFrame(() => {
    document.getElementById('redirectFill').style.width = '100%';
  });
  setTimeout(() => window.location.href = 'dashboard', 3200);
}

// ── Payment Method UI Toggle ───────────────────────────────────
function updatePayBtn() {
  const saved = readPaymentAttempt();
  const savedCod = readCodAttempt();
  if (savedCod) document.querySelector('input[name="payMethod"][value="cod"]').checked = true;
  const method = savedCod ? 'cod' : currentPayMethod();
  const btn    = document.getElementById('btnPlaceOrder');
  if (method === 'razorpay') {
    btn.className   = 'btn-place btn-rzp';
    btn.innerHTML   = '<i class="fas fa-bolt"></i> Pay Now with Razorpay';
    document.getElementById('codInfoBox').style.display = 'none';
    document.getElementById('rzpInfoBox').style.display = 'flex';
  } else {
    btn.className   = 'btn-place btn-cod';
    btn.innerHTML   = '<i class="fas fa-check-circle"></i> Place Order (Cash on Delivery)';
    document.getElementById('codInfoBox').style.display = 'flex';
    document.getElementById('rzpInfoBox').style.display = 'none';
  }
  if (saved && method === 'razorpay') btn.textContent = paymentResumeAllowed ? 'Resume / Check Existing Payment' : 'Check Existing Payment';
  if (savedCod) btn.textContent = 'Resume / Confirm Existing COD Order';
}

// ── Razorpay Flow ──────────────────────────────────────────────
async function startRazorpay(token) {
  if (paymentBusy) return;
  if (readCodAttempt()) { showMsg('Resume your existing COD order before starting another checkout.'); return; }
  let attempt = readPaymentAttempt();
  const addr = attempt?.address || getAddress();
  if (!validateAddress(addr)) return;
  paymentBusy = true;
  const btn = document.getElementById('btnPlaceOrder');
  btn.disabled = true;
  btn.textContent = 'Checking payment...';
  paymentResumeAllowed = false;
  try {
    if (typeof Razorpay !== 'function') throw new Error('The payment window could not load. Please refresh and try again.');
    // Flush edits even when a saved payment exists; the server compares against
    // this database cart before returning any reusable gateway order.
    await loadCart(token);
    let order;
    for (let tries = 0; tries < 2; tries++) {
      if (!attempt) {
        serverQuote = null;
        if (!renderSummary()) throw new Error('Your cart is empty. Add items before checking out.');
        const address = await saveAddress(token, addr);
        attempt = {
          address: addr,
          request: {
            checkout_key: crypto.randomUUID(), address_id: address.id,
            items: activeCart.map(item => ({ id: item.id, quantity: item.quantity || 1 })),
            promo_code: appliedPromoCode, affiliate_ref: localStorage.getItem('bg_ref') || null
          }
        };
        // Persist before sending so network retries use the same request key.
        savePaymentAttempt(attempt);
      }
      order = attempt.id
        ? await apiRequest(`/api/payment/orders/${attempt.id}`, token)
        : await apiRequest('/api/payment/create-order', token, attempt.request);
      if (order.stale) {
        discardStalePayment(order);
        attempt = null;
        continue;
      }
      attempt.id = order.id;
      savePaymentAttempt(attempt);
      // Check again immediately before opening checkout, including after a lost response.
      if (!order.paid) order = await apiRequest(`/api/payment/orders/${order.id}`, token);
      if (order.stale) {
        discardStalePayment(order);
        attempt = null;
        continue;
      }
      break;
    }
    if (order.stale) throw new Error('Your cart changed again. Review the updated cart and retry checkout.');
    if (order.review_required) throw new Error(order.review_message);
    if (order.paid) { await finishOnlineOrder(token, order); return; }
    showSavedQuote(order);
    if (order.pending) {
      showMsg(`Payment for Order #${order.id} is awaiting confirmation. Check its status again; please do not pay again.`, 'info');
      resetPaymentButton();
      return;
    }
    if (!order.resumable) throw new Error('This order cannot be resumed. Please check its payment status.');
    let completing = false;
    const rzp = new Razorpay({
      key: order.key, amount: order.amount, currency: order.currency, order_id: order.orderId,
      name: 'BrainyGrasp', description: `Order #${order.id}`,
      prefill: { name: addr.name, contact: addr.phone, email: userProfile?.email || '' },
      theme: { color: '#667eea' },
      modal: { ondismiss: () => {
        if (completing) return;
        showMsg(`Checkout closed. Resume Order #${order.id} to check its status or retry.`, 'info');
        resetPaymentButton();
      } },
      handler: async response => {
        completing = true;
        paymentBusy = true;
        btn.disabled = true;
        btn.textContent = 'Verifying payment...';
        try {
          const verified = await apiRequest('/api/payment/verify', token, {
            order_id: order.id, razorpay_order_id: response.razorpay_order_id,
            razorpay_payment_id: response.razorpay_payment_id, razorpay_signature: response.razorpay_signature
          });
          if (verified.paid) { await finishOnlineOrder(token, verified); return; }
          if (verified.review_required) throw new Error(verified.review_message);
          showMsg(`Payment for Order #${order.id} is awaiting capture. Check its status again; please do not pay again.`, 'info');
        } catch (err) {
          showMsg(`${err.message} Order #${order.id}; payment reference: ${response.razorpay_payment_id}. Resume this order to check its status.`);
        }
        resetPaymentButton();
      }
    });
    rzp.on('payment.failed', () => {
      showMsg(`The payment attempt did not complete. You can retry in the payment window, or resume Order #${order.id} later.`);
    });
    rzp.open();
  } catch (err) {
    if (!attempt?.id && (err.status === 400 || err.checkoutRejected)) {
      const key = paymentStorageKey();
      if (key) localStorage.removeItem(key);
      restoreSavedAddress(null);
    }
    showMsg(err.message);
    resetPaymentButton();
  }
}

document.addEventListener('DOMContentLoaded', async () => {

  // 1. Auth gate
  const token = localStorage.getItem('bg_token');
  if (!token) {
    localStorage.setItem('redirectAfterLogin', 'checkout');
    window.location.href = 'login';
    return;
  }

  // 2. Parallel load: profile + cart
  let profileOk;
  try {
    [profileOk] = await Promise.all([prefillProfile(token), loadCart(token)]);
  } catch (err) {
    showMsg('Your cart could not sync. Your changes are saved on this device. Refresh to retry.');
    document.getElementById('btnPlaceOrder').disabled = true;
    return;
  }
  if (profileOk === false) {
    document.getElementById('btnPlaceOrder').disabled = true;
    return;
  }

  // Recover after reload even when the webhook already removed purchased cart items.
  let savedAttempt = readPaymentAttempt();
  const savedCod = readCodAttempt();
  if (savedCod) {
    restoreSavedAddress(savedCod);
    activeCart = savedCod.items || [];
    serverQuote = { total: savedCod.total };
    updatePayBtn();
    showMsg('A COD checkout is saved. Resume it to confirm the same order without creating a duplicate.', 'info');
  }
  if (savedAttempt) {
    restoreSavedAddress(savedAttempt);
    const radio = document.querySelector('input[name="payMethod"][value="razorpay"]');
    if (radio) radio.checked = true;
    updatePayBtn();
    try {
      const order = savedAttempt.id
        ? await apiRequest(`/api/payment/orders/${savedAttempt.id}`, token)
        : await apiRequest('/api/payment/create-order', token, savedAttempt.request);
      if (order.paid) { await finishOnlineOrder(token, order); return; }
      if (order.stale) {
        discardStalePayment(order);
        savedAttempt = null;
      } else {
        savedAttempt.id = order.id;
        savePaymentAttempt(savedAttempt);
        showSavedQuote(order);
        showMsg(order.resumable
          ? `Resume your saved Order #${order.id}. Its cart is unchanged.`
          : order.review_message || `Payment for Order #${order.id} is awaiting confirmation. Check its status; please do not pay again.`, 'info');
      }
    } catch (err) { showMsg(err.message); }
  }


  // 3. Render order summary
  const hasItems = renderSummary();
  if (!hasItems && !savedAttempt && !savedCod) return; // empty cart

  if (savedAttempt || savedCod) resetPaymentButton();

  // 4. Payment method radio toggle
  document.querySelectorAll('input[name="payMethod"]').forEach(r => {
    r.addEventListener('change', () => { clearMsg(); updatePayBtn(); });
  });

  // 5. Place Order button - Shows confirmation modal for COD
  document.getElementById('btnPlaceOrder').addEventListener('click', async () => {
    if (paymentBusy) return;
    clearMsg();
    const method = readCodAttempt() ? 'cod' : currentPayMethod();

    const addr = readPaymentAttempt()?.address || readCodAttempt()?.address || getAddress();
    if (!validateAddress(addr)) return;

    if (method === 'cod') {
      // Show confirmation dialog before booking
      const namePhone = `${addr.name} (${addr.phone})`;
      const fullAddress = `${addr.line1}, ${addr.city}, ${addr.state} - ${addr.pincode}`;
      
      const elName = document.getElementById('confirmNamePhone');
      const elAddr = document.getElementById('confirmAddressLine');
      const elTotal = document.getElementById('confirmTotalPayable');
      const elOverlay = document.getElementById('confirmOverlay');

      if (elName) elName.textContent = namePhone;
      if (elAddr) elAddr.textContent = fullAddress;
      if (elTotal) elTotal.textContent = `₹${activeTotal}`;
      if (elOverlay) elOverlay.style.display = 'flex';
    } else {
      await startRazorpay(token);
    }
  });

  // Modal Cancel listener
  const cancelBtn = document.getElementById('btnCancelConfirm');
  if (cancelBtn) {
    cancelBtn.addEventListener('click', () => {
      const elOverlay = document.getElementById('confirmOverlay');
      if (elOverlay) elOverlay.style.display = 'none';
    });
  }

  // Backdrop click listener
  const confirmOverlayEl = document.getElementById('confirmOverlay');
  if (confirmOverlayEl) {
    confirmOverlayEl.addEventListener('click', (e) => {
      if (e.target === confirmOverlayEl) {
        confirmOverlayEl.style.display = 'none';
      }
    });
  }

  // Modal Final Confirm listener
  const finalConfirmBtn = document.getElementById('btnFinalConfirmOrder');
  if (finalConfirmBtn) {
    finalConfirmBtn.addEventListener('click', async () => {
      const elOverlay = document.getElementById('confirmOverlay');
      
      finalConfirmBtn.disabled = true;
      finalConfirmBtn.innerHTML = '<i class="fas fa-circle-notch fa-spin"></i> Confirming...';

      const orderId = await placeOrder(token, 'cod');
      
      finalConfirmBtn.disabled = false;
      finalConfirmBtn.innerHTML = '<i class="fas fa-check-circle"></i> Confirm Order';

      if (elOverlay) elOverlay.style.display = 'none';
      if (orderId) {
        showSuccess(orderId, '🏠 Pay cash when your order arrives at your door.');
      }
    });
  }

  // 6. Live form validation feedback
  ['codPhone', 'newPhone'].forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener('input', () => {
      el.style.borderColor = window.CustomerValidation.normalizePhone(el.value) ? 'var(--green)' : '';
    });
  });
  ['codPincode', 'newPincode'].forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener('input', () => {
      el.style.borderColor = /^[1-9]\d{5}$/.test(el.value) ? 'var(--green)' : '';
    });
  });
});
})();
