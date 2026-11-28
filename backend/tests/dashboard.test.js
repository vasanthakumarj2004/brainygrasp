'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '../..');
const profile = { id: 1, name: 'Test Customer', email: 'customer@example.test', phone: '9876543210', address: '12 Test Street', city: 'Chennai', state: 'Tamil Nadu', pincode: '600001', country: 'India' };
const order = { id: 12, status: 'Shipped', total: 900, items: [{ name: 'Puzzle', quantity: 2, price: 450 }], awb_number: 'TEST123', courier_name: 'Test courier', tracking_status: 'In Transit', tracking_event_at: '2026-11-14T06:00:00Z' };

function browser() {
    const elements = new Map(), handlers = {}, windowHandlers = {}, intervals = new Map(), storage = new Map([['bg_token', 'test-token']]);
    let timerId = 0;
    function element(id) {
        return { id, textContent: '', innerHTML: '', style: {}, dataset: {}, value: '', hidden: false, disabled: false,
            classList: { toggle() {}, remove() {} }, setAttribute() {}, focus() {}, scrollIntoView() {},
            reportValidity: () => true, querySelectorAll: () => [], addEventListener(name, fn) { this[name] = fn; } };
    }
    for (const match of fs.readFileSync(path.join(root, 'frontend/dashboard.html'), 'utf8').matchAll(/id="([^"]+)"/g)) elements.set(match[1], element(match[1]));
    const panel = element('panel');
    const document = { hidden: false, body: { style: {} }, getElementById: id => elements.get(id),
        querySelector: selector => selector === '.orders-panel' ? panel : null, querySelectorAll: () => [],
        addEventListener: (name, fn) => { handlers[name] = fn; } };
    const redirects = [], calls = [];
    let responder = async url => ({ ok: true, status: 200, json: async () => url.includes('/auth/me') ? profile : [order] });
    const context = vm.createContext({
        window: { BG_CONFIG: { API_BASE: '' }, CustomerValidation: require('../../frontend/js/customer-validation'), location: { replace: url => redirects.push(url) }, addEventListener: (name, fn) => { windowHandlers[name] = fn; } },
        document, console, AbortController, Intl, Date,
        localStorage: { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) },
        setTimeout: () => ++timerId, clearTimeout() {},
        setInterval: (fn, ms) => { const id = ++timerId; intervals.set(id, { fn, ms }); return id; }, clearInterval: id => intervals.delete(id),
        FormData: class { constructor(form) { return Object.entries(form.fields); } },
        fetch: (url, options) => { calls.push({ url, options }); return responder(url, options); }
    });
    vm.runInContext(fs.readFileSync(path.join(root, 'frontend/js/dashboard-new.js'), 'utf8'), context);
    return { context, elements, document, panel, handlers, windowHandlers, intervals, storage, calls, redirects,
        respond: fn => { responder = fn; }, ready: () => context.loadData() };
}
test('dashboard logout waits for server revocation and retains access when the request fails', async () => {
    const b = browser(); await b.ready();
    b.respond(async () => { throw Error('offline'); });
    await b.elements.get('logoutBtn').onclick();
    assert.ok(b.storage.get('bg_token')); assert.equal(b.redirects.length, 0);
    let finish;
    b.respond(() => new Promise(resolve => { finish = resolve; }));
    const pending = b.elements.get('logoutBtn').onclick();
    assert.ok(b.storage.get('bg_token')); assert.equal(b.redirects.length, 0);
    assert.equal(b.calls.at(-1).url, '/api/auth/logout');
    assert.equal(b.calls.at(-1).options.method, 'POST');
    finish({ ok: true, status: 200, json: async () => ({ success: true }) });
    await pending;
    assert.equal(b.storage.get('bg_token'), undefined); assert.equal(b.redirects.at(-1), 'login');
});

