/**
 * routes/admin.js — BrainyGrasp
 * ─────────────────────────────────────────────────────────────────────────────
 * Admin panel API endpoints.
 *
 * All routes require a valid admin JWT (role === 'admin').
 *
 * Endpoints:
 *   POST /api/admin/login
 *   GET  /api/admin/products
 *   POST /api/admin/products
 *   PUT  /api/admin/products/:id
 *   DELETE /api/admin/products/:id
 *   GET  /api/admin/dashboard
 *   GET  /api/admin/orders
 *   GET  /api/admin/orders/:id
 *   PUT  /api/admin/orders/:id/status
 *   POST /api/admin/orders/:id/push-shiprocket
 *   POST /api/admin/orders/:id/refresh-tracking
 */

'use strict';

const express  = require('express');
const router   = express.Router();
const crypto   = require('crypto');
const pool     = require('../db');
const { deleteCache, clearCachePattern, CACHE_KEYS } = require('../redisClient');
const shiprocket = require('../shiprocketService');
const { approveShipment } = require('../shippingJobs');
const { tracking } = require('../orderFulfillment');
const { ShippingError } = require('../shippingPolicy');
const { productShipping } = require('../parcelPacking');
const { validateProductImage } = require('../productValidation');
const { positiveId } = require('../checkoutService');


// ── Admin Auth Middleware ─────────────────────────────────────────────────────
function authenticateAdmin(req, res, next) {
  return require('../authSecurity').security().authenticate('admin')(req, res, next);
}

// ── Startup guard: require admin credentials ─────────────────────────────────
if (!process.env.ADMIN_USERNAME || !process.env.ADMIN_PASSWORD) {
  throw new Error(
    '❌ Missing required env vars: ADMIN_USERNAME and ADMIN_PASSWORD must be set in .env'
  );
}

// ── POST /api/admin/login ─────────────────────────────────────────────────────
router.post('/api/admin/login', async (req, res) => {
  const { username, password } = req.body || {};
  if (typeof username !== 'string' || username.length > 254 || typeof password !== 'string' || password.length > 1024) {
    return res.status(400).json({ error: 'Invalid admin credentials' });
  }
  try {
    const security = require('../authSecurity').security();
    await security.throttle(req, 'admin-login', username.trim().toLowerCase());
    const matches = (a, b) => crypto.timingSafeEqual(crypto.createHash('sha256').update(a).digest(), crypto.createHash('sha256').update(b).digest());
    if (!matches(username, process.env.ADMIN_USERNAME) || !matches(password, process.env.ADMIN_PASSWORD)) {
      return res.status(401).json({ error: 'Invalid admin credentials' });
    }
    const token = await security.issue({ role: 'admin', username });
    res.set('Cache-Control', 'no-store');
    res.json({ token });
  } catch (err) {
    res.status(err.status === 429 ? 429 : 503).json({ error: err.status === 429 ? err.message : 'Login unavailable' });
  }
});

// ── GET /api/admin/products ───────────────────────────────────────────────────
router.get('/api/admin/products', authenticateAdmin, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM products ORDER BY id DESC');
    const grouped = {};
    result.rows.forEach(p => {
      const g = p.group_name || 'other';
      if (!grouped[g]) grouped[g] = [];
      grouped[g].push(p);
    });
    res.json(grouped);
  } catch (err) {
    console.error('Admin products fetch error:', err);
    res.status(500).json({ error: 'Failed to fetch products' });
  }
});

// ── Helper ────────────────────────────────────────────────────────────────────
function parseSkills(skills) {
  if (Array.isArray(skills)) return JSON.stringify(skills);
  if (typeof skills === 'string' && skills.trim()) {
    return JSON.stringify(skills.split(',').map(s => s.trim()).filter(Boolean));
  }
  return '[]';
}

function rejectInvalidProductImage(image, res) {
  try { validateProductImage(image); return false; }
  catch (err) { res.status(400).json({ error: err.message }); return true; }
}

async function clearProductCaches() {
  // Retire legacy entries as well; public catalog reads now bypass Redis.
  await Promise.all(['products*', 'search:products:*', 'search:categories:*'].map(pattern => clearCachePattern(pattern).catch(() => {})));
}

