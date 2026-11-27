'use strict';

const { ShippingError, shippingConfig, eligibleOrder, orderAmounts, parcelDetails, mapShiprocketStatus, eventTime } = require('./shippingPolicy');
const API = 'https://apiv2.shiprocket.in/v1/external';
const statusName = value => String(value || '').trim().toUpperCase().replace(/_/g, ' ').replace(/\s+/g, ' ');

function trackingTime(tracking, shipment) {
  const status = statusName(shipment.current_status);
  // The tracking API supplies scan dates, not necessarily shipment.updated_at.
  // Only a scan for the current status may date that status; unrelated newer
  // scans must not make an old snapshot overwrite a newer webhook.
  const activities = Array.isArray(tracking.shipment_track_activities) ? tracking.shipment_track_activities : [];
  const times = activities.filter(activity => {
    if (!activity || typeof activity !== 'object') return false;
    const label = statusName(activity['sr-status-label']);
    if (label) return label === status;
    const code = String(activity['sr-status'] ?? '');
    return /^\d+$/.test(code) && code === String(tracking.shipment_status);
  }).map(activity => eventTime(activity.date)).filter(Boolean).sort();
  return (status === 'DELIVERED' ? eventTime(shipment.delivered_date) : null) ||
    times.at(-1) || eventTime(shipment.updated_at);
}

