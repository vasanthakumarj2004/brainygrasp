/* ============================================================
   cart.js – BrainyGrasp Cart Page Module
   Uses unified auth system for checkout protection
   ============================================================ */

// ── Refresh cart from DB if logged in, then render ──
async function loadAndRenderCartPage() {
  renderCartPage();

  if (localStorage.getItem('bg_token') && window.CartSync) {
    await window.CartSync.sync();
    renderCartPage();
  }
}

// ── Cart Page Rendering ──
function renderCartPage() {
  if (typeof getCart !== 'function') {
    console.error('cart.js: getCart() not available – ensure common.js is loaded first.');
    return;
  }
  const contentWrap = document.getElementById('cartPageContent');
  const itemsWrap   = document.getElementById('cartPageItems');
  const empty       = document.getElementById('cartPageEmpty');
  const totalEl     = document.getElementById('cartPageTotal');
  const subtotalEl  = document.getElementById('cartPageSubtotal');
  const shippingEl  = document.getElementById('cartPageShipping');
  const countEl     = document.getElementById('cartPageItemCount');
  const shipBox     = document.getElementById('cartPageShipBox');
  const shipMsg     = document.getElementById('cartPageShipMsg');
  const shipFill    = document.getElementById('cartPageShipFill');
  const checkoutBtn = document.getElementById('cartPageCheckout');
  if (!itemsWrap || !empty || !totalEl) return;

  const cart = getCart();
  if (!cart.length) {
    empty.style.display = 'flex';
    if (contentWrap) contentWrap.style.display = 'none';
    itemsWrap.innerHTML = '';
    totalEl.innerHTML = '&#8377;0';
    if (subtotalEl) subtotalEl.innerHTML = '&#8377;0';
    if (shippingEl) shippingEl.innerHTML = '&#8377;0';
    if (countEl) countEl.textContent = '0 items';
    if (checkoutBtn) checkoutBtn.disabled = true;
    return;
  }

  const esc = (s) => String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

  empty.style.display = 'none';
  if (contentWrap) contentWrap.style.display = 'grid';
  if (checkoutBtn) checkoutBtn.disabled = false;

  const itemCount = cart.reduce((sum, item) => sum + (item.quantity || 1), 0);
  if (countEl) countEl.textContent = `${itemCount} item${itemCount === 1 ? '' : 's'}`;

  itemsWrap.innerHTML = cart.map(item => {
    const qty = item.quantity || 1;
    const lineTotal = item.price * qty;
    const thumb = item.image
      ? `<img class="cp-item-thumb" src="${esc(item.image)}" alt="${esc(item.name)}" data-image-fallback="cart">`
      : '';
    return `
      <div class="cp-item" data-id="${item.id}">
        <div class="cp-item-left">
          ${thumb}
          <div class="cp-item-placeholder" style="${item.image ? 'display:none' : ''}"><i class="fas fa-puzzle-piece"></i></div>
          <div class="cp-item-info">
            <div class="cp-item-name">${esc(item.name)}</div>
            <div class="cp-item-unit">&#8377;${item.price} each</div>
          </div>
        </div>
        <div class="cp-item-right">
          <div class="cp-qty-stepper">
            <button type="button" class="quantity-btn page-minus" data-id="${item.id}" aria-label="Decrease quantity">-</button>
            <span class="cart-item-qty">${qty}</span>
            <button type="button" class="quantity-btn page-plus" data-id="${item.id}" aria-label="Increase quantity">+</button>
          </div>
          <div class="cp-item-subtotal">&#8377;${lineTotal}</div>
          <button type="button" class="cart-item-remove" data-id="${item.id}" aria-label="Remove item" title="Remove item">
            <i class="fas fa-trash-alt"></i>
          </button>
        </div>
      </div>`;
  }).join('');

  const subtotal = typeof getCartTotal === 'function'
    ? getCartTotal()
    : cart.reduce((sum, item) => sum + item.price * (item.quantity || 1), 0);
  const shipping = subtotal >= 999 ? 0 : 60;
  const total = subtotal + shipping;

  if (subtotalEl) subtotalEl.innerHTML = `&#8377;${subtotal}`;
  if (shippingEl) {
    shippingEl.innerHTML = shipping === 0
      ? '<span class="cp-free-badge">FREE</span>'
      : `<strong>&#8377;${shipping}</strong>`;
  }
  totalEl.innerHTML = `&#8377;${total}`;

  if (shipBox && shipMsg && shipFill) {
    const pct = Math.min(100, Math.round((subtotal / 999) * 100));
    shipFill.style.width = `${pct}%`;
    if (subtotal >= 999) {
      shipBox.classList.add('unlocked');
      shipMsg.innerHTML = 'You unlocked <strong>FREE delivery</strong>!';
    } else {
      shipBox.classList.remove('unlocked');
      shipMsg.innerHTML = `Add <strong>&#8377;${999 - subtotal}</strong> more for FREE delivery`;
    }
  }
}

// ── Event Listeners ──
document.addEventListener('DOMContentLoaded', () => {
  loadAndRenderCartPage();

  document.addEventListener('click', (e) => {
    const minusBtn = e.target.closest('.page-minus');
    if (minusBtn && typeof updateQuantityInCart === 'function') {
      updateQuantityInCart(parseInt(minusBtn.dataset.id, 10), -1);
      renderCartPage();
      return;
    }

    const plusBtn = e.target.closest('.page-plus');
    if (plusBtn && typeof updateQuantityInCart === 'function') {
      updateQuantityInCart(parseInt(plusBtn.dataset.id, 10), +1);
      renderCartPage();
      return;
    }

    const removeBtn = e.target.closest('.cart-item-remove');
    if (removeBtn && typeof removeFromCart === 'function') {
      removeFromCart(parseInt(removeBtn.dataset.id, 10));
      renderCartPage();
      return;
    }
  });
});