test('profile failure does not block orders; retry restores complete profile', async () => {
    const b = browser(); await b.ready();
    b.respond(async url => {
        if (url.includes('/auth/me')) throw Error('offline');
        return { ok: true, json: async () => [order] };
    });
    await b.context.loadData();
    assert.match(b.elements.get('currentOrdersList').innerHTML, /Puzzle/);
    assert.equal(b.elements.get('retryProfileBtn').hidden, false);
    b.respond(async () => ({ ok: true, json: async () => profile }));
    await b.elements.get('retryProfileBtn').onclick();
    assert.match(b.elements.get('profileLocation').textContent, /12 Test Street, Chennai, Tamil Nadu, 600001, India/);
    assert.equal(b.elements.get('retryProfileBtn').hidden, true);
});
test('tracking selection survives delivery, while order moves into history', async () => {
    const b = browser(); await b.ready();
    b.respond(async () => ({ ok: true, json: async () => [{ ...order, status: 'Delivered' }] }));
    await b.context.loadOrders();
    assert.match(b.elements.get('currentOrdersList').innerHTML, /No current orders/);
    assert.match(b.elements.get('historyOrdersList').innerHTML, /Order #12/);
    assert.equal(b.elements.get('trackingOrderSelect').value, '12');
    assert.match(b.elements.get('trackingDetails').innerHTML, /Delivery progress: Delivered/);
});
test('polling bypasses cache, pauses while hidden, and coalesces concurrent refreshes', async () => {
    const b = browser(); await b.ready();
    assert.equal(b.intervals.size, 1);
    const timer = [...b.intervals.values()][0];
    assert.equal(timer.ms, 30000);
    b.document.hidden = true; const count = b.calls.length; timer.fn();
    assert.equal(b.calls.length, count);
    b.document.hidden = false;
    let resolve;
    b.respond(() => new Promise(done => { resolve = done; }));
    const first = b.context.loadOrders(), second = b.context.loadOrders();
    assert.equal(first, second);
    assert.equal(b.calls.at(-1).url, '/api/orders?fresh=1');
    assert.equal(b.calls.at(-1).options.cache, 'no-store');
    resolve({ ok: true, json: async () => [order] }); await first;
    b.windowHandlers.pagehide(); assert.equal(b.intervals.size, 0);
});
test('refresh failure preserves existing data with a stale warning and can recover', async () => {
    const b = browser(); await b.ready();
    const markup = b.elements.get('trackingDetails').innerHTML;
    b.respond(async () => { throw Error('offline'); }); await b.context.loadOrders();
    assert.equal(b.elements.get('trackingDetails').innerHTML, markup);
    assert.match(b.elements.get('trackingFeedback').textContent, /out of date/);
    assert.equal(b.elements.get('refreshTrackingBtn').disabled, false);
    b.respond(async () => ({ ok: true, json: async () => [] })); await b.elements.get('refreshTrackingBtn').onclick();
    assert.match(b.elements.get('trackingDetails').innerHTML, /No active deliveries/);
});
test('returned, pending and unknown statuses never show a fabricated delivery stage', async () => {
    const b = browser(); await b.ready();
    for (const status of ['Returned', 'RTO', 'Cancelled', 'Payment Pending', 'Unrecognized']) {
        const html = b.context.renderTrackingBar({ ...order, status });
        assert.ok(!html.includes('tracking-steps'));
        assert.match(html, /tracking-note/);
    }
    assert.match(b.context.renderTrackingBar({ ...order, status: 'Paid' }), /Delivery progress: Confirmed/);
});
test('order content is escaped and malformed items do not break other orders', async () => {
    const b = browser(); await b.ready();
    b.context.renderOrders([{ ...order, full_name: '<img onerror=bad>', line1: '<script>bad</script>', items: 'invalid json' }, { ...order, id: 13, items: [{ name: '<script>bad</script>', quantity: 1 }] }], 'current');
    const html = b.elements.get('currentOrdersList').innerHTML;
    assert.ok(!html.includes('<script>')); assert.ok(!html.includes('<img'));
    assert.match(html, /&lt;script&gt;/); assert.match(html, /Order #13/);
});
test('profile save uses server-confirmed values and keeps errors in the open form', async () => {
    const b = browser(); await b.ready(); b.context.openModal();
    const form = b.elements.get('profileEditForm');
    form.fields = { ...profile, name: 'Updated Customer' };
    b.respond(async (url, options) => ({ ok: true, json: async () => ({ success: true, user: { ...profile, ...JSON.parse(options.body) } }) }));
    await form.onsubmit({ preventDefault() {}, target: form });
    assert.equal(b.elements.get('profileName').textContent, 'Updated Customer');
    assert.equal(b.elements.get('profileEditModal').style.display, 'none');
    b.context.openModal();
    b.respond(async () => ({ ok: false, status: 400, json: async () => ({ error: 'Phone already used' }) }));
    await form.onsubmit({ preventDefault() {}, target: form });
    assert.equal(b.elements.get('profileEditModal').style.display, 'flex');
    assert.equal(b.elements.get('profileSaveFeedback').textContent, 'Phone already used');
    assert.equal(b.elements.get('saveProfileBtn').disabled, false);
});
test('invalid profile fields do not submit; session expiry clears data and polling', async () => {
    const b = browser(); await b.ready();
    const form = b.elements.get('profileEditForm'); const count = b.calls.length;
    form.fields = { ...profile, pincode: '123' };
    await form.onsubmit({ preventDefault() {}, target: form });
    assert.equal(b.calls.length, count); assert.match(b.elements.get('profileSaveFeedback').textContent, /PIN/);
    b.respond(async () => ({ ok: false, status: 401 })); await b.context.loadOrders();
    assert.equal(b.storage.has('bg_token'), false);
    assert.equal(b.intervals.size, 0); assert.equal(b.redirects.at(-1), 'login');
});
test('history action opens the selected past delivery and tab switching preserves tracking', async () => {
    const b = browser(); await b.ready();
    b.respond(async () => ({ ok: true, json: async () => [{ ...order, id: 22, status: 'Returned' }] }));
    await b.context.loadOrders();
    b.panel.click({ target: { closest: () => ({ dataset: { trackOrder: '22' } }) } });
    assert.equal(b.elements.get('trackingOrderSelect').value, '22');
    assert.match(b.elements.get('trackingDetails').innerHTML, /This order was returned/);
    b.context.switchOrderTab('history');
    assert.equal(b.elements.get('historyOrdersSection').style.display, 'block');
});

function routeModule(file, dependencies) {
    const routes = {};
    const router = {};
    for (const method of ['get', 'post', 'put']) router[method] = (url, ...handlers) => { routes[method + ' ' + url] = handlers.at(-1); };
    const module = { exports: {} };
    vm.runInNewContext(fs.readFileSync(path.join(root, 'backend/routes', file), 'utf8'), {
        module, exports: module.exports, console, process: { env: {} },
        require: name => name === 'express' ? { Router: () => router } : name === '../../frontend/js/customer-validation' ? require('../../frontend/js/customer-validation') : (name === '../customerOrder' ? require('../customerOrder') : dependencies[name] || {})
    });
    return routes;
}
function response() {
    return { headers: {}, statusCode: 200, set(key, value) { this.headers[key] = value; return this; },
        status(value) { this.statusCode = value; return this; }, json(value) { this.body = value; return this; } };
}
test('fresh orders bypass stale cache and query only the signed-in owner', async () => {
    let read = 0, write = 0; const queries = [];
    const routes = routeModule('orders.js', {
        '../db': { query: async (sql, args) => { queries.push({ sql, args }); return { rows: [order] }; } },
        '../redisClient': { getCached: async () => { read++; return [{ ...order, status: 'Placed' }]; }, setCache: async () => { write++; },
            CACHE_KEYS: { USER_ORDERS: id => 'orders:' + id }, TTL: { USER_ORDERS: 3600 } }
    });
    const cached = response(); await routes['get /api/orders']({ user: { id: 7 }, query: {} }, cached);
    assert.equal(cached.body[0].status, 'Placed');
    const fresh = response(); await routes['get /api/orders']({ user: { id: 7 }, query: { fresh: '1' } }, fresh);
    assert.equal(fresh.body[0].status, 'Shipped'); assert.equal(read, 1); assert.equal(write, 0);
    assert.equal(queries[0].args[0], 7); assert.match(queries[0].sql, /WHERE o.user_id = \$1/);
    assert.equal(fresh.headers['Cache-Control'], 'private, no-store');
    assert.match(queries[0].sql, /LEFT JOIN shipping_jobs sj ON sj.order_id = o.id/);
    assert.match(queries[0].sql, /AS shipment_progress/);
    assert.match(queries[0].sql, /'pickup_scheduled_date', sj.details->>'pickupScheduledDate'/);
    assert.doesNotMatch(queries[0].sql, /sj\.\*|sj\.last_error|'config'|'labelUrl'|'manifestUrl'/);
});

test('shipment preparation, retry and pickup scheduling appear without inventing collection', () => {
    const b = browser();
    const preparing = { ...order, status: 'Paid', shipment_progress: { state: 'queued', phase: 'new' } };
    assert.match(b.context.renderTrackingBar(preparing), /Preparing your shipment/);
    const html = job => b.context.renderTrackingBar({ ...preparing, shipment_progress: job });
    assert.match(html({ state: 'retry', phase: 'created' }), /retrying automatically/);
    assert.match(html({ state: 'needs_review', phase: 'create_pending' }), /needs attention/);
    assert.match(html({ state: 'awaiting_parcel', phase: 'new' }), /needs attention/);
    assert.match(html({ state: 'processing', phase: 'pickup_pending' }), /Arranging courier pickup/);
    const pickup = html({ state: 'completed', phase: 'complete', pickup_requested: true, pickup_scheduled_date: '2026-11-21' });
    assert.match(pickup, /Pickup requested. Awaiting courier collection/);
    assert.match(pickup, /Scheduled pickup:.*2026-11-21/);
    assert.match(pickup, /Delivery progress: Confirmed/);
    assert.doesNotMatch(pickup, /Delivery progress: Shipped/);
    assert.doesNotMatch(html({ state: 'processing', pickup_scheduled_date: '2026-11-21' }), /Scheduled pickup/);
    assert.doesNotMatch(html({ pickup_requested: true, pickup_scheduled_date: '<img src=x onerror=bad>' }), /<img/);
    assert.match(html({ pickup_requested: true, pickup_scheduled_date: '<script>' }), /&lt;script&gt;/);
    assert.doesNotMatch(b.context.renderTrackingBar({ ...preparing, status: 'Delivered' }), /Preparing your shipment/);
    assert.doesNotMatch(b.context.renderTrackingBar({ ...preparing, status: 'Payment Pending' }), /Preparing your shipment/);
    assert.doesNotMatch(b.context.renderTrackingBar(order), /Preparing your shipment/);
});
test('profile API rejects malformed fields before touching the database', async () => {
    let queries = 0;
    const routes = routeModule('auth.js', { '../db': { query: async () => { queries++; throw Error('unexpected query'); } } });
    for (const body of [null, { name: {} }, { name: 'Test', phone: 'abc' }, { name: 'Test', pincode: '12' }, { name: 'x'.repeat(101) }]) {
        const res = response(); await routes['put /api/auth/profile']({ user: { id: 1 }, body }, res);
        assert.equal(res.statusCode, 400);
    }
    assert.equal(queries, 0);
});

test('courier webhook processing reaches fresh customer orders without stale cache', async () => {
    const { createDeliveryTracking } = require('../deliveryTracking');
    let stored = { ...order, user_id: 7 };
    const inbox = new Map(), invalidations = [];
    const db = {
        release() {},
        async query(sql, args = []) {
            const q = sql.replace(/\s+/g, ' ').trim();
            if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(q)) return { rows: [] };
            if (q.startsWith('INSERT INTO delivery_events')) { inbox.set(args[0], { id: args[0], payload: JSON.parse(args[1]), state: 'pending' }); return { rows: [] }; }
            if (q.startsWith('SELECT * FROM delivery_events')) return { rows: inbox.get(args[0])?.state === 'pending' ? [inbox.get(args[0])] : [] };
            if (q.startsWith('SELECT * FROM orders WHERE awb_number')) return { rows: stored.awb_number === args[0] ? [stored] : [] };
            if (q.startsWith('UPDATE orders SET status')) {
                stored = { ...stored, status: args[1], tracking_status: args[2], estimated_delivery: args[3] || stored.estimated_delivery,
                    courier_name: args[4] || stored.courier_name, tracking_event_at: args[5] || stored.tracking_event_at,
                    delivery_date: stored.delivery_date || args[6] };
                return { rows: [stored] };
            }
            if (q.startsWith("UPDATE delivery_events SET state='processed'")) { inbox.get(args[0]).state = 'processed'; return { rows: [] }; }
            if (q.includes('WHERE o.user_id = $1')) return { rows: stored.user_id === args[0] ? [stored] : [] };
            throw Error('Unexpected query: ' + q);
        }
    };
    const pool = { query: db.query.bind(db), connect: async () => db };
    const tracking = createDeliveryTracking({ pool, invalidate: async id => invalidations.push(id) });
    const eventId = await tracking.receive({ awb: order.awb_number, current_status: 'DELIVERED', current_timestamp: '2026-11-14T10:00:00Z', courier_name: 'Test courier' });
    assert.equal(stored.status, 'Shipped'); // Receiving alone only persists the event.
    await tracking.processEvent(eventId);
    assert.equal(inbox.get(eventId).state, 'processed');
    assert.deepEqual(invalidations, [7]);
    const routes = routeModule('orders.js', { '../db': pool, '../redisClient': {
        getCached: async () => [order], setCache: async () => {}, CACHE_KEYS: { USER_ORDERS: id => id }, TTL: { USER_ORDERS: 3600 }
    } });
    const res = response();
    await routes['get /api/orders']({ user: { id: 7 }, query: { fresh: '1' } }, res);
    assert.equal(res.body[0].status, 'Delivered');
    assert.equal(res.body[0].tracking_status, 'DELIVERED');
    const b = browser(); await b.ready();
    b.respond(async () => ({ ok: true, json: async () => res.body }));
    await b.context.loadOrders();
    assert.match(b.elements.get('historyOrdersList').innerHTML, /Delivered/);
    assert.match(b.elements.get('trackingDetails').innerHTML, /Delivery progress: Delivered/);
    assert.equal(stored.delivery_date, '2026-11-14');
});

test('profile saves normalize phone and reload from the database despite stale Redis', async () => {
    let stored = { ...profile }, cacheReads = 0;
    const queries = [];
    const routes = routeModule('auth.js', {
        '../db': { query: async (sql, args) => {
            queries.push({ sql, args });
            if (sql.startsWith('SELECT phone')) return { rows: [{ phone: stored.phone }] };
            if (sql.startsWith('SELECT id FROM')) return { rows: [] };
            if (sql.includes('UPDATE users')) {
                stored = { ...stored, name: args[0], phone: args[2], address: args[3], city: args[4], state: args[5], pincode: args[6], country: args[7] };
            }
            return { rows: [stored] };
        } },
        '../redisClient': { getCached: async () => { cacheReads++; return profile; }, deleteCache: async () => false }
    });
    const save = response();
    await routes['put /api/auth/profile']({ user: { id: 1 }, body: { ...profile, name: 'Saved Name', phone: '+91 98765 43210' } }, save);
    assert.equal(save.body.success, true);
    assert.equal(stored.phone, '9876543210');
    const reload = response();
    await routes['get /api/auth/me']({ user: { id: 1 } }, reload);
    assert.equal(reload.body.name, 'Saved Name');
    assert.equal(cacheReads, 0);
    assert.equal(reload.headers['Cache-Control'], 'private, no-store');
    assert.equal(queries.find(q => q.sql.includes('UPDATE users')).args[8], 1);
});

test('profile limits reject values that exceed database or delivery address limits', async () => {
    let queried = false;
    const routes = routeModule('auth.js', { '../db': { query: async () => { queried = true; } } });
    for (const fields of [{ gender: 'x'.repeat(21) }, { pincode: 'x'.repeat(11), country: 'Other' }, { address: 'x'.repeat(256) }]) {
        const res = response();
        await routes['put /api/auth/profile']({ user: { id: 1 }, body: { name: 'Name', ...fields } }, res);
        assert.equal(res.statusCode, 400);
    }
    assert.equal(queried, false);
});

test('profile client sends normalized values and checkout accepts the same phone', async () => {
    const b = browser(); await b.ready();
    const form = b.elements.get('profileEditForm');
    form.fields = { ...profile, phone: '+91 98765 43210' };
    b.respond(async (_, options) => ({ ok: true, json: async () => ({ success: true, user: { ...profile, ...JSON.parse(options.body) } }) }));
    await form.onsubmit({ preventDefault() {}, target: form });
    assert.equal(JSON.parse(b.calls.at(-1).options.body).phone, '9876543210');
    const { validateAddress } = require('../checkoutService');
    assert.equal(validateAddress({ full_name: profile.name, phone: form.fields.phone, line1: profile.address,
        city: profile.city, state: profile.state, pincode: profile.pincode }).phone, '9876543210');
});

test('order cards show saved totals, verified payment and dates without inferring COD collection', async () => {
    const b = browser(); await b.ready();
    b.context.renderOrders([{ ...order, subtotal: 950, shipping: 50, discount: 100,
        payment_method: 'razorpay', payment_verified_at: '2026-11-14T06:00:00Z', payment_id: 'pay_fixture',
        expected_delivery: '2026-11-20', delivery_date: '2026-11-19' }], 'history');
    const html = b.elements.get('historyOrdersList').innerHTML;
    for (const text of ['Subtotal', 'Shipping', 'Discount', 'Payment verified', 'pay_fixture', 'Delivered on:', '20 Nov 2026']) assert.ok(html.includes(text), text);
    assert.equal(b.context.paymentLabel({ ...order, payment_method: 'cod', status: 'Delivered' }), 'Cash on delivery');
    assert.equal(b.context.paymentLabel({ ...order, payment_method: 'razorpay', payment_id: 'pay_unverified' }), 'Payment not verified');
    assert.equal(b.context.savedAmount(undefined), 'Not available');
});

test('courier exceptions show a notice and latest raw status without normal progress', async () => {
    const b = browser(); await b.ready();
    for (const status of ['UNDELIVERED', 'DELAYED', 'PICKUP_ERROR', 'PICKUP EXCEPTION']) {
        const html = b.context.renderTrackingBar({ ...order, tracking_status: status });
        assert.ok(html.includes(status));
        assert.ok(html.includes('tracking-note'));
        assert.ok(!html.includes('tracking-steps'));
    }
    assert.equal(vm.runInContext("isHistory({ status: 'Damaged' })", b.context), true);
});
