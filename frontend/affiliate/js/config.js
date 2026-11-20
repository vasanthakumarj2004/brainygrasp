/**
 * Same-origin API routing for EC2/domain deployments.
 * Local split-port development uses port 3000; explicit overrides are optional.
 */
(() => {
  function apiBase() {
    if (typeof window.BG_API_BASE === 'string') return window.BG_API_BASE.replace(/\/+$/, '');

    const { hostname: host, port, protocol, origin } = window.location;
    const localHost = !host || host === 'localhost' || host === '127.0.0.1' ||
      host === '[::1]' || host === '0.0.0.0' || host === 'brainygrasp' ||
      /^10\./.test(host) || /^192\.168\./.test(host) ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(host) || host.endsWith('.local');
    const networkHost = /^10\./.test(host) || /^192\.168\./.test(host) ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(host) || host.endsWith('.local');
    if (networkHost && port === '5500') return origin;
    if (localHost && (protocol === 'file:' || ['5500', '5501'].includes(port))) {
      return `${protocol === 'https:' ? 'https:' : 'http:'}//${host || 'localhost'}:3000`;
    }
    if (typeof window.BG_PRODUCTION_API_URL === 'string') {
      return window.BG_PRODUCTION_API_URL.replace(/\/+$/, '');
    }
    // Keep the current protocol, hostname and port, including www and EC2 IPs.
    return origin;
  }

  window.AFF_CONFIG = { API_BASE: apiBase() };
})();
