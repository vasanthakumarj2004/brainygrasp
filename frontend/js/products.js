/* BrainGrasp — Dynamic Products Management (DB Single Source of Truth) */

// Global products structure initialized empty — ZERO hardcoded fallback products
let products = {
  trending: [],
  bestsellers: [],
  newlaunches: [],
  bundles: []
};

// Expose on window object
window.products = products;

let catalogProducts = [];
window.catalogProducts = catalogProducts;
function catalogEscape(value) {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
// The storefront may be served at / or a nested Live Server directory.
// Resolve bundled images beside this script, independently of the API origin.
const catalogAssetBase = document.currentScript?.src
  ? new URL('../', document.currentScript.src).href
  : `${window.location.origin}/`;
function productImageUrl(value) {
  const fallback = new URL('images/product-placeholder.svg', catalogAssetBase).href;
  if (typeof value !== 'string' || !value.trim()) return fallback;
  try {
    const image = value.trim();
    const bundled = image.startsWith('/images/') || image.startsWith('images/');
    const url = new URL(bundled ? image.replace(/^\//, '') : image,
      bundled ? catalogAssetBase : window.location.origin);
    const localProtocol = ['http:', 'file:'].includes(window.location.protocol) ? [window.location.protocol] : [];
    return ['https:', ...localProtocol].includes(url.protocol) && !url.username && !url.password ? url.href : fallback;
  } catch { return fallback; }
}

// === Create Product Card HTML ===
function createProductCard(product) {
  if (!product) return '';

  const price = Number(product.price) || 0;
  const origPriceVal = product.originalPrice !== undefined ? product.originalPrice : product.original_price;
  const originalPrice = Number(origPriceVal) || price;
  const saveText = product.save || '0%';
  
  const badgeClass = product.badge === 'bestseller' ? 'badge-yellow' : product.badge === 'new' ? 'badge-blue' : 'badge-green';
  const badgeText = product.badge === 'bestseller' ? 'Bestseller' : product.badge === 'new' ? 'New Launch' : product.badge ? product.badge : 'Featured';
  
  const reviews = Number(product.reviews) || 0;
  const reviewsHTML = reviews > 0 
    ? `<div class="product-reviews">
        <div class="stars">
          <i class="fas fa-star"></i><i class="fas fa-star"></i><i class="fas fa-star"></i><i class="fas fa-star"></i><i class="fas fa-star-half-alt"></i>
        </div>
        <span class="review-count">${reviews} reviews</span>
       </div>` 
    : '';

  const ageText = product.age || product.ageGroup || '3+ Years';

  return `
    <div class="product-card advanced-card" data-id="${catalogEscape(product.id)}" data-age="${catalogEscape(product.ageGroup || '')}" data-category="${catalogEscape(product.category || '')}" data-skills="${catalogEscape(JSON.stringify(product.skills || []))}" data-theme="${catalogEscape(product.theme || '')}" data-type="${catalogEscape(product.type || '')}" data-price="${price}" data-date="${catalogEscape(product.launchDate || '')}" data-sales="${Number(product.sales) || 0}">
      ${product.badge ? `<span class="adv-badge ${badgeClass}">${catalogEscape(badgeText)}</span>` : ''}
      <div class="product-share">
        <button class="share-btn"><i class="fas fa-share-alt"></i></button>
      </div>
      <div class="product-image">
        <img src="${catalogEscape(productImageUrl(product.image))}" alt="${catalogEscape(product.name || 'Product')}" loading="lazy" data-image-fallback="product">
      </div>
      <div class="product-info">
        <div class="product-age-pill">Ages: ${catalogEscape(ageText)}</div>
        <h3 class="product-name">${catalogEscape(product.name || 'Product')}</h3>
        ${product.details?.subtitle ? `<p class="product-subtitle">${catalogEscape(product.details.subtitle)}</p>` : ''}
        
        <div class="product-price-row">
          <span class="price-current">&#8377;${price.toLocaleString('en-IN')}</span>
          ${originalPrice > price ? `<span class="price-original">&#8377;${originalPrice.toLocaleString('en-IN')}</span>` : ''}
          ${saveText && saveText !== '0%' ? `<span class="price-save">Save ${catalogEscape(saveText)}</span>` : ''}
        </div>
        
        ${reviewsHTML}
        
        <div class="promo-box">
          ${catalogEscape(product.offer || '')}
        </div>
        
        <button class="add-to-cart-btn btn-peach" ${product.stock_quantity === 0 ? 'disabled' : ''}><i class="fas fa-shopping-bag"></i> ${product.stock_quantity === 0 ? 'Out of stock' : 'Add to Cart'}</button>
      </div>
    </div>
  `;
}

// Shared details for the catalog quick view and search result dialog.
function productDetailsHTML(product) {
  const d = product.details || {};
  const list = (title, items) => Array.isArray(items) && items.length
    ? `<h3>${title}</h3><ul>${items.map(item => `<li>${catalogEscape(item)}</li>`).join('')}</ul>` : '';
  return `${d.subtitle ? `<p><strong>${catalogEscape(d.subtitle)}</strong></p>` : ''}
    ${d.description ? `<p>${catalogEscape(d.description)}</p>` : ''}
    ${list("What's included", d.includes)}
    ${list('Skills developed', product.skills)}
    ${d.categories?.length ? `<p><strong>Word categories:</strong> ${catalogEscape(d.categories.join(', '))}</p>` : ''}
    <dl class="product-specifications">
      ${product.category ? `<dt>Category</dt><dd>${catalogEscape(product.category)}</dd>` : ''}
      ${Number.isInteger(product.stock_quantity) ? `<dt>Availability</dt><dd>${product.stock_quantity > 0 ? 'In stock' : 'Out of stock'}</dd>` : ''}
      ${d.weight_g ? `<dt>Product weight</dt><dd>${Number(d.weight_g)} g</dd>` : ''}
      ${d.covered_weight_g ? `<dt>With extra cover</dt><dd>${Number(d.covered_weight_g)} g</dd>` : ''}
      ${d.dimensions_inches?.length === 3 ? `<dt>Dimensions (L × W × H)</dt><dd>${d.dimensions_inches.map(Number).join(' × ')} inches</dd>` : ''}
    </dl>`;
}

function productMatchesAge(product, selected) {
  if (!selected || selected === 'all') return true;
  if (product.ageGroup === selected || product.age_group === selected) return true;
  const minimum = product.details?.age_min;
  if (!Number.isFinite(minimum)) return false;
  const maximum = product.details?.age_max ?? Infinity;
  // Existing navigation uses representative age bands (3–5, 6–7, 8+).
  const bands = { '0-3': [0, 3], '3+': [3, 5], '6+': [6, 7], '8+': [8, Infinity] };
  const band = bands[selected];
  return !!band && minimum <= band[1] && maximum >= band[0];
}

// === Render Products ===
function renderProducts(gridId, productList, errorMessage) {
  const grid = document.getElementById(gridId);
  if (!grid) return;

  if (errorMessage) {
    grid.innerHTML = `
      <div class="products-status-box error-status" style="grid-column: 1 / -1; text-align: center; padding: 40px 20px; color: #ef4444; background: rgba(239, 68, 68, 0.05); border-radius: 12px; border: 1px dashed rgba(239, 68, 68, 0.2); width: 100%;">
        <i class="fas fa-exclamation-triangle" style="font-size: 2rem; margin-bottom: 12px; display: block;"></i>
        <p style="font-size: 1.1rem; font-weight: 600; margin: 0;">${catalogEscape(errorMessage)}<br><button type="button" data-retry-catalog>Retry loading products</button></p>
      </div>
    `;
    return;
  }

  if (!productList || productList.length === 0) {
    grid.innerHTML = `
      <div class="products-status-box empty-status" style="grid-column: 1 / -1; text-align: center; padding: 40px 20px; color: #64748b; background: rgba(255, 255, 255, 0.02); border-radius: 12px; border: 1px dashed rgba(255, 255, 255, 0.1); width: 100%;">
        <i class="fas fa-box-open" style="font-size: 2rem; margin-bottom: 12px; display: block; color: #94a3b8;"></i>
        <p style="font-size: 1.1rem; font-weight: 600; margin: 0;">No products available.</p>
      </div>
    `;
    return;
  }

  grid.innerHTML = productList.map(createProductCard).join('');
}

// === Render All Visible Grids ===
function renderAllGrids() {
  const trendingGrid = document.getElementById('trendingGrid');
  if (trendingGrid) {
    const activeTab = trendingGrid.closest('.section')?.querySelector('.tab-btn.active');
    if (activeTab && typeof activeTab.click === 'function') {
      activeTab.click();
    } else {
      renderProducts('trendingGrid', products.trending);
    }
  }

  const handpickedGrid = document.getElementById('handpickedGrid');
  if (handpickedGrid) {
    const activeTab = handpickedGrid.closest('.section')?.querySelector('.tab-btn.active');
    if (activeTab && typeof activeTab.click === 'function') {
      activeTab.click();
    } else {
      renderProducts('handpickedGrid', catalogProducts);
    }
  }

  if (document.getElementById('youMayAlsoLikeGrid')) {
    renderProducts('youMayAlsoLikeGrid', catalogProducts);
  }
  if (document.getElementById('recentlyViewedGrid')) {
    renderProducts('recentlyViewedGrid', products.newlaunches);
  }
}

function renderAllGridsError(msg) {
  ['trendingGrid', 'handpickedGrid', 'youMayAlsoLikeGrid', 'recentlyViewedGrid', 'shopByAgeGrid', 'shopByCategoryGrid', 'colProductsGrid', 'pcProductsGrid', 'giftResultGrid'].forEach(id => {
    if (document.getElementById(id)) {
      renderProducts(id, [], msg);
    }
  });
}

// === Normalize DB row (snake_case) → frontend object (camelCase) ===
// PostgreSQL returns column names in snake_case; the sort/filter logic
// throughout the frontend expects camelCase. This single mapping is the
// source of truth — fix field names HERE, not scattered across every page.
function normalizeProduct(p) {
  return {
    ...p,
    // price/originalPrice — DB stores as INTEGER, ensure numeric
    price:         Number(p.price)          || 0,
    originalPrice: Number(p.original_price !== undefined ? p.original_price : (p.originalPrice || p.price)) || Number(p.price) || 0,
    // snake_case → camelCase mappings that sort/filter functions depend on
    ageGroup:      p.age_group   || p.ageGroup   || null,
    launchDate:    p.launch_date || p.launchDate  || null,
    groupName:     p.group_name  || p.groupName   || null,
    sales:         Number(p.sales)   || 0,
    reviews:       Number(p.reviews) || 0,
    skills:        Array.isArray(p.skills) ? p.skills.filter(s => typeof s === 'string') : [],
  };
}

// Refresh visible pages without duplicating requests or resetting filters when unchanged.
let catalogRequest = null;
let catalogSignature = null;
let catalogLastAttempt = 0;
function fetchProductsFromDB() {
  if (catalogRequest) return catalogRequest;
  catalogLastAttempt = Date.now();
  catalogRequest = loadCatalog().finally(() => { catalogRequest = null; });
  return catalogRequest;
}
async function loadCatalog() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const apiBase = (window.BG_CONFIG && window.BG_CONFIG.API_BASE) || '';
    const res = await fetch(`${apiBase}/api/products`, { cache: 'no-store', signal: controller.signal });
    if (!res.ok) throw new Error('Catalog request failed');
    const raw = await res.json();
    if (!Array.isArray(raw)) throw new Error('Invalid catalog response');
    const signature = JSON.stringify(raw);
    if (signature === catalogSignature) return;
    catalogSignature = signature;
    catalogProducts = raw.map(normalizeProduct);
    window.catalogProducts = catalogProducts;
    products.trending = catalogProducts.filter(p => p.groupName === 'trending');
    products.bestsellers = catalogProducts.filter(p => p.groupName === 'bestsellers');
    products.newlaunches = catalogProducts.filter(p => p.groupName === 'newlaunches' || p.badge === 'new');
    products.bundles = catalogProducts.filter(p => p.groupName === 'bundles' || p.type === 'Bundles');
    window.products = products;
    renderAllGrids();
    document.dispatchEvent(new CustomEvent('productsUpdated', { detail: { success: true, products } }));
  } catch (err) {
    catalogSignature = null;
    catalogProducts = [];
    window.catalogProducts = catalogProducts;
    Object.keys(products).forEach(key => { products[key] = []; });
    renderAllGridsError('Unable to load products. Please try again.');
    document.dispatchEvent(new CustomEvent('productsUpdated', { detail: { success: false } }));
  } finally { clearTimeout(timer); }
}
function refreshVisibleCatalog() {
  if (!document.hidden && Date.now() - catalogLastAttempt >= 5000) void fetchProductsFromDB();
}
window.addEventListener('DOMContentLoaded', () => {
  void fetchProductsFromDB();
  setInterval(refreshVisibleCatalog, 60000);
});
window.addEventListener('focus', refreshVisibleCatalog);
window.addEventListener('pageshow', refreshVisibleCatalog);
document.addEventListener('visibilitychange', refreshVisibleCatalog);
document.addEventListener('click', event => {
  if (event.target.closest('[data-retry-catalog]')) void fetchProductsFromDB();
});
