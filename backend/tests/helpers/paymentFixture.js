'use strict';
const crypto = require('node:crypto');
const { createPaymentService } = require('../../paymentService');

const env = { RAZORPAY_KEY_ID: 'rzp_test_fixture', RAZORPAY_KEY_SECRET: 'fixture-only-secret', RAZORPAY_WEBHOOK_SECRET: 'fixture-webhook-secret-with-32-characters' };
const signature = (body, secret = env.RAZORPAY_KEY_SECRET) => crypto.createHmac('sha256', secret).update(body).digest('hex');
const address = { id: 10, user_id: 1, full_name: 'Test Customer', phone: '9999999999', line1: 'Test Street', city: 'Chennai', state: 'Tamil Nadu', pincode: '600001' };
const request = () => ({ checkout_key: crypto.randomUUID(), address_id: 10, items: [{ id: 1, quantity: 2 }], promo_code: 'BRAINY10', amount: 1, total: 1 });

// In-memory transactional adapter; no live credentials, DB, email, or gateway calls.
function fixture({ environment = env, shippingClient } = {}) {
  const state = { orders: [], jobs: [], cart: [{ id: 1, quantity: 2 }], commissions: 0, commissionStatuses: [], walletCredits: 0, cartWrites: 0,
    products: [1, 2].map(id => ({ id, name: `Catalog Toy${id === 1 ? '' : ' 2'}`, price: 500, image: 'toy.png',
      shipping_weight_g: 300, shipping_length_cm: 10, shipping_breadth_cm: 8, shipping_height_cm: 4 })) };
  const effects = [];
  const calls = { create: 0, fetch: 0, failCreate: false, failFetch: false, failEffects: false };
  let chain = Promise.resolve();
  let payment = { id: 'pay_fixture', order_id: 'order_fixture1', amount: 96000, currency: 'INR', status: 'captured', captured: true, amount_refunded: 0 };
  let payments = [];
  const remoteOrders = [];
  const rows = values => ({ rows: structuredClone(values) });
  async function query(sql, args = []) {
    const q = sql.replace(/\s+/g, ' ').trim();
    if (q.startsWith('SELECT pg_advisory')) return rows([]);
    if (q.startsWith('SELECT * FROM addresses')) return rows(args[0] === 10 && args[1] === 1 ? [address] : []);
    if (q.startsWith('SELECT id, name, price')) return rows(state.products.filter(p => args[0].includes(p.id)));
    if (q.startsWith('SELECT id FROM affiliates')) return rows([{ id: 7 }]);
    if (q.startsWith('SELECT commission_pct')) return rows([{ commission_pct: '20.00' }]);
    if (q.startsWith('SELECT * FROM orders WHERE user_id')) return rows(state.orders.filter(o => o.user_id === args[0] && o.checkout_key === args[1]));
    if (q.startsWith('SELECT * FROM orders WHERE id')) return rows(state.orders.filter(o => o.id === args[0] && o.user_id === args[1]));
    if (q.includes('FROM orders WHERE razorpay_order_id')) return rows(state.orders.filter(o => o.razorpay_order_id === args[0]));
    if (q.startsWith('INSERT INTO orders')) {
      if (q.includes("'Placed','cod'")) {
        const o = { id: state.orders.length + 1, user_id: args[0], address_id: args[1], items: JSON.parse(args[2]),
          subtotal: args[3], total: args[4], status: 'Placed', payment_method: 'cod', affiliate_id: args[5],
          shipping: args[6], discount: args[7], promo_code: args[8], checkout_key: args[9], checkout_fingerprint: args[10], shipping_snapshot: JSON.parse(args[11]) };
        state.orders.push(o); return rows([o]);
      }
      const o = { id: state.orders.length + 1, user_id: args[0], address_id: args[1], items: JSON.parse(args[2]), subtotal: args[3], total: args[4],
        status: 'Payment Pending', payment_method: 'razorpay', affiliate_id: args[5], checkout_key: args[6], checkout_fingerprint: args[7],
        amount_paise: args[8], currency: 'INR', razorpay_key_id: args[9], shipping: args[10], discount: args[11], promo_code: args[12], shipping_snapshot: JSON.parse(args[13]) };
      state.orders.push(o); return rows([o]);
    }
    if (q.startsWith('UPDATE orders SET razorpay_order_id')) {
      const o = state.orders.find(o => o.id === args[1]); o.razorpay_order_id = args[0]; return rows([o]);
    }
    if (q.startsWith('UPDATE orders SET payment_id=$1, payment_review')) {
      const o = state.orders.find(o => o.id === args[2]);
      Object.assign(o, { payment_id: args[0], payment_review: JSON.parse(args[1]) }); return rows([o]);
    }
    if (q.startsWith("UPDATE orders SET status = 'Cancelled'")) {
      state.orders.find(o => o.id === args[0]).status = 'Cancelled'; return rows([]);
    }
    if (q.startsWith("UPDATE orders SET status = 'Paid'")) {
      const o = state.orders.find(o => o.id === args[1]);
      if (state.orders.some(other => other.id !== o.id && other.payment_id === args[0])) throw Object.assign(new Error('duplicate payment'), { code: '23505' });
      Object.assign(o, { status: 'Paid', payment_id: args[0], payment_verified_at: '2026-11-11T00:00:00Z' }); return rows([o]);
    }
    if (q.startsWith('INSERT INTO commissions')) { state.commissions++; state.commissionStatuses.push(args[5]); return rows([{ id: state.commissions }]); }
    if (q.startsWith('INSERT INTO affiliate_wallets')) { state.walletCredits++; return rows([]); }
    if (q.startsWith('INSERT INTO wallet_transactions')) return rows([]);
    if (q.startsWith('INSERT INTO shipping_jobs')) {
      if (!state.jobs.some(job => job.order_id === args[0])) state.jobs.push({ order_id: args[0], state: args[1], details: JSON.parse(args[2]), last_error: args[3] });
      return rows([]);
    }
    if (q.startsWith('SELECT cart FROM users')) return rows([{ cart: state.cart }]);
    if (q.startsWith('UPDATE users SET cart')) {
      if (calls.failEffects) throw new Error('simulated DB failure');
      state.cart = JSON.parse(args[0]); state.cartWrites++; return rows([]);
    }
    throw new Error(`Unexpected query: ${q}`);
  }
  const pool = { query, async connect() {
    let unlock, snapshot;
    return { async query(sql, args) {
      if (sql === 'BEGIN') {
        const previous = chain; chain = new Promise(resolve => { unlock = resolve; }); await previous;
        snapshot = structuredClone(state); return rows([]);
      }
      if (sql === 'ROLLBACK') { if (snapshot) Object.assign(state, snapshot); unlock?.(); unlock = null; return rows([]); }
      if (sql === 'COMMIT') { snapshot = null; unlock?.(); unlock = null; return rows([]); }
      return query(sql, args);
    }, release() { unlock?.(); } };
  } };
  const gateway = () => ({
    orders: {
      async all({ receipt }) { return { items: structuredClone(remoteOrders.filter(order => order.receipt === receipt)) }; },
      async create(options) {
        calls.create++; if (calls.failCreate) throw new Error('simulated timeout');
        const remote = { id: `order_fixture${calls.create}`, ...options }; remoteOrders.push(remote);
        if (calls.loseCreateResponse) throw new Error('response lost after remote creation');
        return remote;
      },
      async fetchPayments(id) { if (calls.failFetch) throw new Error('simulated timeout'); return { items: structuredClone(payments.filter(p => p.order_id === id)) }; }
    },
    payments: { async fetch() { calls.fetch++; if (calls.failFetch) throw new Error('simulated timeout'); return structuredClone(payment); } }
  });
  const service = createPaymentService({ pool, gateway, env: environment, shippingClient, afterConfirmation: order => effects.push(order.id), invalidateOrderCache: async () => {} });
  return { state, calls, effects, service, pool,
    setPayment: p => { payment = { ...payment, ...p }; }, setPayments: p => { payments = p; },
    callback: (id = 1) => ({ order_id: id, razorpay_order_id: state.orders[id - 1].razorpay_order_id,
      razorpay_payment_id: payment.id, razorpay_signature: signature(`${state.orders[id - 1].razorpay_order_id}|${payment.id}`, environment.RAZORPAY_KEY_SECRET) }),
    webhook: (event = 'payment.captured') => {
      const body = Buffer.from(JSON.stringify({ event, payload: { payment: { entity: payment } } }));
      return [body, signature(body, env.RAZORPAY_WEBHOOK_SECRET)];
    }
  };
}


module.exports = { fixture, request, address, env, signature };