// ── POST /api/admin/products ──────────────────────────────────────────────────
router.post('/api/admin/products', authenticateAdmin, async (req, res) => {
  const {
    name, group_name, price, original_price, save, age, age_group,
    badge, image, category, skills, theme, type, launch_date, sales, reviews, offer,
  } = req.body;

  if (!name || !group_name || price === undefined || price === null || !image) {
    return res.status(400).json({ error: 'name, group_name, price, and image are required' });
  }

  const parsedPrice = parseInt(price);
  if (isNaN(parsedPrice) || parsedPrice <= 0) {
    return res.status(400).json({ error: 'Price must be a valid positive number' });
  }

  if (rejectInvalidProductImage(image, res)) return;

  try {
    const parcel = productShipping(req.body, { optional: true });
    const result = await pool.query(`
      INSERT INTO products
        (name, group_name, price, original_price, save, age, age_group,
         badge, image, category, skills, theme, type, launch_date, sales, reviews, offer,
         shipping_weight_g, shipping_length_cm, shipping_breadth_cm, shipping_height_cm)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
      RETURNING *
    `, [
      name, group_name, parsedPrice,
      parseInt(original_price || price) || parsedPrice,
      save || '0%', age || null, age_group || null,
      badge || null, image, category || null,
      parseSkills(skills), theme || null, type || 'Single Products',
      launch_date || new Date().toISOString().split('T')[0],
      parseInt(sales || 0) || 0, parseInt(reviews || 0) || 0,
      offer || 'Buy any 2 | Get FLAT 10% OFF',
      parcel.shipping_weight_g, parcel.shipping_length_cm, parcel.shipping_breadth_cm, parcel.shipping_height_cm,
    ]);

    await clearProductCaches();
    res.status(201).json(result.rows[0]);
  } catch (err) {
    if (err instanceof ShippingError) return res.status(err.status).json({ error: err.message });
    console.error('Admin add product error:', err);
    res.status(500).json({ error: err.message || 'Failed to add product' });
  }
});

// ── PUT /api/admin/products/:id ───────────────────────────────────────────────
router.put('/api/admin/products/:id', authenticateAdmin, async (req, res) => {
  const { id } = req.params;
  const {
    name, group_name, price, original_price, save, age, age_group,
    badge, image, category, skills, theme, type, launch_date, sales, reviews, offer,
  } = req.body;

  const parsedPrice = parseInt(price);
  if (isNaN(parsedPrice) || parsedPrice <= 0) {
    return res.status(400).json({ error: 'Price must be a valid positive number' });
  }

  if (rejectInvalidProductImage(image, res)) return;

  try {
    const parcel = productShipping(req.body, { optional: true });
    const result = await pool.query(`
      UPDATE products SET
        name=$1, group_name=$2, price=$3, original_price=$4, save=$5,
        age=$6, age_group=$7, badge=$8, image=$9, category=$10,
        skills=$11, theme=$12, type=$13, launch_date=$14,
        sales=$15, reviews=$16, offer=$17,
        shipping_weight_g=$19, shipping_length_cm=$20, shipping_breadth_cm=$21, shipping_height_cm=$22
      WHERE id=$18
      RETURNING *
    `, [
      name, group_name, parsedPrice,
      parseInt(original_price || price) || parsedPrice,
      save || '0%', age || null, age_group || null,
      badge || null, image, category || null,
      parseSkills(skills), theme || null, type || 'Single Products',
      launch_date || null,
      parseInt(sales || 0) || 0, parseInt(reviews || 0) || 0,
      offer || 'Buy any 2 | Get FLAT 10% OFF',
      parseInt(id),
      parcel.shipping_weight_g, parcel.shipping_length_cm, parcel.shipping_breadth_cm, parcel.shipping_height_cm,
    ]);

    if (result.rows.length === 0) return res.status(404).json({ error: 'Product not found' });
    await clearProductCaches();
    res.json(result.rows[0]);
  } catch (err) {
    if (err instanceof ShippingError) return res.status(err.status).json({ error: err.message });
    console.error('Admin update product error:', err);
    res.status(500).json({ error: err.message || 'Failed to update product' });
  }
});

