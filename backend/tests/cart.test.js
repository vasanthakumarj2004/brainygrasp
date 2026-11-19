'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { applyMutation } = require('../cartService');

const toy = quantity => ({ id: 1, name: 'Toy', price: 500, image: 'toy.png', quantity });
const mutation = changes => ({ mutation_id: crypto.randomUUID(), changes });

// Transactions and row locking are simulated; no customer records are touched.
function database(initial = []) {
  const state = { cart: initial, receipts: {}, failReceipt: false };
  let chain = Promise.resolve();
  const pool = { async connect() {
    let release, snapshot;
    return { async query(sql, args = []) {
      if (sql === 'BEGIN') {
        const before = chain; chain = new Promise(resolve => { release = resolve; }); await before;
        snapshot = structuredClone({ cart: state.cart, receipts: state.receipts }); return { rows: [] };
      }
      if (sql === 'COMMIT' || sql === 'ROLLBACK') {
        if (sql === 'ROLLBACK') Object.assign(state, snapshot);
        release(); return { rows: [] };
      }
      if (sql.startsWith('SELECT cart')) return { rows: [{ cart: structuredClone(state.cart) }] };
      if (sql.startsWith('SELECT fingerprint')) return { rows: state.receipts[args[1]] ? [{ fingerprint: state.receipts[args[1]] }] : [] };
      if (sql.startsWith('SELECT id, name')) return { rows: [toy(1)].filter(p => args[0].includes(p.id)) };
      if (sql.startsWith('UPDATE users')) { state.cart = JSON.parse(args[0]); return { rows: [] }; }
      if (sql.startsWith('INSERT INTO cart_mutations')) {
        if (state.failReceipt) throw new Error('Database write failed');
        state.receipts[args[1]] = args[2]; return { rows: [] };
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    }, release() {} };
  } };
  return { state, pool, apply: input => applyMutation(pool, 1, input) };
}

test('cart retries apply once, including concurrent duplicate requests', async () => {
  const db = database([toy(2)]), input = mutation([{ id: 1, delta: 1 }]);
  await Promise.all([db.apply(input), db.apply(input)]);
  assert.equal(db.state.cart[0].quantity, 3);
  assert.equal(Object.keys(db.state.receipts).length, 1);
});

test('independent cart changes preserve other browser updates', async () => {
  const db = database([toy(2)]);
  await Promise.all([db.apply(mutation([{ id: 1, delta: 1 }])), db.apply(mutation([{ id: 1, delta: 2 }]))]);
  assert.equal(db.state.cart[0].quantity, 5);
  await db.apply(mutation([{ id: 1, delta: -2 }]));
  assert.equal(db.state.cart[0].quantity, 3);
});

test('cart mutation receipt and quantity roll back together', async () => {
  const db = database([toy(2)]), input = mutation([{ id: 1, delta: 1 }]);
  db.state.failReceipt = true;
  await assert.rejects(db.apply(input));
  assert.equal(db.state.cart[0].quantity, 2);
  assert.equal(Object.keys(db.state.receipts).length, 0);
  db.state.failReceipt = false;
  await db.apply(input);
  assert.equal(db.state.cart[0].quantity, 3);
});

test('a retry after checkout cannot resurrect purchased quantities', async () => {
  const db = database(), input = mutation([{ id: 1, delta: 2 }]);
  await db.apply(input);
  db.state.cart = []; // A committed checkout removed the purchased items.
  assert.deepEqual(await db.apply(input), []);
});

test('legacy cart reconciliation preserves quantities without adding them twice', async () => {
  const db = database([toy(2)]);
  await db.apply(mutation([{ id: 1, minimum: 2 }]));
  assert.equal(db.state.cart[0].quantity, 2);
  await db.apply(mutation([{ id: 1, minimum: 3 }]));
  assert.equal(db.state.cart[0].quantity, 3);
});

test('cart API rejects old snapshot writes, bad quantities and reused request IDs', async () => {
  const db = database([toy(2)]), input = mutation([{ id: 1, delta: 1 }]);
  await assert.rejects(db.apply({ items: [] }), { status: 400 });
  await assert.rejects(db.apply(mutation([{ id: 1, delta: 101 }])), { status: 400 });
  await assert.rejects(db.apply(mutation([{ id: 1, delta: 1 }, { id: 1, delta: 2 }])), { status: 400 });
  await db.apply(input);
  await assert.rejects(db.apply({ ...input, changes: [{ id: 1, delta: 2 }] }), { status: 409 });
});

function browser({ db = database(), storage = new Map(), signedIn = true, fetchHook } = {}) {
  if (signedIn && !storage.has('bg_token')) {
    storage.set('bg_token', 'token-1'); storage.set('bg_user', JSON.stringify({ id: 1 }));
  }
  const localStorage = { get length() { return storage.size; }, key: i => [...storage.keys()][i],
    getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) };
  const calls = [], notices = [], events = {};
  const window = { BG_CONFIG: { API_BASE: '' }, showAuthError: (_, text) => notices.push(text),
    addEventListener: (event, fn) => { events[event] = fn; } };
  const context = { window, localStorage, crypto, Uint8Array, AbortController, setTimeout, clearTimeout,
    document: { addEventListener() {} }, fetch: async (url, options) => {
      const input = options.body ? JSON.parse(options.body) : null;
      calls.push(input);
      const result = input ? await db.apply(input) : structuredClone(db.state.cart);
      const override = await fetchHook?.(input, result);
      return override || { ok: true, json: async () => input ? { cart: result } : result };
    } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../frontend/js/cart-sync.js'), 'utf8'), context);
  return { api: window.CartSync, context, db, calls, notices, storage, events,
    cart: () => JSON.parse(storage.get('bg_cart') || '[]'),
    pending: () => [...storage.keys()].filter(k => k.startsWith('bg_cart_change_')),
    login: id => { storage.set('bg_token', `token-${id}`); storage.set('bg_user', JSON.stringify({ id })); } };
}

test('re-login keeps a saved quantity of two at two', async () => {
  const b = browser({ db: database([toy(2)]), storage: new Map([['bg_cart', JSON.stringify([toy(2)])]]) });
  await b.api.flush();
  b.login(1); await b.api.flush();
  assert.equal(b.cart()[0].quantity, 2);
  assert.equal(b.calls.filter(Boolean).length, 0);
});

test('new guest additions merge once, including reload after a lost response', async () => {
  let lose = true;
  const b = browser({ signedIn: false, db: database([toy(2)]), fetchHook: input => {
    if (input && lose) { lose = false; throw new Error('Response lost'); }
  } });
  b.api.edit(() => [toy(1)]); b.login(1);
  assert.equal(await b.api.sync(), false);
  assert.equal(b.pending().length, 1);
  const reloaded = browser({ db: b.db, storage: b.storage });
  await reloaded.api.flush();
  assert.equal(reloaded.cart()[0].quantity, 3);
  assert.equal(reloaded.pending().length, 0);
});

test('rapid edits while a save is delayed are serialized and all reach the server', async () => {
  let release;
  const wait = new Promise(resolve => { release = resolve; });
  const b = browser({ fetchHook: async input => { if (input) await wait; } });
  b.api.edit(() => [toy(1)]);
  b.api.edit(() => [toy(2)]);
  b.api.edit(() => [toy(3)]);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(b.calls.length, 1);
  release(); await b.api.flush();
  assert.equal(b.db.state.cart[0].quantity, 3);
  assert.equal(b.cart()[0].quantity, 3);
  assert.equal(b.pending().length, 0);
});

test('failed HTTP saves keep pending changes and notify the user', async () => {
  const b = browser({ fetchHook: () => ({ ok: false, json: async () => ({ error: 'Service unavailable' }) }) });
  b.api.edit(() => [toy(1)]);
  assert.equal(await b.api.sync(), false);
  assert.equal(b.pending().length, 1);
  assert.equal(b.cart()[0].quantity, 1);
  assert.match(b.notices[0], /could not sync/);
});

test('a delayed cart read cannot overwrite edits made while it was loading', async () => {
  let release;
  const wait = new Promise(resolve => { release = resolve; });
  const b = browser({ fetchHook: async input => { if (!input) await wait; } });
  const loading = b.api.flush();
  b.api.edit(() => [toy(1)]);
  release(); await loading;
  assert.equal(b.cart()[0].quantity, 1);
  assert.equal(b.db.state.cart[0].quantity, 1);
});

test('account changes do not import another account cart or replay its queue', async () => {
  const b = browser({ storage: new Map([['bg_cart', JSON.stringify([toy(2)])], ['bg_cart_owner', '2']]) });
  b.storage.set('bg_cart_change_2_old', JSON.stringify({ changes: [{ id: 1, delta: 2 }] }));
  await b.api.flush();
  assert.deepEqual(b.cart(), []);
  assert.equal(b.calls.filter(Boolean).length, 0);
  assert.equal(b.pending().length, 1);
});

test('empty server cart replaces stale local cart without fallback', async () => {
  const b = browser({ storage: new Map([['bg_cart', JSON.stringify([toy(2)])]]) });
  await b.api.flush();
  assert.deepEqual(b.cart(), []);
});

test('add then remove while offline replays in order without resurrecting an item', async () => {
  let offline = true;
  const b = browser({ fetchHook: () => { if (offline) throw new Error('Offline'); } });
  b.api.edit(() => [toy(1)]);
  b.api.edit(() => []);
  assert.equal(await b.api.sync(), false);
  offline = false;
  await b.api.flush();
  assert.deepEqual(b.cart(), []);
  assert.deepEqual(b.db.state.cart, []);
});

test('two tabs draining the same durable queue do not double its changes', async () => {
  const db = database(), storage = new Map();
  const first = browser({ db, storage }), second = browser({ db, storage });
  first.api.edit(() => [toy(1)]);
  second.api.edit(() => [toy(2)]);
  await Promise.all([first.api.flush(), second.api.flush()]);
  assert.equal(db.state.cart[0].quantity, 2);
  assert.equal(first.pending().length, 0);
});

test('expired authentication preserves account changes for a later login', async () => {
  const b = browser({ fetchHook: () => ({ ok: false, status: 403, json: async () => ({ error: 'Invalid Token' }) }) });
  b.api.edit(() => [toy(1)]);
  assert.equal(await b.api.sync(), false);
  assert.equal(b.storage.has('bg_token'), false);
  assert.equal(b.storage.get('bg_cart_owner'), '1');
  assert.equal(b.pending().length, 1);
});
