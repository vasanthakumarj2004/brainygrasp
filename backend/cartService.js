'use strict';

const crypto = require('crypto');
const { CheckoutError, positiveId } = require('./checkoutService');

async function migrateCart(db) {
  await db.query(`CREATE TABLE IF NOT EXISTS cart_mutations (
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    mutation_id UUID NOT NULL, fingerprint VARCHAR(64) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (user_id, mutation_id)
  )`);
}

function validateMutation(input = {}) {
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(input.mutation_id || '') ||
      !Array.isArray(input.changes) || !input.changes.length || input.changes.length > 100) {
    throw new CheckoutError(400, 'Invalid cart update. Refresh the page and try again.');
  }
  const ids = new Set();
  const changes = input.changes.map(change => {
    const id = positiveId(change?.id);
    const minimum = change.minimum !== undefined;
    const value = minimum ? change.minimum : change.delta;
    if (ids.has(id) || !Number.isInteger(value) || (minimum ? value < 1 || value > 100 || change.delta !== undefined : !value || Math.abs(value) > 100)) {
      throw new CheckoutError(400, 'Invalid cart quantity');
    }
    ids.add(id);
    return minimum ? { id, minimum: value } : { id, delta: value };
  }).sort((a, b) => a.id - b.id);
  return { changes, fingerprint: crypto.createHash('sha256').update(JSON.stringify(changes)).digest('hex') };
}

async function applyMutation(pool, userId, input) {
  const { changes, fingerprint } = validateMutation(input);
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    // Shares the row lock used when checkout removes purchased quantities.
    const user = (await db.query('SELECT cart FROM users WHERE id = $1 FOR UPDATE', [userId])).rows[0];
    if (!user) throw new CheckoutError(404, 'User not found');
    const previous = (await db.query('SELECT fingerprint FROM cart_mutations WHERE user_id = $1 AND mutation_id = $2', [userId, input.mutation_id])).rows[0];
    let cart = Array.isArray(user.cart) ? user.cart : [];
    if (previous) {
      if (previous.fingerprint !== fingerprint) throw new CheckoutError(409, 'This cart update was already used for a different change');
    } else {
      const products = (await db.query('SELECT id, name, price, image FROM products WHERE id = ANY($1::int[])', [changes.map(c => c.id)])).rows;
      const items = new Map(cart.map(item => [Number(item.id), item]));
      for (const change of changes) {
        const existing = items.get(change.id);
        const current = Number(existing?.quantity) || 0;
        const quantity = change.minimum !== undefined ? Math.max(current, change.minimum) : Math.max(0, current + change.delta);
        if (quantity > 100) throw new CheckoutError(409, 'A cart item cannot exceed 100 units');
        if (!quantity) { items.delete(change.id); continue; }
        const product = products.find(p => p.id === change.id);
        if (!product) throw new CheckoutError(409, 'A cart product is no longer available');
        items.set(change.id, { ...product, quantity });
      }
      cart = [...items.values()];
      if (cart.length > 100) throw new CheckoutError(409, 'Cart cannot exceed 100 products');
      await db.query('UPDATE users SET cart = $1 WHERE id = $2', [JSON.stringify(cart), userId]);
      await db.query('INSERT INTO cart_mutations(user_id, mutation_id, fingerprint) VALUES ($1,$2,$3)', [userId, input.mutation_id, fingerprint]);
    }
    await db.query('COMMIT');
    return cart;
  } catch (err) { await db.query('ROLLBACK'); throw err; }
  finally { db.release(); }
}

module.exports = { migrateCart, applyMutation, validateMutation };