// ── DELETE /api/admin/products/:id ────────────────────────────────────────────
router.delete('/api/admin/products/:id', authenticateAdmin, async (req, res) => {
  const { id } = req.params;
  try {
    const result = await pool.query(
      'DELETE FROM products WHERE id=$1 RETURNING id', [parseInt(id)]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Product not found' });
    await clearProductCaches();
    res.json({ success: true, deleted_id: result.rows[0].id });
  } catch (err) {
    console.error('Admin delete product error:', err);
    res.status(500).json({ error: 'Failed to delete product' });
  }
});

// ── GET /api/admin/dashboard ──────────────────────────────────────────────────
router.get('/api/admin/dashboard', authenticateAdmin, async (req, res) => {
  console.log('DASHBOARD ROUTE HIT');
  try {
    const [
      productsRes, ordersCountRes, revenueRes,
      confirmedRes, pendingRes, deliveredRes,
      usersWithCartRes, recentOrdersRes,
      topSellingRes, lowSellingRes, cartItemsRes, totalUsersRes,
    ] = await Promise.all([
      pool.query('SELECT COUNT(*) FROM products'),
      pool.query('SELECT COUNT(*) FROM orders'),
      pool.query("SELECT COALESCE(SUM(total),0) AS total FROM orders WHERE LOWER(status) NOT IN ('cancelled', 'payment pending')"),
      pool.query("SELECT COUNT(*) FROM orders WHERE LOWER(status) = 'confirmed'"),
      pool.query("SELECT COUNT(*) FROM orders WHERE LOWER(status) IN ('placed','shipped')"),
      pool.query("SELECT COUNT(*) FROM orders WHERE LOWER(status) = 'delivered'"),
      pool.query("SELECT COUNT(*) FROM users WHERE jsonb_array_length(COALESCE(cart,'[]'::jsonb)) > 0"),
      pool.query(`
        SELECT o.id, o.total, o.status, o.created_at,
               u.name AS customer_name, u.email AS customer_email
        FROM orders o
         LEFT JOIN shipping_jobs j ON j.order_id = o.id
        LEFT JOIN users u ON o.user_id = u.id
        ORDER BY o.created_at DESC LIMIT 10
      `),
      pool.query(
        'SELECT id, name, image, category, COALESCE(sales,0) AS sales FROM products ORDER BY sales DESC NULLS LAST LIMIT 5'
      ),
      pool.query(
        'SELECT id, name, image, category, COALESCE(sales,0) AS sales FROM products ORDER BY sales ASC NULLS FIRST LIMIT 5'
      ),
      pool.query(`
        SELECT COALESCE(SUM(
          (SELECT COALESCE(SUM((item->>'quantity')::int), 0)
           FROM jsonb_array_elements(COALESCE(cart,'[]'::jsonb)) AS item)
        ), 0) AS total_items FROM users
      `),
      pool.query('SELECT COUNT(*) FROM users'),
    ]);

    res.json({
      kpis: {
        totalProducts:   parseInt(productsRes.rows[0]?.count || 0) || 0,
        totalOrders:     parseInt(ordersCountRes.rows[0]?.count || 0) || 0,
        totalRevenue:    parseInt(revenueRes.rows[0]?.total || 0) || 0,
        confirmed:       parseInt(confirmedRes.rows[0]?.count || 0) || 0,
        deliveryPending: parseInt(pendingRes.rows[0]?.count || 0) || 0,
        delivered:       parseInt(deliveredRes.rows[0]?.count || 0) || 0,
        usersWithCart:   parseInt(usersWithCartRes.rows[0]?.count || 0) || 0,
        cartItems:       parseInt(cartItemsRes.rows[0]?.total_items || 0) || 0,
        totalUsers:      parseInt(totalUsersRes.rows[0]?.count || 0) || 0,
      },
      recentOrders: recentOrdersRes.rows || [],
      topSelling:   topSellingRes.rows || [],
      lowSelling:   lowSellingRes.rows || [],
    });
  } catch (err) {
    console.error('Admin dashboard error details:', err.message, err.stack);
    res.status(500).json({ error: err.message || String(err) });
  }
});

// ── GET /api/admin/orders ─────────────────────────────────────────────────────
router.get('/api/admin/orders', authenticateAdmin, async (req, res) => {
  const page   = Math.max(1, parseInt(req.query.page)  || 1);
  const limit  = Math.min(100, parseInt(req.query.limit) || 20);
  const offset = (page - 1) * limit;
  const { status, search } = req.query;

  try {
    const conditions = [];
    const params     = [];
    let   idx        = 1;

    if (status === 'payment_review') {
      conditions.push("o.payment_review->>'state' = 'needs_review'");
    } else if (status && status !== 'all') {
      conditions.push(`LOWER(o.status) = $${idx++}`);
      params.push(status.toLowerCase());
    }
    if (search && search.trim()) {
      conditions.push(
        `(u.name ILIKE $${idx} OR u.email ILIKE $${idx} OR o.id::text = $${idx})`
      );
      params.push(`%${search.trim()}%`);
      idx++;
    }

    const whereClause = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';

    const [countRes, ordersRes] = await Promise.all([
      pool.query(
        `SELECT COUNT(*) FROM orders o LEFT JOIN users u ON o.user_id = u.id ${whereClause}`,
        params
      ),
      pool.query(
        `SELECT o.*, j.state AS shipping_job_state, j.phase AS shipping_job_phase,
             j.details AS shipping_job_details, j.last_error AS shipping_job_error,
                u.name  AS customer_name,
                u.email AS customer_email,
                a.full_name AS addr_name,
                a.phone     AS addr_phone,
                a.line1, a.city, a.state, a.pincode
         FROM orders o
         LEFT JOIN shipping_jobs j ON j.order_id = o.id
         LEFT JOIN users     u ON o.user_id     = u.id
         LEFT JOIN addresses a ON o.address_id  = a.id
         ${whereClause}
         ORDER BY o.created_at DESC
         LIMIT $${idx} OFFSET $${idx + 1}`,
        [...params, limit, offset]
      ),
    ]);

    res.json({ orders: ordersRes.rows || [], total: parseInt(countRes.rows[0]?.count || 0) });
  } catch (err) {
    console.error('Admin orders list error:', err);
    res.status(500).json({ error: 'Failed to fetch orders' });
  }
});

// ── GET /api/admin/orders/:id ─────────────────────────────────────────────────
router.get('/api/admin/orders/:id', authenticateAdmin, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT o.*, j.state AS shipping_job_state, j.phase AS shipping_job_phase,
             j.details AS shipping_job_details, j.last_error AS shipping_job_error,
             u.name  AS customer_name,
             u.email AS customer_email,
             a.full_name AS addr_name,
             a.phone     AS addr_phone,
             a.line1, a.city, a.state, a.pincode
      FROM orders o
         LEFT JOIN shipping_jobs j ON j.order_id = o.id
      LEFT JOIN users     u ON o.user_id    = u.id
      LEFT JOIN addresses a ON o.address_id = a.id
      WHERE o.id = $1
    `, [parseInt(req.params.id)]);

    if (result.rows.length === 0) return res.status(404).json({ error: 'Order not found' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Admin order detail error:', err);
    res.status(500).json({ error: 'Failed to fetch order' });
  }
});

// ── PUT /api/admin/orders/:id/status ─────────────────────────────────────────
router.put('/api/admin/orders/:id/status', authenticateAdmin, async (req, res) => {
  const { status, expected_delivery, delivery_date, admin_note } = req.body;
  if (!status) return res.status(400).json({ error: 'status is required' });

  try {
    const result = await pool.query(`
      UPDATE orders
      SET status=$1, expected_delivery=$2, delivery_date=$3, admin_note=$4
      WHERE id=$5
        AND (payment_method='cod' OR checkout_key IS NULL OR payment_verified_at IS NOT NULL OR LOWER($1) = 'payment pending'
          OR (payment_review IS NOT NULL AND status=$1))
        AND (payment_review IS NULL OR status=$1)
        AND (status=$1 OR NOT EXISTS (SELECT 1 FROM shipping_jobs WHERE order_id=orders.id AND state IN ('queued','retry','processing')))
        AND NOT (LOWER($1)='cancelled' AND shipment_id IS NOT NULL)
      RETURNING id, user_id, status, expected_delivery, delivery_date, admin_note
    `, [status, expected_delivery || null, delivery_date || null, admin_note || null, parseInt(req.params.id)]);

    if (result.rows.length === 0) return res.status(409).json({ error: 'Order update blocked: check pending payment/booking. Cancel existing shipments in Shiprocket first; local status changes do not cancel courier pickups.' });

    const updated = result.rows[0];
    if (updated.user_id) {
      await deleteCache(CACHE_KEYS.USER_ORDERS(updated.user_id)).catch(() => {});
    }

    // ── Reverse affiliate commission on cancellation ───────────────────────
    if (status.toLowerCase() === 'cancelled') {
      const commCheck = await pool.query(
        "SELECT * FROM commissions WHERE order_id=$1 AND status='APPROVED'",
        [parseInt(req.params.id)]
      );
      if (commCheck.rows.length > 0) {
        const comm = commCheck.rows[0];
        await pool.query("UPDATE commissions SET status='CANCELLED' WHERE id=$1", [comm.id]);
        await pool.query(`
          UPDATE affiliate_wallets
          SET current_balance = GREATEST(0, current_balance - $1),
              total_earned    = GREATEST(0, total_earned    - $1),
              updated_at      = NOW()
          WHERE affiliate_id = $2
        `, [comm.commission_amount, comm.affiliate_id]);
        await pool.query(`
          INSERT INTO wallet_transactions (affiliate_id, transaction_type, amount, description, reference_id)
          VALUES ($1, 'REVERSAL', $2, $3, $4)
        `, [comm.affiliate_id, -comm.commission_amount,
            `Commission reversed for cancelled Order #${req.params.id}`, comm.id]);
      }
    }

    res.json({ success: true, order: updated });
  } catch (err) {
    console.error('Admin order status update error:', err);
    res.status(500).json({ error: 'Failed to update order status' });
  }
});

