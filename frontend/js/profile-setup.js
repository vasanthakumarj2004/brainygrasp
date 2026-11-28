document.addEventListener('DOMContentLoaded', function() {
            const form = document.getElementById('profileSetupForm');
            const progressFill = document.getElementById('progressFill');
            const progressPercent = document.getElementById('progressPercent');

            // Auth guard
            const token = localStorage.getItem('bg_token');
            if (!token) { window.location.href = 'login'; return; }

            // Determine where to go after profile save
            // postProfileRedirect is set by auth-unified.js during login
            let postRedirect = (localStorage.getItem('postProfileRedirect') || 'dashboard').replace(/\.html(?=[?#]|$)/, '');

            // Handle legacy localStorage values
            if (postRedirect === 'dashboard-new' || postRedirect.endsWith('/dashboard-new')) {
                postRedirect = 'dashboard';
            }

            // Update skip link to go to postRedirect too
            const skipLink = document.getElementById('skipLink');
            if (skipLink) {
                skipLink.addEventListener('click', (e) => {
                    e.preventDefault();
                    localStorage.removeItem('postProfileRedirect');
                    window.location.href = postRedirect;
                });
            }

            // Progress Tracker
            function updateProgress() {
                const requiredFields = form.querySelectorAll('[required]');
                let filled = 0;

                requiredFields.forEach(field => {
                    if (field.type === 'radio') {
                        if (form.querySelector(`input[name="${field.name}"]:checked`)) filled++;
                    } else {
                        if (field.value.trim() !== '') filled++;
                    }
                });

                // Deduplicate radio groups for count
                const totalSteps = requiredFields.length - 2; // Adjusting for 3 radios = 1 choice
                const percentage = Math.min(Math.round((filled / 7) * 100), 100);

                progressFill.style.width = percentage + '%';
                progressPercent.textContent = percentage + '%';
            }

            form.querySelectorAll('input, textarea').forEach(input => {
                input.addEventListener('input', updateProgress);
                input.addEventListener('change', updateProgress);
            });

            // Handle Submit (Simplified for your existing logic)
            form.addEventListener('submit', async function(e) {
                e.preventDefault();
                const saveBtn = document.getElementById('saveProfileBtn');
                saveBtn.disabled = true;
                saveBtn.textContent = 'Saving...';

                // Collecting Data
                const formData = {
                    name: document.getElementById('fullName').value.trim(),
                    gender: form.querySelector('input[name="gender"]:checked').value,
                    phone: document.getElementById('phone').value.trim(),
                    address: document.getElementById('address').value.trim(),
                    city: document.getElementById('city').value.trim(),
                    state: document.getElementById('state').value.trim(),
                    pincode: document.getElementById('pincode').value.trim(),
                    country: "India"
                };

                try {
                    const response = await fetch(`${(window.BG_CONFIG && window.BG_CONFIG.API_BASE) || ''}/api/auth/profile`, {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'Authorization': `Bearer ${token}`
                        },
                        body: JSON.stringify(window.CustomerValidation.profile(formData))
                    });

                    const data = await response.json();
                    if (data.success) {
                        // Update local user data
                        if (data.user) {
                            localStorage.setItem('bg_user', JSON.stringify(data.user));
                        }
                        const successMsg = document.getElementById('successMessage');
                        if (successMsg) {
                            successMsg.textContent = postRedirect.includes('checkout')
                                ? '✅ Profile saved! Taking you to checkout...'
                                : '✅ Profile saved! Taking you to your dashboard...';
                            successMsg.style.display = 'block';
                        }
                        localStorage.removeItem('postProfileRedirect');
                        setTimeout(() => window.location.href = postRedirect, 1800);
                    } else {
                        throw new Error(data.error || 'Save failed');
                    }
                } catch (err) {
                    showAuthError('profileSaveError', err.message || 'Error saving profile. Please try again.');
                    saveBtn.disabled = false;
                    saveBtn.textContent = 'Save & Continue';
                }
            });

            // Initial call
            updateProgress();
        });
