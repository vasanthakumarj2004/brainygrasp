'use strict';

const express = require('express');
const pool = require('../db');
const { createDeliveryTracking, validWebhookKey } = require('../deliveryTracking');
const { ShippingError } = require('../shippingPolicy');
const router = express.Router();
const tracking = createDeliveryTracking({ pool });

router.post('/api/delivery-events', async (req, res) => {
  if (!validWebhookKey(req.get('x-api-key'), process.env.SHIPROCKET_WEBHOOK_SECRET)) {
    return res.status(401).json({ error: 'Invalid webhook security token' });
  }
  try {
    await tracking.receive(req.body);
    res.status(200).json({ received: true });
  } catch (err) {
    // Never acknowledge an event that has not been durably stored.
    res.status(err instanceof ShippingError ? err.status : 503).json({ error: err instanceof ShippingError ? err.message : 'Tracking event could not be saved. Retry delivery.' });
  }
});
router.get('/api/delivery-events', (req,res) => res.json({ status: 'Delivery webhook endpoint is active' }));
module.exports = router;
