'use strict';

const { env } = require('./paymentFixture');
const boxes = [{ code: 'SMALL', length: 22, breadth: 18, height: 12, inner_length: 20, inner_breadth: 16, inner_height: 10,
  tare_weight_g: 100, max_weight_kg: 5 }];
const environment = { ...env, NODE_ENV: 'production', RAZORPAY_KEY_ID: 'rzp_live_fixture', SHIPROCKET_ENABLED: 'true',
  SHIPROCKET_EMAIL: 'api@example.invalid', SHIPROCKET_PASSWORD: 'fixture-api-password', SHIPROCKET_CHANNEL_ID: '123',
  SHIPROCKET_PICKUP_LOCATION: 'Fixture Warehouse', SHIPROCKET_PICKUP_POSTCODE: '600002', SHIPROCKET_ORDER_PREFIX: '91',
  SHIPROCKET_WEBHOOK_SECRET: 'fixture-shipping-secret-with-at-least-32-characters', SHIPROCKET_PACKAGES: JSON.stringify(boxes) };
const item = { id: 1, name: 'Toy', price: 500, quantity: 2, shipping_weight_g: 300,
  shipping_length_cm: 10, shipping_breadth_cm: 8, shipping_height_cm: 4 };
const shippingClient = { async checkServiceability() { return { id: 12, name: 'Fixture Courier', rate: 72 }; } };
module.exports = { boxes, environment, item, shippingClient };
