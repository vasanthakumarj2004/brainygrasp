'use strict';

const fields = ['id', 'status', 'total', 'subtotal', 'shipping', 'discount', 'promo_code', 'items',
  'payment_method', 'payment_id', 'payment_verified_at', 'razorpay_key_id', 'created_at',
  'expected_delivery', 'delivery_date', 'tracking_status', 'tracking_event_at', 'estimated_delivery',
  'courier_name', 'awb_number', 'full_name', 'line1', 'line2', 'city', 'state', 'pincode'];

function customerOrder(order) {
  const safe = Object.fromEntries(fields.filter(key => Object.hasOwn(order, key)).map(key => [key, order[key]]));
  safe.payment_review = Boolean(order.payment_review);
  if (order.shipment_progress) safe.shipment_progress = Object.fromEntries(
    ['state', 'phase', 'pickup_requested', 'pickup_scheduled_date'].map(key => [key, order.shipment_progress[key]]));
  return safe;
}
module.exports = { customerOrder };
