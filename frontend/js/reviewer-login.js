(() => {
    const base = window.BG_CONFIG?.API_BASE || '';
    const form = document.getElementById('reviewerLoginForm');
    if (!form) return;
    const button = document.getElementById('reviewerLoginBtn');
    const error = document.getElementById('reviewerError');
    let signedIn = null;
    form.addEventListener('submit', async event => {
        event.preventDefault();
        if (button.disabled) return;
        button.disabled = true;
        error.style.display = 'none';
        try {
            if (!signedIn) {
                const response = await fetch(`${base}/api/auth/reviewer-login`, {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ email: document.getElementById('reviewerEmail').value.trim(), password: document.getElementById('reviewerPassword').value })
                });
                if (!response.headers.get('content-type')?.includes('application/json')) {
                    throw Error(`Sign-in service returned an unexpected response (HTTP ${response.status}).`);
                }
                let data;
                try { data = await response.json(); }
                catch { throw Error('Sign-in service returned an invalid response. Please retry.'); }
                if (!response.ok || !data.token || !data.user) throw Error(data.error || 'Verification sign-in failed.');
                signedIn = data;
                window.AuthUnified.storeAuth(data.token, data.user);
                document.getElementById('reviewerPassword').value = '';
            }
            if (!await window.AuthUnified.syncCartOnLogin()) {
                button.textContent = 'Retry cart sync';
                throw Error('Signed in, but your cart could not sync. Retry when connected.');
            }
            let target = localStorage.getItem('redirectAfterLogin') || 'dashboard-new.html';
            const url = new URL(target, window.location.href);
            if (url.origin !== window.location.origin || !/^https?:$/.test(url.protocol)) target = 'dashboard-new.html';
            if (target === 'dashboard.html' || target.endsWith('/dashboard.html')) target = 'dashboard-new.html';
            localStorage.removeItem('redirectAfterLogin');
            if (!signedIn.user.profile_completed) {
                localStorage.setItem('postProfileRedirect', target);
                window.location.replace('profile-setup.html');
            } else window.location.replace(target);
        } catch (err) {
            error.textContent = err.message || 'Unable to connect. Please retry.';
            error.style.display = 'block';
        } finally { button.disabled = false; }
    });
})();
