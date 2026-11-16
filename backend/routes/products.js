'use strict';

const express = require('express');
const router = express.Router();
const pool = require('../db');

// Mutable catalog reads bypass Redis and browser/CDN caches so saves are visible.
function fresh(res) { res.set('Cache-Control', 'no-store'); }
function searchTerm(req, res) {
  const q = req.query.q;
  if (typeof q !== 'string' || q.trim().length < 2 || q.trim().length > 100) {
    res.status(400).json({ error: 'Query must contain 2 to 100 characters' });
    return null;
  }
  return `%${q.trim().replace(/[%_\\]/g, '\\$&')}%`;
}
router.get('/api/products', async (req, res) => {
  fresh(res);
  try {
    const result = await pool.query('SELECT * FROM products ORDER BY sales DESC NULLS LAST, id DESC');
    res.json(result.rows);
  } catch { res.status(503).json({ error: 'Products are temporarily unavailable. Please retry.' }); }
});
router.get('/api/products/search', async (req, res) => {
  fresh(res);
  const pattern = searchTerm(req, res);
  if (!pattern) return;
  try {
    const result = await pool.query(`SELECT id, name, category, price, original_price, image, badge,
      age, age_group, sales, reviews, save, offer, skills, theme, type, group_name, launch_date
      FROM products WHERE name ILIKE $1 OR category ILIKE $1 OR theme ILIKE $1 OR group_name ILIKE $1
      ORDER BY sales DESC NULLS LAST, id DESC LIMIT 20`, [pattern]);
    res.json({ products: result.rows });
  } catch { res.status(503).json({ error: 'Search is temporarily unavailable. Please retry.' }); }
});
router.get('/api/categories/search', async (req, res) => {
  fresh(res);
  const pattern = searchTerm(req, res);
  if (!pattern) return;
  try {
    const result = await pool.query(`SELECT category AS name, COUNT(*) AS product_count
      FROM products WHERE category ILIKE $1 GROUP BY category ORDER BY product_count DESC LIMIT 10`, [pattern]);
    res.json({ categories: result.rows });
  } catch { res.status(503).json({ error: 'Category search is temporarily unavailable. Please retry.' }); }
});
module.exports = router;