// ── POST /api/admin/orders/:id/push-shiprocket ────────────────────────────────
router.post('/api/admin/orders/:id/push-shiprocket', authenticateAdmin, async (req, res) => {
  try {
    const job = await approveShipment(positiveId(req.params.id), req.body?.parcel);
    res.status(job.state === 'completed' ? 200 : 202).json({ success: true, state: job.state,
      message: job.state === 'completed' ? 'Pickup is already confirmed.' : 'Shipment queued. Refresh the order to see booking progress.' });
  } catch (err) {
    res.status(err.status || 503).json({ error: err instanceof ShippingError ? err.message : 'Unable to queue shipment. Check the saved order and try again.' });
  }
});

router.post('/api/admin/orders/:id/refresh-tracking', authenticateAdmin, async (req, res) => {
  try {
    const id = positiveId(req.params.id);
    const result = await pool.query('SELECT awb_number FROM orders WHERE id=$1', [id]);
    if (!result.rows[0]?.awb_number) return res.status(409).json({ error: 'No AWB has been assigned yet.' });
    const remote = await shiprocket.getTracking(result.rows[0].awb_number);
    const order = await tracking.refresh(id, remote);
    await deleteCache(CACHE_KEYS.USER_ORDERS(order.user_id)).catch(() => {});
    res.json({ success: true, status: order.status, tracking_status: order.tracking_status,
      estimated_delivery: order.estimated_delivery, courier_name: order.courier_name });
  } catch (err) {
    res.status(err.status || 503).json({ error: err instanceof ShippingError ? err.message : 'Unable to refresh tracking. Please try again.' });
  }
});

router.post('/api/admin/orders/:id/confirm-cod-collection', authenticateAdmin, async (req, res) => {
  if (req.body?.collected !== true) return res.status(400).json({ error: 'Confirm that COD funds have been collected' });
  try {
    await require('../commissionSecurity').confirmCodCollection(pool, positiveId(req.params.id));
    res.json({ success: true });
  } catch (err) { res.status(err.status || 503).json({ error: err.status ? err.message : 'Unable to confirm collection' }); }
});

module.exports = router;
module.exports.authenticateAdmin = authenticateAdmin;
