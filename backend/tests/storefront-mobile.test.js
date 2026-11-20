'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function fixture(manual = true) {
  const timers = new Map(); let nextId = 0;
  const document = { hidden: false, activeElement: null, body: { style: {} }, handlers: {},
    addEventListener(name, fn) { (this.handlers[name] ||= []).push(fn); },
    querySelectorAll: () => [], createElement: () => element() };
  function element() {
    const classes = new Set();
    return { handlers: {}, attrs: {}, style: {}, children: [],
      classList: { add: name => classes.add(name), remove: name => classes.delete(name), contains: name => classes.has(name) },
      addEventListener(name, fn) { (this.handlers[name] ||= []).push(fn); },
      setAttribute(name, value) { this.attrs[name] = value; },
      focus() { document.activeElement = this; }, getClientRects: () => [1],
      contains(target) { return target === this || this.children.includes(target); },
      appendChild(child) { this.children.push(child); }, insertBefore(child) { this.children.unshift(child); },
      querySelector() { return null; }, querySelectorAll() { return this.children; } };
  }
  const media = { ...element(), matches: manual };
  const window = { ...element(), innerWidth: manual ? 375 : 1200, matchMedia: () => media };
  const slides = Array.from({ length: 3 }, element), dots = Array.from({ length: 3 }, element);
  const slider = element(), prev = element(), next = element(), nav = element(), menu = element(), overlay = element();
  slider.children.push(...dots, prev, next);
  const selectors = { '.hero-slider': slider, '.hero-prev': prev, '.hero-next': next };
  document.querySelector = selector => selectors[selector] || null;
  document.querySelectorAll = selector => selector === '.hero-slide' ? slides : selector === '.hero-dot' ? dots : [];
  document.getElementById = id => ({ mainNav: nav, mobileMenuBtn: menu, mobileOverlay: overlay })[id] || null;
  nav.querySelector = selector => selector === '.nav-close-btn' ? nav.children[0] || null : nav.children[0]?.children[0] || null;
  const context = vm.createContext({ document, window, console,
    setInterval(fn) { const id = ++nextId; timers.set(id, fn); return id; }, clearInterval: id => timers.delete(id),
    setTimeout: fn => fn() });
  const fire = (target, event, data = {}) => (target.handlers[event] || []).forEach(fn => fn(data));
  const run = name => vm.runInContext(fs.readFileSync(path.join(__dirname, '../../frontend/js', name), 'utf8'), context);
  return { context, document, window, media, slides, dots, slider, prev, next, nav, menu, overlay, timers, fire, run };
}

test('phone carousel stays still and manual controls wrap with accessible selected state', () => {
  const b = fixture(); b.run('index.js'); b.context.initHeroSlider();
  assert.equal(b.timers.size, 0);
  assert.equal(b.dots[0].attrs['aria-pressed'], 'true');
  b.fire(b.prev, 'click');
  assert.equal(b.dots[2].attrs['aria-pressed'], 'true');
  assert.equal(b.slides[0].attrs['aria-hidden'], 'true');
  b.fire(b.next, 'click');
  assert.equal(b.slides[0].attrs['aria-hidden'], 'false');
  b.fire(b.dots[1], 'click');
  assert.equal(b.dots[1].attrs['aria-pressed'], 'true');
  assert.equal(b.timers.size, 0);
});

test('carousel stops autoplay for mobile/reduced motion, hidden pages and focused controls', () => {
  const b = fixture(false); b.run('index.js'); b.context.initHeroSlider();
  assert.equal(b.timers.size, 1);
  b.media.matches = true; b.fire(b.media, 'change');
  assert.equal(b.timers.size, 0);
  b.media.matches = false; b.fire(b.media, 'change');
  assert.equal(b.timers.size, 1);
  b.document.hidden = true; b.fire(b.document, 'visibilitychange');
  assert.equal(b.timers.size, 0);
  b.document.hidden = false; b.dots[0].focus(); b.fire(b.document, 'visibilitychange');
  assert.equal(b.timers.size, 0);
  b.document.activeElement = null; b.fire(b.slider, 'focusout', { relatedTarget: null });
  assert.equal(b.timers.size, 1);
  b.fire(b.window, 'pagehide');
  assert.equal(b.timers.size, 0);
});

test('mobile navigation opens, closes and releases the page when resized to desktop', () => {
  const b = fixture(); b.run('common.js'); b.context.initMobileMenu();
  b.fire(b.menu, 'click');
  assert.equal(b.menu.attrs['aria-expanded'], 'true');
  assert.equal(b.nav.classList.contains('active'), true);
  assert.equal(b.document.body.style.overflow, 'hidden');
  assert.equal(b.document.activeElement, b.nav.children[0].children[0]);
  b.fire(b.overlay, 'click');
  assert.equal(b.document.body.style.overflow, '');
  assert.equal(b.menu.attrs['aria-expanded'], 'false');
  b.fire(b.menu, 'click'); b.window.innerWidth = 1200; b.fire(b.window, 'resize');
  assert.equal(b.nav.classList.contains('active'), false);
  assert.equal(b.document.body.style.overflow, '');
  b.window.innerWidth = 375; b.fire(b.menu, 'click'); b.fire(b.document, 'keydown', { key: 'Escape' });
  assert.equal(b.overlay.classList.contains('active'), false);
  assert.equal(b.document.activeElement, b.menu);
});
