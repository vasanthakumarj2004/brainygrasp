/* Customer dashboard: profile, orders and automatically refreshed delivery tracking. */
const API_BASE = (window.BG_CONFIG && window.BG_CONFIG.API_BASE) || '';
const terminalStatuses = new Set(['delivered', 'cancelled', 'canceled', 'rto', 'returned']);
const $ = id => document.getElementById(id);
const normalizedStatus = value => String(value || '').trim().toLowerCase();
const isHistory = order => terminalStatuses.has(normalizedStatus(order.status));
const escapeHTML = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = value => new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' }).format(Number(value) || 0);
let profile = null, orders = [], ordersLoaded = false, ordersRequest = null, profileRequest = null;
let selectedOrderId = '', refreshTimer, toastTimer, savingProfile = false, signedOut = false;

function dateLabel(value, includeTime = false) {
    if (!value || !Number.isFinite(new Date(value).getTime())) return 'Not available';
    return new Date(value).toLocaleString('en-IN', { day: 'numeric', month: 'short', year: 'numeric',
        ...(includeTime ? { hour: '2-digit', minute: '2-digit' } : {}) });
}
function feedback(id, message, error = false) {
    $(id).textContent = message;
    $(id).hidden = !message;
    $(id).classList.toggle('error', error);
}
function clearAuthAndRedirect() {
    signedOut = true;
    clearInterval(refreshTimer);
    ['bg_token', 'bg_user', 'bg_cart', 'redirectAfterLogin', 'postProfileRedirect'].forEach(key => localStorage.removeItem(key));
    document.body.style.visibility = 'hidden';
    window.location.replace('login.html');
}
function checkAuth() {
    if (signedOut || !localStorage.getItem('bg_token')) { clearAuthAndRedirect(); return false; }
    return true;
}
async function apiRequest(path, options = {}) {
    if (!checkAuth()) throw new Error('Please sign in again.');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    try {
        const response = await fetch(API_BASE + path, { ...options, cache: 'no-store', signal: controller.signal,
            headers: { Authorization: 'Bearer ' + localStorage.getItem('bg_token'), ...options.headers } });
        if (response.status === 401 || response.status === 403) {
            clearAuthAndRedirect();
            throw new Error('Your session expired. Please sign in again.');
        }
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Request failed. Please try again.');
        if (signedOut) throw new Error('Please sign in again.');
        return data;
    } catch (error) {
        if (error.name === 'AbortError') throw new Error('The request timed out. Please try again.');
        throw error;
    } finally { clearTimeout(timeout); }
}
function renderProfile(user) {
    profile = user;
    localStorage.setItem('bg_user', JSON.stringify(user));
    $('profileName').textContent = user.name || 'Your profile';
    $('profileEmail').textContent = user.email || 'Not set';
    $('profilePhone').textContent = user.phone || 'Not set';
    $('profileGender').textContent = user.gender || 'Not set';
    $('profileAvatar').textContent = user.name ? user.name.trim().split(/\s+/).map(part => part[0]).join('').toUpperCase().slice(0, 2) : 'U';
    $('profileLocation').textContent = [user.address, user.city, user.state, user.pincode, user.country].filter(Boolean).join(', ') || 'Add your address';
    $('dashboardWelcomeTitle').textContent = user.name ? 'Welcome back, ' + user.name.trim().split(/\s+/)[0] + '!' : 'Welcome to Your Dashboard';
    $('editProfileBtn').disabled = false;
    $('retryProfileBtn').hidden = true;
    feedback('profileFeedback', '');
}
function loadProfile() {
    if (profileRequest) return profileRequest;
    $('retryProfileBtn').disabled = true;
    profileRequest = (async () => {
        try { renderProfile(await apiRequest('/api/auth/me')); }
        catch {
            if (!profile) { $('profileName').textContent = 'Profile unavailable'; $('profileEmail').textContent = ''; }
            feedback('profileFeedback', 'Unable to load your profile. Please retry.', true);
            $('retryProfileBtn').hidden = false;
        } finally { $('retryProfileBtn').disabled = false; profileRequest = null; }
    })();
    return profileRequest;
}
function loadData() { return Promise.allSettled([loadProfile(), loadOrders()]); }
function loadOrders() {
    if (ordersRequest) return ordersRequest;
    $('refreshOrdersBtn').disabled = true;
    $('refreshTrackingBtn').disabled = true;
    ordersRequest = (async () => {
        try {
            // Bypass cached order snapshots so courier updates appear on the next refresh.
            const data = await apiRequest('/api/orders?fresh=1');
            if (!Array.isArray(data)) throw new Error('Invalid order response');
            orders = data;
            ordersLoaded = true;
            renderOrders(orders.filter(order => !isHistory(order)), 'current');
            renderOrders(orders.filter(isHistory), 'history');
            renderTracking();
            feedback('ordersFeedback', '');
            feedback('trackingFeedback', 'Last checked ' + new Date().toLocaleTimeString('en-IN') + '. Updates come from your courier.');
        } catch {
            feedback('ordersFeedback', ordersLoaded ? 'Refresh failed. Showing previously loaded orders. Use Refresh to retry.' : 'Unable to load your orders. Use Refresh to retry.', true);
            feedback('trackingFeedback', ordersLoaded ? 'Tracking could not refresh. These details may be out of date. Use Refresh to retry.' : 'Tracking is unavailable. Use Refresh to retry.', true);
            if (!ordersLoaded) { $('currentOrdersList').innerHTML = ''; $('historyOrdersList').innerHTML = ''; }
        } finally {
            $('refreshOrdersBtn').disabled = false;
            $('refreshTrackingBtn').disabled = false;
            ordersRequest = null;
        }
    })();
    return ordersRequest;
}
function orderItems(order) {
    try {
        const items = typeof order.items === 'string' ? JSON.parse(order.items) : order.items;
        return Array.isArray(items) ? items.filter(item => item && typeof item === 'object') : [];
    } catch { return []; }
}
function getStatusClass(status) {
    const value = normalizedStatus(status);
    if (value === 'delivered') return 'status-delivered';
    if (['shipped', 'out for delivery'].includes(value)) return 'status-shipped';
    return terminalStatuses.has(value) ? 'status-exception' : 'status-placed';
}
function renderOrders(list, type) {
    const container = $(type === 'current' ? 'currentOrdersList' : 'historyOrdersList');
    if (!list.length) {
        container.innerHTML = '<p class="empty-state">No ' + (type === 'current' ? 'current' : 'past') + ' orders yet.' + (type === 'current' ? ' <a href="index.html">Continue shopping</a>' : '') + '</p>';
        return;
    }
    container.innerHTML = list.map(order => {
        const items = orderItems(order);
        const address = [order.line1, order.line2, order.city, order.state, order.pincode].filter(Boolean).join(', ');
        return `<article class="order-card">
            <div class="order-topline">
                <div><div class="order-id">Order #${escapeHTML(order.id)} <span class="order-status ${getStatusClass(order.status)}">${escapeHTML(order.status || 'Status unavailable')}</span></div>
                <div class="order-date">${dateLabel(order.created_at)}</div></div>
                <div class="order-price">${money(order.total)}</div>
            </div>
            <div class="order-items">${items.length ? items.map(item => `<div class="order-item-line">${escapeHTML(item.name || 'Item')} &times; ${escapeHTML(item.quantity ?? 1)} &middot; ${money(item.price)} each</div>`).join('') : '<p>Item details unavailable.</p>'}</div>
            ${order.payment_method ? `<p class="order-date">Payment method: ${escapeHTML(order.payment_method === 'cod' ? 'Cash on delivery' : order.payment_method)}</p>` : ''}
            ${address ? `<div class="order-address"><strong>${escapeHTML(order.full_name || 'Delivery address')}</strong><br>${escapeHTML(address)}</div>` : ''}
            <button type="button" class="btn btn-secondary order-track" data-track-order="${escapeHTML(order.id)}">${type === 'current' ? 'Track order' : 'View delivery details'}</button>
        </article>`;
    }).join('');
}
function renderTrackingBar(order) {
    const status = normalizedStatus(order.status);
    const stages = ['Placed', 'Confirmed', 'Shipped', 'Out for Delivery', 'Delivered'];
    const indices = { placed: 0, paid: 1, confirmed: 1, shipped: 2, 'out for delivery': 3, delivered: 4 };
    const index = Object.hasOwn(indices, status) ? indices[status] : undefined;
    const notices = {
        'payment pending': 'Payment is awaiting confirmation. Shipping starts after payment is confirmed.',
        cancelled: 'This order was cancelled.', canceled: 'This order was cancelled.',
        returned: 'This order was returned.', rto: 'This shipment is returning to the sender or has been returned.'
    };
    const note = (Object.hasOwn(notices, status) ? notices[status] : '') || (index === undefined ? 'Delivery progress is not available for this status. Check the courier status below.' : '');
    return `<div class="tracking-container">
        <div class="tracking-header"><strong>Order #${escapeHTML(order.id)}</strong><span class="order-status ${getStatusClass(order.status)}">${escapeHTML(order.status || 'Status unavailable')}</span></div>
        ${note ? `<p class="tracking-note">${note}</p>` : `<div class="tracking-steps" aria-label="Delivery progress: ${escapeHTML(stages[index])}">
            <div class="tracking-progress-line" style="width:${index * 20}%"></div>
            ${stages.map((stage, i) => `<div class="tracking-step ${i < index ? 'completed' : i === index ? 'active' : ''}" ${i === index ? 'aria-current="step"' : ''}><div class="step-icon">${i < index ? '&#10003;' : i + 1}</div><div class="step-label">${stage}</div></div>`).join('')}
        </div>`}
        ${status === 'payment pending' ? '<p><a href="checkout_cod.html">Resume checkout / check payment</a></p>' : ''}
        <div class="tracking-meta">
            <span>Courier status: <strong>${escapeHTML(order.tracking_status || 'Awaiting courier update')}</strong></span>
            <span>Courier: <strong>${escapeHTML(order.courier_name || 'Not assigned yet')}</strong></span>
            <span>Tracking number (AWB): <strong>${escapeHTML(order.awb_number || 'Not assigned yet')}</strong></span>
            <span>Estimated delivery: <strong>${dateLabel(order.estimated_delivery)}</strong></span>
            <span>Last courier update: <strong>${dateLabel(order.tracking_event_at, true)}</strong></span>
        </div>
    </div>`;
}
function renderTracking() {
    const choices = orders.filter(order => !isHistory(order));
    // Keep the selection when an order is delivered, or opened from history.
    const selected = orders.find(order => String(order.id) === selectedOrderId);
    if (selected && isHistory(selected)) choices.push(selected);
    if (!choices.some(order => String(order.id) === selectedOrderId)) selectedOrderId = choices.length ? String(choices[0].id) : '';
    $('trackingSelectorGroup').hidden = !choices.length;
    $('trackingOrderSelect').innerHTML = choices.map(order => `<option value="${escapeHTML(order.id)}">Order #${escapeHTML(order.id)} — ${escapeHTML(order.status || 'Status unavailable')}</option>`).join('');
    $('trackingOrderSelect').value = selectedOrderId;
    const order = choices.find(item => String(item.id) === selectedOrderId);
    $('trackingDetails').innerHTML = order ? renderTrackingBar(order) : '<p class="empty-state">No active deliveries to track. You can view past delivery details from Order History.</p>';
}
function switchOrderTab(tab) {
    document.querySelectorAll('.order-tab').forEach(button => {
        const active = button.dataset.tab === tab;
        button.setAttribute('aria-pressed', String(active));
        button.classList.toggle('active', active);
        button.style.color = active ? '#667eea' : '#636e72';
        button.style.borderBottom = active ? '3px solid #667eea' : 'none';
    });
    $('currentOrdersSection').style.display = tab === 'current' ? 'block' : 'none';
    $('historyOrdersSection').style.display = tab === 'history' ? 'block' : 'none';
}
function showToast(message, type = 'success') {
    clearTimeout(toastTimer);
    $('dashToast').textContent = message;
    $('dashToast').className = 'toast ' + type + ' show';
    toastTimer = setTimeout(() => $('dashToast').classList.remove('show'), 3500);
}
const modal = $('profileEditModal');
function openModal() {
    if (!profile) return;
    for (const field of ['name', 'email', 'phone', 'address', 'city', 'state', 'pincode', 'country']) {
        $('edit' + field[0].toUpperCase() + field.slice(1)).value = profile[field] || (field === 'country' ? 'India' : '');
    }
    document.querySelectorAll('input[name="gender"]').forEach(radio => { radio.checked = radio.value === profile.gender; });
    feedback('profileSaveFeedback', '');
    modal.style.display = 'flex';
    document.body.style.overflow = 'hidden';
    $('editName').focus();
}
function closeModal() {
    if (savingProfile) return;
    modal.style.display = 'none';
    document.body.style.overflow = '';
    $('editProfileBtn').focus();
}
function handleModalBackdrop(event) { if (event.target === modal) closeModal(); }
$('profileEditForm').onsubmit = async event => {
    event.preventDefault();
    if (savingProfile || !event.target.reportValidity()) return;
    const data = Object.fromEntries(new FormData(event.target));
    Object.keys(data).forEach(key => { data[key] = String(data[key]).trim(); });
    if (!data.name) { feedback('profileSaveFeedback', 'Enter your full name.', true); $('editName').focus(); return; }
    if (data.phone && (!/^[+\d\s()-]+$/.test(data.phone) || !/^\d{7,15}$/.test(data.phone.replace(/\D/g, '')))) {
        feedback('profileSaveFeedback', 'Enter a valid phone number with 7 to 15 digits.', true); $('editPhone').focus(); return;
    }
    if (data.pincode && normalizedStatus(data.country || 'India') === 'india' && !/^[1-9]\d{5}$/.test(data.pincode)) {
        feedback('profileSaveFeedback', 'Enter a valid 6-digit Indian PIN code.', true); $('editPincode').focus(); return;
    }
    savingProfile = true;
    $('saveProfileBtn').disabled = true;
    $('saveProfileBtn').textContent = 'Saving...';
    feedback('profileSaveFeedback', '');
    try {
        const result = await apiRequest('/api/auth/profile', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
        if (!result.success || !result.user) throw new Error('Profile could not be saved. Please retry.');
        renderProfile(result.user);
        savingProfile = false;
        closeModal();
        showToast('Profile updated successfully.');
    } catch (error) { feedback('profileSaveFeedback', error.message || 'Unable to save your profile. Please retry.', true); }
    finally { savingProfile = false; $('saveProfileBtn').disabled = false; $('saveProfileBtn').textContent = 'Save Changes'; }
};
$('editProfileBtn').onclick = openModal;
$('logoutBtn').onclick = clearAuthAndRedirect;
$('retryProfileBtn').onclick = loadProfile;
$('refreshOrdersBtn').onclick = loadOrders;
$('refreshTrackingBtn').onclick = loadOrders;
$('trackingOrderSelect').onchange = event => { selectedOrderId = event.target.value; renderTracking(); };
document.querySelector('.orders-panel').addEventListener('click', event => {
    const button = event.target.closest('[data-track-order]');
    if (!button) return;
    selectedOrderId = button.dataset.trackOrder;
    renderTracking();
    $('liveTrackingSection').scrollIntoView({ behavior: 'smooth', block: 'start' });
    $('trackingOrderSelect').focus({ preventScroll: true });
});
document.addEventListener('keydown', event => {
    if (modal.style.display !== 'flex') return;
    if (event.key === 'Escape') closeModal();
    if (event.key === 'Tab') {
        const controls = [...modal.querySelectorAll('button:not(:disabled), input:not(:disabled), textarea, select')];
        const first = controls[0], last = controls[controls.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }
});
function startRefresh() {
    clearInterval(refreshTimer);
    refreshTimer = setInterval(() => { if (!document.hidden && checkAuth()) loadOrders(); }, 30000);
}
document.addEventListener('visibilitychange', () => { if (!document.hidden && checkAuth()) loadOrders(); });
window.addEventListener('pagehide', () => clearInterval(refreshTimer));
window.addEventListener('pageshow', event => { if (event.persisted && checkAuth()) { loadData(); startRefresh(); } });
window.addEventListener('storage', event => { if (event.key === 'bg_token' || event.key === null) clearAuthAndRedirect(); });
if (checkAuth()) { loadData(); startRefresh(); }
