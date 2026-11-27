/* Affiliate Portal Authentication & Guard Module */
const API_BASE = (window.AFF_CONFIG && window.AFF_CONFIG.API_BASE) || '';

function getAffToken() {
  return localStorage.getItem('bg_aff_token');
}

function getAffUser() {
  try {
    return JSON.parse(localStorage.getItem('bg_aff_user')) || null;
  } catch (e) {
    return null;
  }
}

function checkAuth(requireAuth = true) {
  const token = getAffToken();
  const isLoginPage = window.location.pathname.endsWith('login') || window.location.pathname.endsWith('/affiliate') || window.location.pathname.endsWith('/affiliate/');

  if (requireAuth && !token) {
    if (!isLoginPage) window.location.href = 'login';
  } else if (!requireAuth && token) {
    if (isLoginPage) window.location.href = 'dashboard';
  }
}

async function loginAffiliate(email, password) {
  const msgEl = document.getElementById('loginMsg');
  const btn = document.getElementById('btnLogin');

  if (msgEl) msgEl.style.display = 'none';
  if (btn) { btn.disabled = true; btn.textContent = 'Logging in...'; }

  try {
    const res = await fetch(`${API_BASE}/api/affiliate/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password })
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Login failed');

    localStorage.setItem('bg_aff_token', data.token);
    localStorage.setItem('bg_aff_user', JSON.stringify(data.affiliate));

    window.location.href = 'dashboard';
  } catch (err) {
    if (msgEl) {
      msgEl.className = 'msg-alert error';
      msgEl.textContent = '❌ ' + err.message;
      msgEl.style.display = 'block';
    }
    if (btn) { btn.disabled = false; btn.textContent = 'Sign In to Dashboard'; }
  }
}

async function logoutAffiliate() {
  try {
    const token = getAffToken();
    if (token) {
      const response = await fetch(`${API_BASE}/api/auth/logout`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
      if (!response.ok && response.status !== 401) throw new Error('Unable to sign out');
    }
  } catch { window.alert('Unable to sign out. Check your connection and retry.'); return; }
  localStorage.removeItem('bg_aff_token');
  localStorage.removeItem('bg_aff_user');
  window.location.href = 'login';
}

window.getAffToken = getAffToken;
window.getAffUser = getAffUser;
window.checkAuth = checkAuth;
window.loginAffiliate = loginAffiliate;
window.logoutAffiliate = logoutAffiliate;
