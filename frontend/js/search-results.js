'use strict';

document.addEventListener('DOMContentLoaded', () => {
  const query = (new URLSearchParams(window.location.search).get('q') || '').trim().slice(0, 100);
  const container = document.getElementById('productsContainer');
  const stats = document.getElementById('searchStats');
  const pagination = document.getElementById('pagination');
  const dialog = document.getElementById('searchQuickView');
  const money = value => `₹${Number(value || 0).toLocaleString('en-IN')}`;
  let matches = [], page = 1, viewedId = null;
  document.getElementById('catalogQuery').value = query;
  document.getElementById('searchQuery').textContent = query ? `Results for "${query}"` : 'Enter a product name, category or theme above.';

  function checked(selector) { return Array.from(document.querySelectorAll(selector)).map(input => input.value); }
  function filterOptions(id, values) {
    const selected = new Set(checked(`#${id} input:checked`));
    document.getElementById(id).innerHTML = values.map((value, index) => `<label class="filter-option" for="${id}_${index}">
      <input id="${id}_${index}" type="checkbox" value="${catalogEscape(value)}" ${selected.has(value) ? 'checked' : ''}> ${catalogEscape(value)}</label>`).join('');
  }
  function render() {
    const categories = checked('#searchCategoryFilters input:checked');
    const ages = checked('#searchAgeFilters input:checked');
    const ranges = checked('#searchFilters input[id^="price-"]:checked');
    const filtered = matches.filter(p => (!categories.length || categories.includes(p.category)) &&
      (!ages.length || ages.includes(p.ageGroup)) && (!ranges.length || ranges.some(range =>
        range === '0-500' ? p.price < 500 : range === '500-1000' ? p.price >= 500 && p.price <= 1000 :
        range === '1000-2000' ? p.price > 1000 && p.price <= 2000 : p.price > 2000)));
    const pages = Math.ceil(filtered.length / 12);
    page = Math.max(1, Math.min(page, pages || 1));
    stats.textContent = `${filtered.length} product${filtered.length === 1 ? '' : 's'} found`;
    const visible = filtered.slice((page - 1) * 12, page * 12);
    container.innerHTML = visible.length ? `<div class="products-grid">${visible.map(p => `<article class="product-card">
      <img class="product-image" src="${catalogEscape(productImageUrl(p.image))}" alt="${catalogEscape(p.name)}" loading="lazy" onerror="this.onerror=null;this.src=productImageUrl(null)">
      <div class="product-info"><h3 class="product-name">${catalogEscape(p.name)}</h3>
      <p class="product-category">${catalogEscape(p.category || '')}</p><p>${catalogEscape(p.age || p.ageGroup || '')}</p>
      <p class="product-price">${money(p.price)} ${p.originalPrice > p.price ? `<del>${money(p.originalPrice)}</del>` : ''}</p>
      <div class="product-actions"><button class="btn-add-to-cart" data-search-add="${Number(p.id)}">Add to Cart</button>
      <button class="btn-quick-view" data-search-view="${Number(p.id)}">View details</button></div></div></article>`).join('')}</div>`
      : '<div class="no-results"><h2>No matching products</h2><p>Try another search or change the filters.</p></div>';
    pagination.innerHTML = pages > 1 ? `<button data-search-page="${page-1}" ${page === 1 ? 'disabled' : ''}>Previous</button>
      <span>Page ${page} of ${pages}</span><button data-search-page="${page+1}" ${page === pages ? 'disabled' : ''}>Next</button>` : '';
  }
  function refresh(success) {
    if (!success) {
      matches = [];
      stats.textContent = 'Products are temporarily unavailable';
      container.innerHTML = '<div class="no-results" role="alert"><p>We could not load the catalog.</p><button data-retry-catalog>Retry</button></div>';
      pagination.innerHTML = '';
      if (dialog.open) dialog.close();
      return;
    }
    matches = query ? (window.catalogProducts || []).filter(p => [p.name, p.category, p.theme, p.groupName, ...(p.skills || [])]
      .some(value => String(value || '').toLowerCase().includes(query.toLowerCase()))) : [];
    filterOptions('searchCategoryFilters', [...new Set(matches.map(p => p.category).filter(Boolean))].sort());
    filterOptions('searchAgeFilters', [...new Set(matches.map(p => p.ageGroup).filter(Boolean))].sort());
    render();
    if (dialog.open && viewedId) showDetails(viewedId);
  }
  function showDetails(id) {
    const p = (window.catalogProducts || []).find(p => Number(p.id) === id);
    if (!p) { if (dialog.open) dialog.close(); return; }
    viewedId = id;
    document.getElementById('searchQuickViewContent').innerHTML = `<h2 id="searchQuickViewTitle">${catalogEscape(p.name)}</h2>
      <img src="${catalogEscape(productImageUrl(p.image))}" alt="${catalogEscape(p.name)}" style="width:100%;max-height:280px;object-fit:contain" onerror="this.onerror=null;this.src=productImageUrl(null)">
      <p>${money(p.price)} ${p.originalPrice > p.price ? `<del>${money(p.originalPrice)}</del>` : ''}</p>
      <p>${catalogEscape(p.category || '')} · ${catalogEscape(p.age || p.ageGroup || '')}</p>
      ${productDetailsHTML(p)}<p>${catalogEscape(p.offer || '')}</p>
      <div class="search-product-gallery">${(p.details?.images || []).slice(1).map(picture => `<figure><img src="${catalogEscape(productImageUrl(picture.src))}" alt="${catalogEscape(p.name + ' - ' + picture.label)}" loading="lazy"><figcaption>${catalogEscape(picture.label)}</figcaption></figure>`).join('')}</div>
      <button data-search-add="${id}">Add to Cart</button> <a href="cart.html">View cart</a>`;
    if (!dialog.open) dialog.showModal();
  }
  document.getElementById('searchFilters').addEventListener('change', () => { page = 1; render(); });
  document.addEventListener('click', event => {
    const add = event.target.closest('[data-search-add]');
    const view = event.target.closest('[data-search-view]');
    const next = event.target.closest('[data-search-page]');
    if (add) {
      const p = (window.catalogProducts || []).find(p => Number(p.id) === Number(add.dataset.searchAdd));
      if (!p) return;
      try {
        window.addToCart({ id: Number(p.id), name: p.name, price: p.price, image: productImageUrl(p.image) });
        document.getElementById('searchFeedback').textContent = `${p.name} added to your cart.`;
      } catch { document.getElementById('searchFeedback').textContent = 'Unable to save your cart. Please retry.'; }
    } else if (view) showDetails(Number(view.dataset.searchView));
    else if (next && !next.disabled) { page = Number(next.dataset.searchPage); render(); }
  });
  document.addEventListener('productsUpdated', event => refresh(event.detail?.success));
  // Handles cached/back-forward page activation after data has already arrived.
  if (window.catalogProducts?.length) refresh(true);
});
