/* BrainGrasp Admin — Orders (live list, detail modal, status updates) */
(function () {
  const {
    requireAuth, bindLogout, adminFetch, showToast, esc, fmtDate, fmtRupee
  } = window.AdminApp;

  if (!requireAuth()) return;
  bindLogout();

  let currentStatus = 'all';
  let currentSearch = '';
  let currentPage = 1;
  let totalOrders = 0;
  let currentOrderId = null;

  const PAGE_SIZE = 20;

  function badgeClass(s) {
    const m = {
      placed: 'b-placed', confirmed: 'b-confirmed', shipped: 'b-shipped',
      'out for delivery': 'b-shipped', delivered: 'b-delivered',
      cancelled: 'b-cancelled', rto: 'b-cancelled', paid: 'b-paid'
    };
    return m[(s || '').toLowerCase()] || 'b-placed';
  }

  async function loadOrders() {
    const tbody = document.getElementById('ordersTbody');
    tbody.innerHTML = '<tr><td colspan="9" class="loading"><i class="fas fa-spinner"></i></td></tr>';

    try {
      const params = new URLSearchParams({ page: currentPage, limit: PAGE_SIZE });
      if (currentStatus !== 'all') params.set('status', currentStatus);
      if (currentSearch) params.set('search', currentSearch);

      const res = await adminFetch(`/admin/orders?${params}`);

      // Guard: treat non-2xx responses as errors so we don't destructure
      // `undefined` out of an error JSON like {"error":"Failed to fetch orders"}
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error || `Server returned ${res.status}`);
      }

      const { orders, total } = await res.json();
      totalOrders = total;
      renderTable(orders);

      const countEl = document.getElementById('orderCount');
      if (countEl) countEl.textContent = `${total} order${total !== 1 ? 's' : ''} total`;

      document.getElementById('pageInfo').textContent =
        `Showing ${orders.length} of ${total} (page ${currentPage})`;
      document.getElementById('prevBtn').disabled = currentPage <= 1;
      document.getElementById('nextBtn').disabled = currentPage * PAGE_SIZE >= total;
    } catch (err) {
      if (err.message !== 'Session expired') {
        tbody.innerHTML = '<tr><td colspan="9" class="no-data">❌ Couldn\'t connect to server — check that the API is running and try again.</td></tr>';

        const countEl = document.getElementById('orderCount');
        if (countEl) countEl.textContent = 'Could not load orders';
        document.getElementById('pageInfo').textContent = '—';
        document.getElementById('prevBtn').disabled = true;
        document.getElementById('nextBtn').disabled = true;
      }
    }
  }

  async function refreshTracking(id, btn) {
    if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i>'; }
    try {
      const res = await adminFetch(`/admin/orders/${id}/refresh-tracking`, { method: 'POST' });
      const data = await res.json();
      if (res.ok && data.success) {
        showToast(`✅ Status updated: ${data.tracking_status || data.status}`, 'ok');
        loadOrders();
      } else {
        showToast(`❌ ${data.error || 'Refresh failed'}`, 'err');
      }
    } catch (err) {
      if (err.message !== 'Session expired') showToast('❌ Network error', 'err');
    } finally {
      if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fas fa-sync-alt"></i> Refresh'; }
    }
  }

  async function pushShiprocket(id, btn, parcel) {
    if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Booking...'; }
    try {
      const res = await adminFetch(`/admin/orders/${id}/push-shiprocket`, { method: 'POST', body: JSON.stringify(parcel ? { parcel } : {}) });
      const data = await res.json();
      if (res.ok && data.success) {
        showToast(data.message || 'Shipment queued. Check booking progress.', 'ok');
        loadOrders();
        await openModal(id);
      } else {
        showToast(`❌ ${data.error || 'Shipment booking failed'}`, 'err');
      }
    } catch (err) {
      if (err.message !== 'Session expired') showToast('❌ Network error', 'err');
    } finally {
      if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fas fa-paper-plane"></i> Book'; }
    }
  }

  function shippingState(o) {
    const details = o.shipping_job_details || {};
    const labels = { awaiting_parcel: 'Parcel review needed', queued: 'Queued for booking', processing: 'Booking in progress', retry: 'Retry scheduled', needs_review: 'Needs attention', completed: 'Pickup requested - documents ready' };
    return details.pickupConfirmed && o.shipping_job_state !== 'completed' ? 'Pickup requested - documents pending' : labels[o.shipping_job_state] || 'Not booked';
  }
  function documentLink(url, label) {
    if (typeof url !== 'string' || !/^https:\/\//i.test(url)) return '';
    return `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${label}</a>`;
  }

  function renderTable(orders) {
    const tbody = document.getElementById('ordersTbody');
    if (!orders.length) {
      tbody.innerHTML = '<tr><td colspan="9" class="no-data">No orders found.</td></tr>';
      return;
    }

    tbody.innerHTML = orders.map(o => {
      const shipStatus = o.tracking_status || o.status || 'Placed';
      const awb = o.awb_number || '—';
      const courier = o.courier_name || '—';
      const payMode = o.payment_review ? 'PAYMENT REVIEW / REFUND' : (o.payment_method || 'COD').toUpperCase();

      const actionBtn = `<button class="btn-push-shipment" data-id="${o.id}" type="button">Shipping details</button>`;

      return `<tr data-id="${o.id}">
        <td><span class="oid">#${o.id}</span></td>
        <td>
          <div style="font-weight:600">${esc(o.customer_name || 'Guest')}</div>
          <div style="font-size:11px;color:var(--muted)">${esc(o.customer_email || '—')}</div>
        </td>
        <td style="font-weight:700;color:var(--green)">${fmtRupee(o.total)}</td>
        <td><span class="badge" style="background:#eef2ff;color:#4f46e5;font-weight:700;">${payMode}</span></td>
        <td><span class="badge ${badgeClass(shipStatus)}">${esc(shipStatus)}</span><div style="font-size:12px">${esc(shippingState(o))}</div></td>
        <td><span style="font-family:monospace;font-size:12px;font-weight:600;color:#334155">${esc(awb)}</span></td>
        <td style="font-size:12px;color:var(--muted)">${esc(courier)}</td>
        <td style="font-size:12px;color:var(--muted)">${fmtDate(o.created_at)}</td>
        <td style="text-align:center" onclick="event.stopPropagation()">
          ${actionBtn}
        </td>
      </tr>`;
    }).join('');

    tbody.querySelectorAll('tr[data-id]').forEach(tr => {
      tr.onclick = () => openModal(tr.dataset.id);
    });

    tbody.querySelectorAll('.btn-refresh-shipment').forEach(btn => {
      btn.onclick = (e) => {
        e.stopPropagation();
        refreshTracking(btn.dataset.id, btn);
      };
    });
    tbody.querySelectorAll('.btn-push-shipment').forEach(btn => {
      btn.onclick = (e) => {
        e.stopPropagation();
        openModal(btn.dataset.id);
      };
    });
  }

  async function openModal(id) {
    currentOrderId = id;
    const overlay = document.getElementById('modalOverlay');
    overlay.classList.add('open');
    document.getElementById('modalInfo').innerHTML =
      '<div style="color:var(--muted);grid-column:1/-1">Loading…</div>';
    document.getElementById('modalShipment').innerHTML = '';
    document.getElementById('modalItems').innerHTML = '';
    document.getElementById('modalTotals').innerHTML = '';

    try {
      const res = await adminFetch(`/admin/orders/${id}`);
      const o = await res.json();

      document.getElementById('modalTitle').textContent = `Order #${o.id} · ${o.status}`;

      const savedAddress = o.shipping_snapshot?.address;
      const addressLine = savedAddress
        ? [savedAddress.full_name, savedAddress.line1, savedAddress.line2, savedAddress.city, savedAddress.state, savedAddress.pincode].filter(Boolean).join(', ')
        : [o.addr_name, o.line1, o.city, o.state, o.pincode].filter(Boolean).join(', ');
      document.getElementById('modalInfo').innerHTML = `
        ${o.payment_review ? `<div class="info-block" style="grid-column:1/-1" role="alert"><label>Captured payment needs review</label><span>Payment ${esc(o.payment_review.payment_id)}: ${fmtRupee(o.payment_review.amount_paise / 100)} ${esc(o.payment_review.currency)}. This order was cancelled and must not be dispatched. Check this payment in the Razorpay dashboard and its existing refund status before issuing any refund. No automatic refund was issued. Record the refund reference in the admin note.</span></div>` : ''}
        <div class="info-block"><label>Customer</label><span>${esc(o.customer_name || 'Guest')}</span></div>
        <div class="info-block"><label>Email</label><span>${esc(o.customer_email || '—')}</span></div>
        <div class="info-block"><label>Phone</label><span>${esc(savedAddress?.phone || o.addr_phone || '—')}</span></div>
        <div class="info-block"><label>Payment</label><span>${esc((o.payment_method || 'cod').toUpperCase())}</span></div>
        <div class="info-block" style="grid-column:1/-1">
          <label>Delivery Address</label><span>${esc(addressLine || '—')}</span>
        </div>
        <div class="info-block"><label>Expected Delivery</label><span>${fmtDate(o.expected_delivery)}</span></div>
        <div class="info-block"><label>Actual Delivery</label><span>${fmtDate(o.delivery_date)}</span></div>
        <div class="info-block"><label>Order Date</label><span>${fmtDate(o.created_at)}</span></div>
        ${o.admin_note ? `<div class="info-block" style="grid-column:1/-1"><label>Admin Note</label><span>${esc(o.admin_note)}</span></div>` : ''}
      `;

      if (o.payment_method === 'cod' && o.status === 'Delivered') {
        const info = document.getElementById('modalInfo');
        if (o.cod_collected_at) {
          info.insertAdjacentHTML('beforeend', '<div class="info-block"><label>COD collection</label><span>Funds collected</span></div>');
        } else {
          info.insertAdjacentHTML('beforeend', '<div class="info-block"><label>COD commission held</label><button type="button" id="confirmCodCollection">Confirm COD funds collected</button></div>');
          document.getElementById('confirmCodCollection').addEventListener('click', async event => {
            if (!window.confirm('Confirm only after verifying that the COD funds were collected. This releases the affiliate commission.')) return;
            const button = event.currentTarget; button.disabled = true;
            try {
              const response = await adminFetch(`/admin/orders/${o.id}/confirm-cod-collection`, { method: 'POST', body: JSON.stringify({ collected: true }) });
              const result = await response.json();
              if (!response.ok) throw new Error(result.error || 'Unable to confirm collection');
              await openModal(o.id);
            } catch (error) { showToast(error.message, 'error'); button.disabled = false; }
          });
        }
      }
      const shipmentEl = document.getElementById('modalShipment');
      const details = o.shipping_job_details || {};
      const parcel = details.parcel || o.shipping_snapshot?.parcel;
      const packing = details.packing || o.shipping_snapshot?.packing;
      const active = ['queued', 'processing', 'retry'].includes(o.shipping_job_state);
      const canBook = !active && o.shipping_job_state !== 'completed' &&
        !['Payment Pending', 'Cancelled', 'RTO'].includes(o.status) && (o.payment_method === 'cod' || Boolean(o.payment_verified_at));
      shipmentEl.innerHTML = `<div style="padding:12px;border:1px solid #cbd5e1;border-radius:8px;font-size:13px">
        <p><strong>${esc(shippingState(o))}</strong> <button type="button" id="reloadBooking">Refresh progress</button></p>
        <p>AWB: ${esc(o.awb_number || 'Pending')} | Courier: ${esc(o.courier_name || 'Pending')}</p>
        ${o.shipping_job_error ? `<p role="alert" style="color:#b91c1c">${esc(o.shipping_job_error)}</p>` : ''}
        ${parcel ? `<p>Parcel: ${esc(parcel.weight)} kg | ${esc(parcel.length)} x ${esc(parcel.breadth)} x ${esc(parcel.height)} cm | Box: ${esc(details.packageCode || o.shipping_snapshot?.packageCode || 'Manual')}</p>` : ''}
        ${packing?.stackCm ? `<p>Pack in one stack: ${esc(packing.stackCm.length)} x ${esc(packing.stackCm.breadth)} x ${esc(packing.stackCm.height)} cm before the outer box.</p>` : ''}
        ${packing?.placements?.length ? `<details><summary>Packing layout (${esc(packing.placements.length)} units)</summary>
          <p>All measurements are in cm, from the same inside corner of the box. X follows length, Y follows breadth, Z is height from the bottom. Orient each wrapped unit to the listed size.</p>
          <div style="max-height:300px;overflow:auto"><table><thead><tr><th>Product / unit</th><th>Position X, Y, Z</th><th>Length × breadth × height</th></tr></thead><tbody>
          ${packing.placements.map(p => `<tr><td>${esc(o.items?.[p.itemIndex]?.name || 'Product')} / ${esc(p.unit)}</td><td>${esc(p.x)}, ${esc(p.y)}, ${esc(p.z)}</td><td>${esc(p.length)} × ${esc(p.breadth)} × ${esc(p.height)}</td></tr>`).join('')}
          </tbody></table></div></details>` : ''}
        <p>${documentLink(details.labelUrl, 'Download label')} ${documentLink(details.manifestUrl, 'Download manifest')}</p>
        ${!parcel && canBook ? `<p>Enter the measured final parcel:</p><div style="display:flex;gap:8px;flex-wrap:wrap">${['weight','length','breadth','height'].map(key => `<label>${key === 'weight' ? 'Weight (kg)' : key + ' (cm)'}<input id="parcel_${key}" type="number" min="${key === 'weight' ? '0.001' : '0.51'}" max="${key === 'weight' ? 100 : 300}" step="0.01" style="width:90px;display:block"></label>`).join('')}</div>` : ''}
        ${canBook ? '<p><button type="button" id="resumeBooking">Queue / resume shipment</button></p>' : ''}
        ${o.awb_number ? '<button type="button" id="refreshRemoteTracking">Refresh courier tracking</button>' : ''}
        <p>For cancellation, cancel the shipment in Shiprocket and refresh its tracking here. Changing a local status does not cancel a pickup.</p>
      </div>`;
      document.getElementById('reloadBooking').addEventListener('click', () => openModal(o.id));
      document.getElementById('refreshRemoteTracking')?.addEventListener('click', async e => { await refreshTracking(o.id, e.currentTarget); await openModal(o.id); });
      document.getElementById('resumeBooking')?.addEventListener('click', e => {
        const manualParcel = parcel ? undefined : Object.fromEntries(['weight','length','breadth','height'].map(key => [key, Number(document.getElementById('parcel_' + key).value)]));
        pushShiprocket(o.id, e.currentTarget, manualParcel);
      });

      const items = Array.isArray(o.items) ? o.items : [];
      document.getElementById('modalItems').innerHTML = items.map(it => `
        <div class="item-row">
          <div>
            <div class="item-name">${esc(it.name || '—')}</div>
            <div class="item-meta">Qty: ${it.quantity || 1} × ${fmtRupee(it.price)}</div>
          </div>
          <div class="item-price">${fmtRupee(it.price * (it.quantity || 1))}</div>
        </div>
      `).join('');

      const shipping = o.shipping || 0;
      document.getElementById('modalTotals').innerHTML = `
        <div style="display:flex;justify-content:space-between;font-size:13px;color:var(--muted)">
          <span>Subtotal</span><span>${fmtRupee(o.subtotal)}</span>
        </div>
        <div style="display:flex;justify-content:space-between;font-size:13px;color:var(--muted);margin-top:4px">
          <span>Shipping</span><span>${shipping > 0 ? fmtRupee(shipping) : 'FREE'}</span>
        </div>
        <div style="display:flex;justify-content:space-between;font-size:13px;margin-top:4px"><span>Discount</span><span>${fmtRupee(o.discount || 0)}</span></div>
        <div style="display:flex;justify-content:space-between;font-size:15px;font-weight:700;margin-top:8px">
          <span>Total</span><span style="color:var(--green)">${fmtRupee(o.total)}</span>
        </div>
      `;

      document.getElementById('statusSelect').value = o.status || 'Placed';
      document.getElementById('expectedDeliveryInput').value =
        o.expected_delivery ? o.expected_delivery.split('T')[0] : '';
      document.getElementById('deliveryDateInput').value =
        o.delivery_date ? o.delivery_date.split('T')[0] : '';
      document.getElementById('adminNoteInput').value = o.admin_note || '';
    } catch (err) {
      if (err.message !== 'Session expired') {
        document.getElementById('modalInfo').innerHTML =
          '<div style="color:var(--red)">Failed to load order.</div>';
      }
    }
  }

  document.getElementById('modalClose')?.addEventListener('click', () => {
    document.getElementById('modalOverlay').classList.remove('open');
  });
  document.getElementById('modalOverlay')?.addEventListener('click', (e) => {
    if (e.target.id === 'modalOverlay') {
      document.getElementById('modalOverlay').classList.remove('open');
    }
  });

  document.getElementById('saveStatusBtn')?.addEventListener('click', async () => {
    if (!currentOrderId) return;
    const btn = document.getElementById('saveStatusBtn');
    btn.disabled = true;
    btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Saving…';

    try {
      const res = await adminFetch(`/admin/orders/${currentOrderId}/status`, {
        method: 'PUT',
        body: JSON.stringify({
          status: document.getElementById('statusSelect').value,
          expected_delivery: document.getElementById('expectedDeliveryInput').value || null,
          delivery_date: document.getElementById('deliveryDateInput').value || null,
          admin_note: document.getElementById('adminNoteInput').value || null
        })
      });

      if (res.ok) {
        showToast('✅ Order updated successfully!', 'ok');
        document.getElementById('modalOverlay').classList.remove('open');
        loadOrders();
      } else {
        showToast('❌ Failed to update order', 'err');
      }
    } catch (err) {
      if (err.message !== 'Session expired') showToast('❌ Network error', 'err');
    } finally {
      btn.disabled = false;
      btn.innerHTML = '<i class="fas fa-save"></i> Save Changes';
    }
  });

  document.querySelectorAll('.filter-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      currentStatus = btn.dataset.status;
      currentPage = 1;
      loadOrders();
    });
  });

  let searchTimer;
  document.getElementById('searchInput')?.addEventListener('input', (e) => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      currentSearch = e.target.value.trim();
      currentPage = 1;
      loadOrders();
    }, 400);
  });

  document.getElementById('prevBtn')?.addEventListener('click', () => {
    currentPage--;
    loadOrders();
  });
  document.getElementById('nextBtn')?.addEventListener('click', () => {
    currentPage++;
    loadOrders();
  });

  loadOrders();
})();
