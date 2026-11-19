'use strict';
const { shippingConfig } = require('./shippingPolicy');
const { packageProfiles } = require('./parcelPacking');
const { validWebhookKey } = require('./deliveryTracking');

function shippingReadiness(env) {
  const required = ['SHIPROCKET_EMAIL', 'SHIPROCKET_PASSWORD', 'SHIPROCKET_CHANNEL_ID',
    'SHIPROCKET_PICKUP_LOCATION', 'SHIPROCKET_PICKUP_POSTCODE', 'SHIPROCKET_ORDER_PREFIX',
    'SHIPROCKET_PACKAGES', 'SHIPROCKET_WEBHOOK_SECRET'];
  const missing = required.filter(key => !env[key]?.trim() || /replace_with|your_/i.test(env[key]));
  const checks = [];
  for (const [name, check] of [
    ['Production shipping configuration', () => shippingConfig({ ...env, SHIPROCKET_ENABLED: 'true' })],
    ['Measured package profiles', () => packageProfiles(env)],
    ['Webhook security token', () => { if (!validWebhookKey(env.SHIPROCKET_WEBHOOK_SECRET, env.SHIPROCKET_WEBHOOK_SECRET)) throw new Error('Set SHIPROCKET_WEBHOOK_SECRET to an independent secret of at least 32 characters.'); }],
    ['Public HTTPS URL', () => { const url = new URL(env.FRONTEND_URL); if (url.protocol !== 'https:') throw new Error(); }]
  ]) {
    try { check(); checks.push({ name, ok: true }); }
    catch { checks.push({ name, ok: false }); }
  }
  return { enabled: env.SHIPROCKET_ENABLED === 'true', missing, checks,
    configured: !missing.length && checks.every(check => check.ok),
    prepaidLiveKey: Boolean(env.RAZORPAY_KEY_ID?.startsWith('rzp_live_')) };
}
module.exports = { shippingReadiness };
