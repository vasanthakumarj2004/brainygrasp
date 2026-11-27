# Razorpay payment setup and verification

The application now saves a `Payment Pending` shop order before opening Razorpay. Product IDs and quantities are resolved against the database. Client prices, totals and payment-status claims are ignored. The existing `BRAINY10`, `BRAINY15` and `FLAT50` promotions are validated on the server; confirm these are your intended business offers before launch.

The browser callback, authenticated status endpoint and signed webhook converge on the same database-locked confirmation. Only a captured payment with the matching order ID, amount and INR currency can confirm a new order. The payment update, commission and purchased-cart adjustments share a transaction. Duplicate requests do not repeat those effects. An authorized payment remains pending; this integration expects Razorpay automatic capture and does not issue manual capture requests.

## Deployment configuration

Late captures on cancelled orders are saved in `orders.payment_review` and
acknowledged after the database commit. These orders stay cancelled; they do not
clear carts, earn commissions, or create shipments. Repeated notifications reuse
the same payment record. Customers see a support/refund-review message.

In Admin > Orders > Payment review / refunds, inspect the payment reference and
amount. Verify its current state and any existing refund in the Razorpay dashboard
before issuing a refund there. Save the refund reference and outcome in the order's
admin note, retaining its cancelled status. This application does not issue refunds
or automatically mark these manual reviews resolved; the record remains for audit.

An independent payment worker checks up to five due pending/cancelled orders every
15 seconds. Each claim schedules the next attempt 15 minutes later, including after
failures/restarts. It only uses the currently configured Razorpay key; orders under
older keys require separate review. It can recover gateway IDs by receipt, but never
creates a new gateway order or cancels a basket. It runs even with Shiprocket disabled.
Deploy backend/frontend together and restart to apply the additive payment-review
and reconciliation-deadline columns before the worker starts.

1. Deploy backend and frontend together. Old cached checkout scripts use the obsolete request contract; refresh/invalidate their cache on deployment.
2. Set `RAZORPAY_KEY_ID` and `RAZORPAY_KEY_SECRET` as a matching **test** pair in the hosting environment. Never put the secret in browser JavaScript, HTML, screenshots, or Git.
3. Generate a separate random webhook secret of at least 32 characters. Set it as `RAZORPAY_WEBHOOK_SECRET` on the host and enter the identical value in Razorpay's webhook configuration.
4. Configure a public HTTPS webhook at `https://YOUR-BACKEND/api/webhooks/razorpay`. Subscribe to `payment.captured` and `order.paid`. `payment.failed` can also be subscribed; it is acknowledged without cancelling an order that might later succeed. Raw request bytes are verified with HMAC-SHA256 before parsing.
5. Enable automatic capture in the Razorpay Dashboard. Do not fulfil an order based only on an `authorized` payment or a Checkout success callback.
6. Set production `ALLOWED_ORIGINS` to the exact HTTPS frontend origins. Check `frontend/js/config.js` points at the intended HTTPS backend. Production startup requires an origin allowlist; live-key startup also requires the webhook secret.
7. Back up the database and start the backend. `paymentSchema.js` adds payment columns and unique indexes; migration errors stop startup. Database permissions must allow `ALTER TABLE` and `CREATE INDEX`.

The migration does not mark legacy `Paid` orders as verified. Payment ID uniqueness applies to the new bound flow so existing legacy duplicates do not break deployment. Investigate historical suspicious payments separately. The ordinary `/api/orders` route now accepts COD only and recalculates its prices too. Product IDs must exist in the database; each quantity must be an integer from 1 to 100, with at most 100 distinct products and a total no greater than INR 500,000.

## Checks before live keys

Run `npm test` from `backend` (`npm.cmd test` in Windows PowerShell if script execution is disabled). Tests use fake gateway responses and an in-memory transactional database adapter, plus real local HTTP requests and simulated browser events. They do **not** certify a real PostgreSQL migration, browser/Razorpay UI compatibility, hosted TLS/CORS, merchant activation, or actual payment settlement.

On a staging deployment with a real database and Razorpay test keys:

- Complete a test payment: one shop order must become `Paid`, with one payment ID, matching paise amount/currency and `payment_verified_at` set.
- Close/reload checkout around payment completion. The webhook or **Resume / Check Existing Payment** action must recover the same order.
- Interrupt the create-order or verify response and retry. The same checkout request and gateway order must be reused. Remote creation timeouts are reconciled using the unique receipt before another gateway order is created.
- Deliver the same webhook twice and in a different order from the callback. Confirm there is only one commission and one confirmation-triggered shipment attempt.
- Test a failed payment, dismissed checkout, authorized-but-uncaptured payment, invalid signature, forged total, another customer's order ID and an unavailable gateway. None may falsely confirm an order.
- Confirm that an unpaid online order cannot be promoted or pushed to Shiprocket from the admin panel, and that pending orders are excluded from revenue.
- Check webhook delivery responses in Razorpay. Network/database failures return an error so delivery can be retried. Monitor pending payments and reconcile unresolved cases before asking a customer to pay again.

After those checks and merchant activation, configure the matching live key pair and the live-mode webhook. Resolve test-mode pending checkouts before switching; saved orders deliberately refuse a different key configuration. Do not interchange test/live keys or regenerate keys while unresolved payments still depend on the old configuration. Validate a small real payment and settlement after the controlled switch.

## Recovery and operational limits

Checkout saves a customer-specific pending attempt in browser storage before sending its request. Retries reuse that attempt and its saved basket/address; changing address or promo is disabled while resuming it. The payment status endpoint is `GET /api/payment/orders/:shopOrderId` and requires that customer's JWT. Browser storage is not an authority for payment status.

Confirmation inserts a durable `shipping_jobs` record in the same database transaction as payment confirmation. The shipping worker processes eligible jobs when Shiprocket is enabled. Orders created with shipping disabled remain held for review. Refunds and disputes are separate operational workflows, not automatically processed here. Old key configurations and exceptional captured payments on manually changed orders require support review.

`backend/.env` must remain untracked in every repository containing it. This workspace also has a nested Git repository inside `backend`; check both the project and backend indexes. The nested repository's removal is staged while preserving the local file. Commit that removal in that repository to persist it. Ignore rules cover `.env` and `.env.*`, except the placeholder-only `.env.example`. Removal does not erase previous commits or shared copies. Rotate any previously exposed credentials in the owning services; removing files from history and changing provider credentials were not performed by this code change. Set live secrets only in your hosting environment.

For Docker Compose, explicitly select the environment file: `docker compose --env-file backend/.env -f docker-compose.prod.yml config --quiet` from the project directory validates interpolation without printing secrets. The production compose file forwards all three Razorpay variables. Do not run `config` without `--quiet` in shared logs: expanded configuration contains credentials.

Use `payment-readiness.sql` against the intended database for a read-only schema and pending-order inventory before switching keys. Local results do not certify the production database. See `PAYMENTS_LIVE_READINESS.md` for the latest local verification and the remaining deployment steps.

References: [Standard integration](https://razorpay.com/docs/payments/payment-gateway/web-integration/standard/integration-steps/), [best practices](https://razorpay.com/docs/payments/payment-gateway/web-integration/standard/best-practices/), [webhook validation](https://razorpay.com/docs/webhooks/validate-test/), [order receipt lookup](https://razorpay.com/docs/api/orders/fetch-all/).
