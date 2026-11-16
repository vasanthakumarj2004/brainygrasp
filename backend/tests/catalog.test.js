'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createCatalogFixture } = require('./helpers/catalogFixture');
const { validateProductImage } = require('../productValidation');

async function fixture(t) {
  const f = createCatalogFixture();
  const server = f.app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { ...f, async send(url, method = 'GET', body, token = f.token) {
    const response = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, cache: response.headers.get('cache-control'), data: await response.json() };
  } };
}
const product = { name: 'Puzzle & Play', group_name: 'bestsellers', price: 500, original_price: 600,
  image: 'https://example.invalid/toy.jpg', category: 'Puzzles', skills: 'Logic, Creativity', age_group: '3+',
  shipping_weight_g: 300, shipping_length_cm: 10, shipping_breadth_cm: 8, shipping_height_cm: 4 };

test('admin create, update and delete are immediately reflected in catalog, search and categories', async t => {
  const f = await fixture(t);
  assert.equal((await f.send('/api/admin/products', 'POST', product, null)).status, 401);
  assert.equal((await f.send('/api/admin/products', 'POST', product)).status, 201);
  const original = await f.send('/api/products');
  assert.equal(original.cache, 'no-store'); assert.equal(original.data[0].shipping_weight_g, 300);
  assert.equal((await f.send('/api/products/search?q=Puzzle')).data.products[0].age_group, '3+');
  assert.equal((await f.send('/api/categories/search?q=Puzzles')).data.categories.length, 1);
  const changed = { ...product, name: 'Learning & Play', category: 'Learning', price: 750, image: 'https://example.invalid/new.jpg' };
  assert.equal((await f.send('/api/admin/products/1', 'PUT', changed)).status, 200);
  const catalog = await f.send('/api/products');
  assert.equal(catalog.data[0].price, 750); assert.equal(catalog.data[0].image, changed.image);
  assert.deepEqual((await f.send('/api/products/search?q=Puzzle')).data.products, []);
  assert.equal((await f.send('/api/products/search?q=Learning')).data.products[0].image, changed.image);
  assert.deepEqual((await f.send('/api/categories/search?q=Puzzles')).data.categories, []);
  assert.equal((await f.send('/api/admin/products/1', 'DELETE')).status, 200);
  assert.deepEqual((await f.send('/api/products')).data, []);
  for (const pattern of ['products*', 'search:products:*', 'search:categories:*']) assert.equal(f.state.invalidations.filter(value => value === pattern).length, 3);
});

test('invalid images are rejected and catalog failures return errors, never demo products', async t => {
  const f = await fixture(t);
  for (const image of ['javascript:alert(1)', 'https://photos.google.com/share/example', '//example.com/image.jpg', 'https://user:secret@example.com/x']) {
    assert.equal((await f.send('/api/admin/products', 'POST', { ...product, image })).status, 400);
  }
  assert.equal(f.state.rows.length, 0);
  f.state.unavailable = true;
  const failed = await f.send('/api/products'); assert.equal(failed.status, 503); assert.equal(failed.cache, 'no-store');
  assert.equal((await f.send('/api/products/search?q=toy')).status, 503);
});

test('image syntax permits encoded public URLs and root-relative assets; production requires HTTPS', () => {
  assert.equal(validateProductImage('/images/toy%20one.jpg', { production: true }), '/images/toy%20one.jpg');
  assert.equal(validateProductImage('https://cdn.example.com/toy?version=2', { production: true }), 'https://cdn.example.com/toy?version=2');
  assert.throws(() => validateProductImage('http://example.com/toy.jpg', { production: true }));
  assert.throws(() => validateProductImage('https://example.com/x" onerror="alert(1)', { production: true }));
});
