'use strict';

class ShippingError extends Error {
  constructor(code, message, { status = 409, retryable = false, ambiguous = false } = {}) {
    super(message); Object.assign(this, { code, status, retryable, ambiguous });
  }
}

function shippingConfig(env) {
  if (env.SHIPROCKET_ENABLED !== 'true') throw new ShippingError('disabled', 'Shipping is disabled in server settings.', { status: 503 });
  if (env.NODE_ENV !== 'production') throw new ShippingError('environment', 'Real shipping requires the production environment.');
  for (const key of ['SHIPROCKET_EMAIL', 'SHIPROCKET_PASSWORD', 'SHIPROCKET_PICKUP_LOCATION']) {
    if (!env[key]?.trim() || /your_|replace_with/i.test(env[key])) throw new ShippingError('configuration', `Configure ${key} before enabling shipping.`, { status: 503 });
  }
  if (!/^[1-9]\d*$/.test(env.SHIPROCKET_CHANNEL_ID || '') || !/^\d{6}$/.test(env.SHIPROCKET_PICKUP_POSTCODE || '') ||
      !/^[1-9]\d{0,7}$/.test(env.SHIPROCKET_ORDER_PREFIX || '') || (env.SHIPROCKET_WEBHOOK_SECRET || '').length < 32 || /replace_with|your_/i.test(env.SHIPROCKET_WEBHOOK_SECRET || '')) {
    throw new ShippingError('configuration', 'Configure the channel, pickup PIN, numeric order prefix and webhook secret.', { status: 503 });
  }
  return { channelId: env.SHIPROCKET_CHANNEL_ID, pickup: env.SHIPROCKET_PICKUP_LOCATION,
    postcode: env.SHIPROCKET_PICKUP_POSTCODE, prefix: env.SHIPROCKET_ORDER_PREFIX };
}

function eligibleOrder(order) {
  if (!order || !['Placed', 'Paid', 'Confirmed'].includes(order.status)) throw new ShippingError('order_status', 'This order is not eligible for shipment booking.');
  if (order.payment_method === 'razorpay') {
    if (!order.payment_verified_at || !order.payment_id || !order.razorpay_order_id || !order.razorpay_key_id?.startsWith('rzp_live_')) {
      throw new ShippingError('payment', 'Only verified live payments can create prepaid shipments. Test and unverified payments are blocked.');
    }
  } else if (order.payment_method !== 'cod') throw new ShippingError('payment', 'Unsupported payment method.');
}

function eligibleBooking(order, details = {}) {
  // Existing shipments may have advanced through tracking while pickup or
  // document responses were lost. Never apply this exception to new bookings.
  const recovering = details.remoteOrderId && details.shipmentId && details.awb &&
    ['Shipped', 'Out for Delivery', 'Delivered'].includes(order?.status);
  eligibleOrder(recovering ? { ...order, status: 'Confirmed' } : order);
}

function parcelDetails(input = {}) {
  const result = {};
  for (const key of ['weight', 'length', 'breadth', 'height']) {
    const value = input[key];
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= (key === 'weight' ? 0 : 0.5) || value > (key === 'weight' ? 100 : 300)) {
      throw new ShippingError('parcel', 'Enter packed weight (0–100 kg) and dimensions (over 0.5–300 cm).', { status: 400 });
    }
    result[key] = value;
  }
  return result;
}

function orderAmounts(order) {
  const values = [order.subtotal, order.shipping, order.discount, order.total];
  if (values.some(n => !Number.isSafeInteger(n) || n < 0) || order.total < 1 || order.subtotal + order.shipping - order.discount !== order.total) {
    throw new ShippingError('amount', 'Order amounts need reconciliation before shipping.');
  }
  const items = order.items;
  if (!Array.isArray(items) || !items.length || items.some(i => !Number.isInteger(i.quantity) || i.quantity < 1 || !Number.isSafeInteger(i.price) || i.price < 0) ||
      items.reduce((sum, i) => sum + i.price * i.quantity, 0) !== order.subtotal) throw new ShippingError('amount', 'Order item prices do not match the saved total.');
  return { subtotal: order.subtotal, shipping: order.shipping, discount: order.discount, total: order.total };
}

const statusMap = { NEW: 'Placed', 'AWB ASSIGNED': 'Confirmed', 'PENDING PICKUP': 'Confirmed', 'PICKUP GENERATED': 'Confirmed',
  'PICKUP SCHEDULED': 'Confirmed', 'PICKUP QUEUED': 'Confirmed', 'PICKUP BOOKED': 'Confirmed', 'OUT FOR PICKUP': 'Confirmed',
  'PICKED UP': 'Shipped', SHIPPED: 'Shipped', 'IN TRANSIT': 'Shipped', 'REACHED DESTINATION': 'Shipped', 'REACHED AT DESTINATION HUB': 'Shipped',
  'OUT FOR DELIVERY': 'Out for Delivery', DELIVERED: 'Delivered', CANCELED: 'Cancelled', CANCELLED: 'Cancelled',
  'CANCELLED BEFORE DISPATCHED': 'Cancelled', 'RTO INITIATED': 'RTO', 'RTO IN TRANSIT': 'RTO', 'RTO DELIVERED': 'RTO', LOST: 'RTO', DAMAGED: 'RTO' };
function mapShiprocketStatus(value) { return statusMap[String(value || '').trim().toUpperCase().replace(/_/g, ' ')] || null; }
function nextTrackingStatus(current, incoming) {
  if (!incoming || current === 'Payment Pending') return null;
  if (['Delivered', 'Cancelled', 'RTO'].includes(current)) return incoming === current ? current : null;
  const rank = { Placed: 0, Paid: 0, Confirmed: 1, Shipped: 2, 'Out for Delivery': 3, Delivered: 4, Cancelled: 4, RTO: 4 };
  return rank[incoming] >= (rank[current] ?? 0) ? incoming : null;
}
function eventTime(value) {
  if (!value || typeof value !== 'string') return null;
  const match = value.match(/^(\d{2}) (\d{2}) (\d{4}) (\d{2}:\d{2}:\d{2})$/);
  const iso = match ? `${match[3]}-${match[2]}-${match[1]}T${match[4]}+05:30` : value;
  if (!/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(iso)) return null;
  const time = new Date(iso);
  return Number.isFinite(time.getTime()) ? time.toISOString() : null;
}
module.exports = { ShippingError, shippingConfig, eligibleOrder, eligibleBooking, parcelDetails, orderAmounts, mapShiprocketStatus, nextTrackingStatus, eventTime };
