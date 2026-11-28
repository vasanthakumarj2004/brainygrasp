document.addEventListener('DOMContentLoaded', () => {
      checkAuth(false);

      const form = document.getElementById('affLoginForm');
      form.addEventListener('submit', (e) => {
        e.preventDefault();
        const email = document.getElementById('email').value;
        const password = document.getElementById('password').value;
        loginAffiliate(email, password);
      });
    });
