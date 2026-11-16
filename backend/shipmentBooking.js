'use strict';

const { ShippingError, eligibleBooking, parcelDetails, orderAmounts } = require('./shippingPolicy');

// Each save commits BEFORE the next external effect. Unknown outcomes are
// reconciled with reads; they are never retried as fresh mutation requests.
async function advanceBooking({ job, order, address, user, config, client, save }) {
  eligibleBooking(order, job.details);
  orderAmounts(order);
  const d = job.details;
  parcelDetails(d.parcel);
  if (JSON.stringify(d.config) !== JSON.stringify(config)) throw new ShippingError('configuration_changed', 'Shipping configuration changed since approval. Review this shipment.');
  if (!/^\d{6}$/.test(address.pincode) || !/^\d{10}$/.test(address.phone)) throw new ShippingError('address', 'Delivery phone number or PIN code is invalid.');
  const persist = async (phase, patch = {}) => {
    Object.assign(d, patch); job.phase = phase; await save(job);
  };
  if (job.phase === 'complete') return;
  if (!d.courierId) {
    const courier = await client.checkServiceability({ pickupPostcode: config.postcode, deliveryPostcode: address.pincode, parcel: d.parcel, cod: order.payment_method === 'cod', orderValue: order.total });
    await persist(job.phase, { courierId: courier.id, courierName: courier.name });
  }
  if (!d.remoteOrderId) {
    const existing = await client.findOrder(d.reference, config);
    if (existing) {
      const remote = await client.getOrder(existing, order, config, d.reference);
      await persist('created', remote);
    } else if (job.phase === 'create_pending') {
      throw new ShippingError('create_uncertain', 'Creation outcome is unknown. Reconciliation will check again without creating another order.', { retryable: true });
    } else {
      await persist('create_pending');
      try { await persist('created', await client.createShipment(order, address, user, d.parcel, config, d.reference)); }
      catch (err) {
        if (err instanceof ShippingError && !err.ambiguous) await persist('new');
        throw err;
      }
    }
  }
  const remote = await client.getOrder(d.remoteOrderId, order, config, d.reference);
  if (d.shipmentId && d.shipmentId !== remote.shipmentId) throw new ShippingError('shipment_mismatch', 'Remote shipment identifier changed.');
  if (d.awb && remote.awb && d.awb !== remote.awb) throw new ShippingError('awb_mismatch', 'Remote AWB changed. Review the shipment.');
  await persist(job.phase, { shipmentId: remote.shipmentId,
    ...(remote.awb ? { awb: remote.awb, courierName: remote.courierName || d.courierName } : {}),
    ...(remote.pickupConfirmed ? { pickupConfirmed: true } : {}) });
  if (!d.awb) {
    if (job.phase === 'awb_pending') throw new ShippingError('awb_uncertain', 'AWB assignment outcome is unknown. Check the existing shipment.', { retryable: true });
    await persist('awb_pending');
    try { await persist('awb_assigned', await client.assignAWB(d.shipmentId, d.courierId)); }
    catch (err) { if (err instanceof ShippingError && !err.ambiguous) await persist('created'); throw err; }
  }
  if (!d.pickupConfirmed) {
    if (job.phase === 'pickup_pending') throw new ShippingError('pickup_uncertain', 'Pickup outcome is unknown. Check the existing pickup request.', { retryable: true });
    await persist('pickup_pending');
    try { await persist('pickup_confirmed', await client.generatePickup(d.shipmentId, Boolean(d.pickupRetry))); }
    catch (err) {
      if (err instanceof ShippingError && !err.ambiguous) await persist('awb_assigned', { pickupRetry: true });
      throw err;
    }
  }
  // Recreating a document cannot create another order, AWB or pickup.
  if (!d.labelUrl) await persist('pickup_confirmed', { labelUrl: await client.generateDocument('label', d.shipmentId) });
  if (!d.manifestUrl) await persist('pickup_confirmed', { manifestUrl: await client.generateDocument('manifest', d.shipmentId) });
  await persist('complete');
}
module.exports = { advanceBooking };
