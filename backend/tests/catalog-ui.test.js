'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '../..');
const product = { id: 1, name: 'Puzzle & Play', group_name: 'bestsellers', price: 500, original_price: 600,
  image: '/images/logo.jpeg', category: 'Puzzles', age_group: '3+', skills: ['Logic'] };
const decode = value => value.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

function browser(page) {
  const html = fs.readFileSync(path.join(root, page), 'utf8');
  const elements = new Map(), handlers = {}, windowHandlers = {}, intervals = [], timers = [];
  function element(id) {
    const listeners = {}, inputs = [];
    let markup = '';
    return { id, listeners, inputs, value: '', checked: false, style: {}, dataset: {}, disabled: false, textContent: '', open: false,
      classList: { add() {}, remove() {}, contains() { return false; }, toggle() {} },
      closest() { return null; }, scrollIntoView() {}, focus() {}, reset() {}, showModal() { this.open = true; }, close() { this.open = false; },
      addEventListener(name, fn) { (listeners[name] ||= []).push(fn); },
      get innerHTML() { return markup; }, set innerHTML(value) {
        markup = value; inputs.length = 0;
        for (const match of value.matchAll(/<input\b([^>]*)>/g)) {
          const attrs = match[1];
          inputs.push({ value: decode(attrs.match(/value="([^"]*)"/)?.[1] || ''), checked: /\schecked(?:\s|$)/.test(attrs) });
        }
      },
      querySelector() { return null; },
      querySelectorAll(selector) { return selector.includes('input') ? inputs.filter(input => !selector.includes(':checked') || input.checked) : []; }
    };
  }
  for (const match of html.matchAll(/\bid="([^"]+)"/g)) elements.set(match[1], element(match[1]));
  const document = { hidden: false, body: { style: {} }, getElementById: id => elements.get(id) || null,
    querySelector() { return null; }, querySelectorAll(selector) {
      if (selector.includes('id^="price-"')) return [...elements.values()].filter(el => el.id.startsWith('price-') && el.checked);
      const id = selector.match(/^#([\w-]+) input/);
      return id ? elements.get(id[1])?.querySelectorAll(selector) || [] : [];
    }, addEventListener(name, fn) { (handlers[name] ||= []).push(fn); },
    dispatchEvent(event) { (handlers[event.type] || []).forEach(fn => fn(event)); }
  };
  const window = { location: { origin: 'https://store.example', protocol: 'https:', search: '?collection=bestsellers&q=Puzzle', pathname: '/' },
    BG_CONFIG: { API_BASE: '' }, addEventListener(name, fn) { (windowHandlers[name] ||= []).push(fn); } };
  const context = vm.createContext({ window, document, console, URL, URLSearchParams, AbortController,
    CustomEvent: class { constructor(type, init) { this.type = type; Object.assign(this, init); } },
    setInterval: fn => { intervals.push(fn); return intervals.length; },
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, clearTimeout() {},
    fetch: async () => ({ ok: true, json: async () => [] }) });
  const run = file => vm.runInContext(fs.readFileSync(path.join(root, file), 'utf8'), context, { filename: file });
  const fire = async (target, event, data = {}) => { for (const fn of target[event] || []) await fn(data); };
  return { context, window, document, elements, handlers, windowHandlers, intervals, timers, run, fire };
}

test('product card and gallery images use the storefront asset directory on nested local and production pages', () => {
  for (const [page, script, assetBase] of [
    ['http://localhost:5501/BRAINGRASP_DEVIN/frontend/index.html', 'http://localhost:5501/BRAINGRASP_DEVIN/frontend/js/products.js', 'http://localhost:5501/BRAINGRASP_DEVIN/frontend/'],
    ['http://localhost:3000/', 'http://localhost:3000/js/products.js', 'http://localhost:3000/'],
    ['https://brainygrasp.com/collections.html', 'https://brainygrasp.com/js/products.js', 'https://brainygrasp.com/'],
    ['https://www.brainygrasp.com/frontend/index.html', 'https://www.brainygrasp.com/frontend/js/products.js', 'https://www.brainygrasp.com/frontend/'],
  ]) {
    const b = browser('frontend/index.html');
    b.window.location = new URL(page);
    b.window.BG_CONFIG.API_BASE = 'https://separate-api.example';
    b.document.currentScript = { src: script };
    b.run('frontend/js/products.js');
    for (const product of require('../catalog-products.json')) {
      const markup = b.context.createProductCard(product);
      assert.match(markup, /data-image-fallback="product"/);
      const src = decode(markup.match(/<img src="([^"]+)"/)[1]);
      assert.equal(src, assetBase + product.image.slice(1));
      for (const picture of product.details.images) assert.equal(b.context.productImageUrl(picture.src), assetBase + picture.src.slice(1));
    }
    const fallback = assetBase + 'images/product-placeholder.svg';
    assert.equal(b.context.productImageUrl(null), fallback);
    assert.equal(b.context.productImageUrl('javascript:alert(1)'), fallback);
    assert.equal(b.context.productImageUrl('https://user:secret@cdn.example/x.png'), fallback);
    assert.equal(b.context.productImageUrl('https://cdn.example/toy.png?v=2'), 'https://cdn.example/toy.png?v=2');
  }
});

test('Collections renders late-arriving products and keeps price filters through edits and deletions', async () => {
  const b = browser('frontend/collections.html');
  b.run('frontend/js/products.js'); b.run('frontend/js/collections.js');
  await b.fire(b.handlers, 'DOMContentLoaded');
  let rows = [product]; b.context.fetch = async () => ({ ok: true, json: async () => rows });
  await b.context.fetchProductsFromDB();
  assert.match(b.elements.get('colProductsGrid').innerHTML, /Puzzle &amp; Play/);
  b.elements.get('colPriceMin').value = '700';
  await b.fire(b.elements.get('colPriceApply').listeners, 'click');
  assert.equal(b.elements.get('colResultsCount').textContent, '0 Products');
  rows = [{ ...product, price: 900, name: 'Updated Puzzle' }];
  await b.context.fetchProductsFromDB();
  assert.match(b.elements.get('colProductsGrid').innerHTML, /Updated Puzzle/);
  assert.equal(b.elements.get('colResultsCount').textContent, '1 Products');
  assert.equal(b.elements.get('colPriceMin').value, '700');
  rows = []; await b.context.fetchProductsFromDB();
  assert.equal(b.elements.get('colResultsCount').textContent, '0 Products');
  assert.equal(b.elements.get('colPriceApply').listeners.click.length, 1);
});

test('catalog refresh deduplicates in-flight loads, preserves groups and handles errors without sample data', async () => {
  const b = browser('frontend/index.html'); b.run('frontend/js/products.js');
  let resolve, calls = 0;
  b.context.fetch = () => { calls++; return new Promise(done => { resolve = done; }); };
  const first = b.context.fetchProductsFromDB(), second = b.context.fetchProductsFromDB();
  resolve({ ok: true, json: async () => [product] }); await Promise.all([first, second]);
  assert.equal(calls, 1); assert.equal(b.window.products.trending.length, 0); assert.equal(b.window.products.bestsellers.length, 1);
  const card = b.context.createProductCard({ ...product, name: '<script>bad</script>', image: 'javascript:alert(1)', skills: ["Kid's logic"] });
  assert.ok(!card.includes('<script>')); assert.match(card, /&lt;script&gt;/); assert.match(card, /product-placeholder.svg/); assert.match(card, /&#39;/);
  b.context.fetch = async () => { throw new Error('offline'); }; await b.context.fetchProductsFromDB();
  assert.equal(b.window.catalogProducts.length, 0); assert.match(b.elements.get('trendingGrid').innerHTML, /Retry loading products/);
  await b.fire(b.windowHandlers, 'DOMContentLoaded'); assert.equal(b.intervals.length, 1);
  b.document.hidden = true; const prior = calls; await b.intervals[0](); assert.equal(calls, prior);
});

test('search shows only real matches, paginates, opens details and adds the selected product to cart', async () => {
  const b = browser('frontend/search-results.html');
  const cart = []; b.window.addToCart = p => cart.push(p);
  b.run('frontend/js/products.js'); b.run('frontend/js/search-results.js');
  await b.fire(b.handlers, 'DOMContentLoaded');
  let rows = Array.from({ length: 13 }, (_, i) => ({ ...product, id: i+1, name: `Puzzle ${i+1}` }));
  b.context.fetch = async () => ({ ok: true, json: async () => rows }); await b.context.fetchProductsFromDB();
  assert.match(b.elements.get('searchStats').textContent, /13 products/);
  assert.equal((b.elements.get('productsContainer').innerHTML.match(/<article/g) || []).length, 12);
  const target = (selector, data) => ({ closest: candidate => candidate === selector ? { dataset: data } : null });
  await b.fire(b.handlers, 'click', { target: target('[data-search-page]', { searchPage: '2' }) });
  assert.match(b.elements.get('productsContainer').innerHTML, /Puzzle 13/);
  assert.equal((b.elements.get('productsContainer').innerHTML.match(/<article/g) || []).length, 1);
  await b.fire(b.handlers, 'click', { target: target('[data-search-view]', { searchView: '13' }) });
  assert.equal(b.elements.get('searchQuickView').open, true);
  assert.match(b.elements.get('searchQuickViewContent').innerHTML, /Puzzle 13/);
  await b.fire(b.handlers, 'click', { target: target('[data-search-add]', { searchAdd: '13' }) });
  assert.equal(cart[0].id, 13); assert.equal(cart[0].price, 500);
  rows = []; await b.context.fetchProductsFromDB();
  assert.equal(b.elements.get('searchQuickView').open, false);
  assert.match(b.elements.get('productsContainer').innerHTML, /No matching products/);
  b.context.fetch = async () => ({ ok: false }); await b.context.fetchProductsFromDB();
  assert.match(b.elements.get('productsContainer').innerHTML, /could not load/);
  assert.ok(!b.elements.get('productsContainer').innerHTML.includes('Puzzle 13'));
});

for (const [page, script, init, control] of [
  ['frontend/shop-by-age.html', 'frontend/js/shop-by-age.js', 'initShopByAge', 'sortBySelect'],
  ['frontend/shop-by-category.html', 'frontend/js/shop-by-category.js', 'initShopByCategory', 'catSortBySelect']
]) {
  test(`${init} keeps one control handler when live products refresh`, async () => {
    const b = browser(page); b.run('frontend/js/products.js'); b.run(script); b.context[init]();
    let rows = [product]; b.context.fetch = async () => ({ ok: true, json: async () => rows });
    await b.context.fetchProductsFromDB(); rows = [{ ...product, price: 700 }]; await b.context.fetchProductsFromDB();
    assert.equal(b.elements.get(control).listeners.change.length, 1);
  });
}

test('admin saving waits for a loadable image; broken image sends no product write', async () => {
  for (const loads of [false, true]) {
    const b = browser('admin/index.html'), writes = [], messages = [];
    b.window.AdminApp = { requireAuth: () => true, bindLogout() {}, esc: String, showToast: message => messages.push(message),
      adminFetch: async (url, options = {}) => { if (options.method) writes.push(JSON.parse(options.body)); return { ok: true, json: async () => [] }; } };
    b.context.Image = class { naturalWidth = loads ? 100 : 0; set src(value) { Promise.resolve().then(() => loads ? this.onload?.() : this.onerror?.()); } };
    b.run('admin/js/admin-products.js');
    const values = { f_name: 'Puzzle', f_group_name: 'bestsellers', f_price: '500', f_image: 'https://cdn.example.com/toy.png',
      f_shipping_weight_g: '300', f_shipping_length_cm: '10', f_shipping_breadth_cm: '8', f_shipping_height_cm: '4' };
    for (const [id, value] of Object.entries(values)) b.elements.get(id).value = value;
    await b.fire(b.elements.get('productForm').listeners, 'submit', { preventDefault() {} });
    assert.equal(writes.length, loads ? 1 : 0);
    if (loads) assert.equal(writes[0].shipping_weight_g, 300);
    else assert.ok(messages.some(message => message.includes('Image could not be loaded')));
  }
});

test('visible gift recommendations follow catalog edits and deletions without duplicate grouped products', () => {
  const b = browser('frontend/gift-finder.html');
  b.run('frontend/js/products.js');
  const step = { dataset: { step: '1' }, classList: { add() {}, remove() {} }, querySelectorAll: () => [] };
  const options = [];
  const option = { dataset: { value: 'all' }, classList: { add() {}, remove() {} }, closest: () => step,
    addEventListener: (name, fn) => options.push(fn) };
  b.document.querySelectorAll = selector => selector === '.gift-finder-step' ? [step] : selector === '.gift-option' ? [option] : [];
  b.document.querySelector = () => ({ style: {} });
  b.context.createProductCard = p => `<article>${p.name}</article>`;
  b.window.catalogProducts = [product];
  b.run('frontend/js/gift-finder.js'); b.context.initGiftFinder();
  options[0].call(option); b.timers.find(timer => timer.ms === 400).fn();
  const grid = b.elements.get('giftResultGrid');
  assert.equal((grid.innerHTML.match(/<article>/g) || []).length, 1);
  b.window.catalogProducts = [{ ...product, name: 'Edited gift' }];
  b.document.dispatchEvent({ type: 'productsUpdated', detail: { success: true } });
  assert.match(grid.innerHTML, /Edited gift/);
  b.window.catalogProducts = [];
  b.document.dispatchEvent({ type: 'productsUpdated', detail: { success: true } });
  assert.equal(grid.innerHTML, '');
});

test('real catalog details use supplied prices, images, contents and appropriate age filtering', () => {
  const b = browser('frontend/index.html'); b.run('frontend/js/products.js');
  const catalog = require('../catalog-products.json');
  assert.equal(catalog.length, 2);
  const [sentence, magnets] = catalog.map(p => b.context.normalizeProduct(p));
  assert.equal(sentence.price, 549); assert.equal(sentence.originalPrice, 679);
  assert.equal(magnets.price, 1); assert.equal(magnets.originalPrice, 649);
  for (const p of catalog) {
    assert.equal(p.stock_quantity, 50);
    assert.equal(p.details.images.length, 3);
    for (const picture of p.details.images) assert.ok(fs.existsSync(path.join(root, 'frontend', picture.src)));
    const markup = b.context.productDetailsHTML(p);
    assert.match(markup, /storage box/); assert.match(markup, /5.91/);
    assert.ok(!b.context.createProductCard(p).includes('class="stars"'));
  }
  assert.match(b.context.productDetailsHTML(sentence), /130 colourful word cards/);
  assert.match(b.context.productDetailsHTML(magnets), /24 magnetic game pieces/);
  assert.equal(b.context.productMatchesAge(sentence, '6+'), true);
  assert.equal(b.context.productMatchesAge(sentence, '8+'), true);
  assert.equal(b.context.productMatchesAge(magnets, '6+'), false);
  assert.equal(b.context.productMatchesAge(magnets, '8+'), true);
  assert.equal(b.context.productMatchesAge(sentence, '0-3'), false);
  assert.ok(!b.context.productDetailsHTML({details: {description: '<script>bad</script>'}}).includes('<script>'));
});
