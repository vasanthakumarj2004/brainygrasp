/* Durable, account-scoped cart changes. Requests may be retried safely. */
(() => {
  const read = (key, fallback) => {
    try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
  };
  const userId = () => {
    const id = read('bg_user', null)?.id;
    return localStorage.getItem('bg_token') && id ? String(id) : null;
  };
  function uuid() {
    return crypto.randomUUID ? crypto.randomUUID() : '10000000-1000-4000-8000-100000000000'.replace(/[018]/g,
      c => (Number(c) ^ crypto.getRandomValues(new Uint8Array(1))[0] & 15 >> Number(c) / 4).toString(16));
  }
  function owner() {
    let value = localStorage.getItem('bg_cart_owner');
    if (!value) {
      // Existing signed-in carts are account snapshots, not guest additions.
      value = read('bg_user', null)?.id?.toString() || `${read('bg_cart', []).length ? 'legacy' : 'guest'}:${uuid()}`;
      localStorage.setItem('bg_cart_owner', value);
    }
    return value;
  }
  const prefix = id => `bg_cart_change_${id}_`;
  function pending(id) {
    const keys = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key?.startsWith(prefix(id))) keys.push(key);
    }
    return keys.map(key => ({ key, ...read(key, {}) })).sort((a, b) => a.created - b.created || a.key.localeCompare(b.key));
  }
  function enqueue(id, changes, mutationId = uuid()) {
    if (!changes.length) return;
    const key = prefix(id) + mutationId;
    const created = Math.max(Date.now(), ...pending(id).map(change => change.created + 1));
    if (!localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify({ created, mutation_id: mutationId, changes }));
  }
  function adopt(cart) {
    localStorage.setItem('bg_cart', JSON.stringify(cart));
    window.updateCartCount?.();
    window.renderCartPage?.();
  }
  function claim() {
    const id = userId();
    if (!id) return;
    const previous = owner();
    if (previous === id) return;
    if (/^(guest|legacy):/.test(previous)) {
      // Reuse the guest basket ID across a crash or a lost response.
      // Old unowned baskets are ambiguous: preserve the larger quantity once.
      enqueue(id, read('bg_cart', []).map(item => ({ id: Number(item.id),
        [previous.startsWith('legacy:') ? 'minimum' : 'delta']: Number(item.quantity) || 1 })), previous.split(':')[1]);
    } else {
      // Never import another account's cached cart.
      localStorage.setItem('bg_cart', '[]');
    }
    localStorage.setItem('bg_cart_owner', id);
  }
  function edit(change) {
    const id = userId();
    if (id) claim();
    else if (!/^(guest|legacy):/.test(owner())) {
      localStorage.setItem('bg_cart_owner', `guest:${uuid()}`);
      localStorage.setItem('bg_cart', '[]');
    }
    const before = read('bg_cart', []);
    const after = change(before.map(item => ({ ...item })));
    const quantities = new Map(before.map(item => [Number(item.id), -(Number(item.quantity) || 1)]));
    for (const item of after) quantities.set(Number(item.id), (quantities.get(Number(item.id)) || 0) + (Number(item.quantity) || 1));
    // Persist the change before starting the network request or updating the UI.
    if (id) enqueue(id, [...quantities].filter(([, delta]) => delta).map(([id, delta]) => ({ id, delta })));
    adopt(after);
    if (id) void sync();
  }
  async function request(token, mutation) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
      const res = await fetch(`${window.BG_CONFIG?.API_BASE || ''}/api/cart${mutation ? '/sync' : ''}`, {
        method: mutation ? 'POST' : 'GET', cache: 'no-store', signal: controller.signal,
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        ...(mutation ? { body: JSON.stringify({ mutation_id: mutation.mutation_id, changes: mutation.changes }) } : {})
      });
      const data = await res.json();
      if (!res.ok) throw Object.assign(new Error(data.error || 'Cart could not be saved'), { status: res.status, token });
      const cart = mutation ? data.cart : data;
      if (!Array.isArray(cart)) throw new Error('Invalid cart response');
      return cart;
    } finally { clearTimeout(timer); }
  }
  let running = null;
  async function drain() {
    claim();
    const id = userId(), token = localStorage.getItem('bg_token');
    if (!id) throw new Error('Please sign in to save your cart');
    const checkSession = () => {
      if (userId() !== id || localStorage.getItem('bg_token') !== token) throw new Error('Your sign-in changed. Please retry.');
    };
    let cart;
    while (true) {
      checkSession();
      const mutation = pending(id)[0];
      cart = await request(token, mutation);
      checkSession();
      if (mutation) localStorage.removeItem(mutation.key);
      if (!pending(id).length) break;
    }
    if (owner() === id) adopt(cart);
    return cart;
  }
  function flush() {
    if (!running) {
      // Serialize across tabs where Web Locks are available; database locks and
      // mutation receipts also protect other browsers and fallback clients.
      const task = () => drain();
      running = (window.navigator?.locks ? window.navigator.locks.request('brainygrasp-cart', task) : task())
        .finally(() => { running = null; });
    }
    return running;
  }
  async function sync() {
    try { await flush(); return true; }
    catch (err) {
      if ([401, 403].includes(err.status) && localStorage.getItem('bg_token') === err.token) {
        localStorage.removeItem('bg_token');
        localStorage.removeItem('bg_user');
      }
      window.showAuthError?.('cartSaveNotice', `Your cart changes are saved on this device but could not sync. ${err.message}. Retry checkout when connected.`);
      return false;
    }
  }
  function clearLocal() {
    // Outstanding account changes remain available for that account's next login.
    localStorage.removeItem('bg_cart');
    localStorage.setItem('bg_cart_owner', `guest:${uuid()}`);
  }
  owner();
  window.CartSync = { edit, flush, sync, claim, clearLocal };
  window.addEventListener('online', () => { if (userId()) void sync(); });
  document.addEventListener('DOMContentLoaded', () => { if (userId()) void sync(); });
})();
