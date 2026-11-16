'use strict';

const client = require('./shiprocketService');
const { ShippingError, shippingConfig, eligibleOrder } = require('./shippingPolicy');
const { packageProfiles, packItems } = require('./parcelPacking');

async function prepareShipping(priced, address, method, { env = process.env, shippingClient = client } = {}) {
  try {
    const snapshot = { version: 1, address: { full_name: address.full_name, phone: address.phone, line1: address.line1,
      line2: address.line2 || '', city: address.city, state: address.state, pincode: address.pincode }, autoBook: false };
    // Never retroactively activate development orders when shipping is enabled.
    if (env.SHIPROCKET_ENABLED !== 'true') return { ...snapshot, holdReason: 'Shipping was disabled at checkout. Review before booking.' };
    const config = shippingConfig(env);
    if (method === 'razorpay' && !env.RAZORPAY_KEY_ID?.startsWith('rzp_live_')) {
      throw new ShippingError('payment', 'Online checkout is not ready for live shipping.', { status: 503 });
    }
    const packed = packItems(priced.items, packageProfiles(env));
    const courier = await shippingClient.checkServiceability({ pickupPostcode: config.postcode, deliveryPostcode: address.pincode,
      parcel: packed.parcel, cod: method === 'cod', orderValue: priced.total });
    return { ...snapshot, ...packed, config, autoBook: true, courierAtCheckout: courier, checkedAt: new Date().toISOString() };
  } catch (err) {
    // This helper runs only before a new order exists, never on a resumed order.
    if (err instanceof ShippingError) err.checkoutRejected = true;
    throw err;
  }
}

function confirmationJob(order) {
  const snapshot = order.shipping_snapshot;
  if (!snapshot?.autoBook) return { state: 'awaiting_parcel', details: {}, error: snapshot?.holdReason || 'Review parcel details before booking.' };
  try { eligibleOrder(order); }
  catch (err) { return { state: 'needs_review', details: {}, error: err.message }; }
  return { state: 'queued', details: { parcel: snapshot.parcel, config: snapshot.config, packageCode: snapshot.packageCode,
    packing: snapshot.packing, reference: `${snapshot.config.prefix}${String(order.id).padStart(10, '0')}` }, error: null };
}

module.exports = { prepareShipping, confirmationJob };