function createShiprocketClient({ env = process.env, fetchImpl = globalThis.fetch } = {}) {
  let token = null, expires = 0, loginPromise = null;
  async function request(path, options = {}) {
    let res;
    try { res = await fetchImpl(API + path, { ...options, signal: AbortSignal.timeout(12000) }); }
    catch { throw new ShippingError('network', 'Shiprocket request timed out or could not connect.', { retryable: true, ambiguous: options.method === 'POST' }); }
    let data;
    try { data = await res.json(); }
    catch { throw new ShippingError('response', 'Shiprocket returned an unreadable response.', { retryable: true, ambiguous: options.method === 'POST' }); }
    if (!res.ok) throw new ShippingError(`http_${res.status}`, `Shiprocket rejected the request (HTTP ${res.status}).`,
      { status: 502, retryable: res.status === 429 || res.status >= 500, ambiguous: options.method === 'POST' && res.status >= 500 });
    return data;
  }
  async function getToken() {
    shippingConfig(env);
    if (token && Date.now() < expires) return token;
    if (!loginPromise) loginPromise = (async () => {
      const data = await request('/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: env.SHIPROCKET_EMAIL, password: env.SHIPROCKET_PASSWORD }) });
      if (typeof data.token !== 'string' || !data.token) throw new ShippingError('authentication', 'Shiprocket did not return an authentication token.');
      token = data.token; expires = Date.now() + 10 * 86400000 - 1800000;
      return token;
    })().catch(err => {
      // Login cannot create a shipment, assign an AWB or request pickup. Even
      // after a 401 refresh, a failed login is safe to retry at the same stage.
      if (err instanceof ShippingError) err.ambiguous = false;
      throw err;
    }).finally(() => { loginPromise = null; });
    return loginPromise;
  }
  async function call(path, body, retry = true) {
    const auth = await getToken();
    try { return await request(path, { method: body === undefined ? 'GET' : 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${auth}` }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); }
    catch (err) {
      // A rejected authentication request did not execute the booking operation.
      if (err.code === 'http_401' && retry) { if (token === auth) { token = null; expires = 0; } return call(path, body, false); }
      throw err;
    }
  }
  async function checkServiceability({ pickupPostcode, deliveryPostcode, parcel, cod, orderValue }) {
    const p = parcelDetails(parcel);
    const qs = new URLSearchParams({ pickup_postcode: pickupPostcode, delivery_postcode: deliveryPostcode,
      weight: String(p.weight), length: String(p.length), breadth: String(p.breadth), height: String(p.height), cod: cod ? '1' : '0',
      ...(orderValue ? { declared_value: String(orderValue) } : {}) });
    const data = await call(`/courier/serviceability/?${qs}`);
    const available = data?.data?.available_courier_companies;
    if (!Array.isArray(available)) throw new ShippingError('serviceability', 'Shiprocket returned no courier availability.', { retryable: true });
    const couriers = available.filter(c => Number.isInteger(Number(c.courier_company_id)) && Number(c.courier_company_id) > 0);
    const preferred = couriers.find(c => Number(c.courier_company_id) === Number(data.data.recommended_courier_company_id));
    const chosen = preferred || couriers.filter(c => Number.isFinite(Number(c.rate))).sort((a,b) => Number(a.rate)-Number(b.rate))[0];
    if (!chosen) throw new ShippingError('unserviceable', 'No courier is available for this parcel, PIN code and payment method.', { retryable: true, status: 409 });
    return { id: Number(chosen.courier_company_id), name: String(chosen.courier_name || ''),
      rate: chosen.rate != null && Number.isFinite(Number(chosen.rate)) ? Number(chosen.rate) : null };
  }
  function shipmentPayload(order, address, user, parcel, config, reference) {
    const amount = orderAmounts(order);
    return { order_id: reference, order_date: new Date(order.created_at).toISOString().slice(0,10),
      pickup_location: config.pickup, channel_id: Number(config.channelId), comment: `BrainyGrasp Order #${order.id}`,
      billing_customer_name: address.full_name, billing_last_name: '', billing_address: address.line1,
      billing_address_2: address.line2 || '', billing_city: address.city, billing_state: address.state,
      billing_pincode: address.pincode, billing_country: 'India', billing_email: user.email || '', billing_phone: address.phone,
      shipping_is_billing: true, order_items: order.items.map(i => ({ name: i.name, sku: `SKU-${i.id}`, units: i.quantity, selling_price: i.price, discount: 0 })),
      payment_method: order.payment_method === 'cod' ? 'COD' : 'Prepaid',
      // Adhoc API expects the calculated order value after adjustments. Read back
      // the remote total before AWB assignment to catch any amount mismatch.
      sub_total: amount.total, shipping_charges: amount.shipping, total_discount: amount.discount,
      giftwrap_charges: 0, transaction_charges: 0, ...parcelDetails(parcel) };
  }
  async function createShipment(order, address, user, parcel, config, reference) {
    eligibleOrder(order);
    const data = await call('/orders/create/adhoc', shipmentPayload(order,address,user,parcel,config,reference));
    const value = data.payload || data;
    if (!value.shipment_id || !value.order_id) throw new ShippingError('create_response', 'Shipment creation must be reconciled with Shiprocket.', { ambiguous: true, retryable: true });
    return { remoteOrderId: String(value.order_id), shipmentId: String(value.shipment_id) };
  }
  async function findOrder(reference, config) {
    const params = new URLSearchParams({ filter_by: 'channel_order_id', filter: reference, channel_id: config.channelId, per_page: '100' });
    const result = await call(`/orders?${params}`);
    if (!Array.isArray(result.data)) throw new ShippingError('lookup', 'Unable to reconcile Shiprocket orders.', { retryable: true });
    const matches = result.data.filter(o => String(o.channel_order_id) === reference && String(o.channel_id) === String(config.channelId));
    if (matches.length > 1) throw new ShippingError('duplicate_remote', 'Multiple remote orders need manual reconciliation.');
    return matches[0] ? String(matches[0].id) : null;
  }
  async function getOrder(remoteId, order, config, reference) {
    if (!/^\d+$/.test(String(remoteId))) throw new ShippingError('remote_id', 'Invalid shipment order identifier.');
    const result = await call(`/orders/show/${remoteId}`);
    const data = result.data;
    if (!data || String(data.channel_order_id) !== reference || String(data.channel_id) !== String(config.channelId) ||
      !Number.isFinite(Number(data.total)) || Math.round(Number(data.total) * 100) !== order.total * 100 ||
      String(data.payment_method).toLowerCase() !== (order.payment_method === 'cod' ? 'cod' : 'prepaid')) {
      throw new ShippingError('remote_mismatch', 'Remote order amount, reference, channel or payment method does not match. Check Shiprocket before continuing.');
    }
    if (['CANCELED','CANCELLED','CANCELLATION REQUESTED','RTO INITIATED','RTO DELIVERED'].includes(String(data.status).toUpperCase())) {
      throw new ShippingError('remote_status', 'The remote order is cancelled or returning. Review it in Shiprocket.');
    }
    const shipments = Array.isArray(data.shipments) ? data.shipments : data.shipments ? [data.shipments] : [];
    if (shipments.length !== 1 || !shipments[0].id) throw new ShippingError('remote_shipment', 'Remote shipment details require review.', { retryable: true });
    const shipment = shipments[0];
    // A scheduled date may survive a failed pickup. Explicit failure always
    // overrides both that date and a previously saved pickup confirmation.
    const pickupFailed = [13, 20].includes(Number(shipment.status_id)) ||
      [data.status, shipment.status, shipment.current_status].some(value =>
        ['PICKUP ERROR', 'PICKUP EXCEPTION', 'PICKUP FAILED'].includes(statusName(value)));
    return { remoteOrderId: String(data.id), shipmentId: String(shipment.id), awb: String(shipment.awb || shipment.awb_code || ''),
      courierName: String(shipment.courier || shipment.courier_name || ''),
      pickupFailed,
      pickupConfirmed: !pickupFailed && (Boolean(shipment.pickup_scheduled_date) || [3,5,6,7,17,18,19,42].includes(Number(shipment.status_id))) };
  }
  async function assignAWB(shipmentId, courierId) {
    const data = await call('/courier/assign/awb', { shipment_id: Number(shipmentId), courier_id: courierId });
    if (Number(data.awb_assign_status) !== 1 || !data.response?.data?.awb_code) {
      throw new ShippingError('awb_rejected', 'AWB assignment was not confirmed. Check wallet balance and courier availability.', { retryable: true });
    }
    return { awb: String(data.response.data.awb_code), courierName: String(data.response.data.courier_name || '') };
  }
  async function generatePickup(shipmentId, retry = false) {
    const data = await call('/courier/generate/pickup', { shipment_id: [Number(shipmentId)], ...(retry ? { status: 'retry' } : {}) });
    if (Number(data.pickup_status) !== 1) throw new ShippingError('pickup_rejected', 'Shiprocket has not confirmed pickup. The existing shipment will be retried.', { retryable: true });
    return { pickupConfirmed: true, pickupScheduledDate: data.response?.pickup_scheduled_date || null };
  }
  async function generateDocument(kind, shipmentId) {
    const path = kind === 'label' ? '/courier/generate/label' : '/manifests/generate';
    const data = await call(path, { shipment_id: [Number(shipmentId)] });
    const url = data[`${kind}_url`];
    if (typeof url !== 'string' || !/^https:\/\//i.test(url)) {
      throw new ShippingError('document_pending', `Pickup is confirmed but the ${kind} is not ready.`, { retryable: true });
    }
    return url;
  }
  async function getTracking(awb) {
    const data = await call(`/courier/track/awb/${encodeURIComponent(awb)}`);
    const t = data.tracking_data, s = t?.shipment_track?.[0];
    if (!s?.current_status) throw new ShippingError('tracking', 'Tracking status is not available yet.', { retryable: true });
    return { awb: String(awb), srStatus: String(s.current_status), courierName: String(s.courier_name || ''),
      estimatedDelivery: t.etd || s.etd || s.edd || null, eventAt: trackingTime(t, s) };
  }
  return { getToken, checkServiceability, shipmentPayload, createShipment, findOrder, getOrder, assignAWB, generatePickup, generateDocument, getTracking };
}
module.exports = { ...createShiprocketClient(), createShiprocketClient, mapShiprocketStatus };
