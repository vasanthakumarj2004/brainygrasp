# Razorpay live payments and real-time confirmation setup

This guide covers switching BrainyGrasp from Razorpay test mode to real payments,
configuring payment confirmation and recovery, and handing verified orders to
Shiprocket. It is matched to the current AWS EC2/Docker Compose configuration and
application code, reviewed on **19 November 2026**.

Updating this document does not install credentials, change the Razorpay dashboard,
deploy the application or make a payment. Keep actual secrets out of this file,
frontend code, Git, screenshots and shared logs.

## Current project state

| Item | What was checked | What remains to do |
| --- | --- | --- |
| Local backend environment | `NODE_ENV=development`; Razorpay key is in test mode | Configure the actual production runtime for live operation |
| Local payment secrets | API secret is present; webhook secret meets the 32-character length requirement | Verify the matching live key pair and dashboard webhook; presence/length does not authenticate either |
| Backend payment code | Creates orders, verifies signatures and captured payments, handles webhooks and resume/status checks | Verify the deployed version and a controlled live payment |
| `docker-compose.prod.yml` | Already maps all three Razorpay variables into the backend | Supply real values in the production environment file and recreate the backend |
| Public domain | Repository deployment target is `https://brainygrasp.com` | Verify current HTTPS/API routing; this guide has not checked the running site |
| Shiprocket | Locally disabled/unconfigured; Compose lacks its variable mappings | Follow [Shiprocket setup](../shiprocket.md) before enabling automatic shipping |

The [18 November readiness report](PAYMENTS_LIVE_READINESS.md) records earlier
routing failures and credentials found in repository history. Treat those as
items to recheck, not as a current live-service certification. Use new, unexposed
production credentials and complete the recorded credential remediation before
launch; excluding `.env` from new commits does not remove old exposure.

## How real-time payment confirmation works here

```text
Checkout -> backend saves Payment Pending order -> Razorpay Checkout
         -> backend verifies captured payment -> Paid order + shipping job
         -> Shiprocket worker books only if live shipping was prepared/enabled
```

The backend can confirm the same payment through three entry points:

| Entry point | Purpose |
| --- | --- |
| `POST /api/payment/verify` | Verify the browser success callback signature, then fetch payment details from Razorpay |
| `POST /api/webhooks/razorpay` | Verify a server-to-server webhook signature, then fetch and confirm the payment even if the browser closes |
| `GET /api/payment/orders/:id` | Let the signed-in owner resume/check a saved checkout and recover a captured payment |

For a new confirmation, the payment must belong to the saved order, match its
amount/currency and be fully captured without a refunded amount. `authorized`
and `created` payments remain pending. Confirmation records the payment ID and
verification timestamp, updates cart/eligible affiliate effects, and creates one
shipping job in the same database transaction. Duplicate confirmations reuse
the saved result.

There is **no scheduled Razorpay reconciliation worker** in this code. Recovery
depends on webhooks or payment-status requests. The customer's orders dashboard
refreshes stored orders every 30 seconds while visible, but that refresh does not
itself query Razorpay for pending payments. “Real-time” here means event-driven
confirmation subject to gateway/network delay, not guaranteed instant settlement.

See [currentworkflow.md](../currentworkflow.md) for the complete COD/prepaid flow.

## What live mode requires

Configure these three values in the backend's production environment:

| Variable | Value |
| --- | --- |
| `RAZORPAY_KEY_ID` | Key ID generated in Razorpay **Live Mode**; it starts with `rzp_live_`. |
| `RAZORPAY_KEY_SECRET` | The matching secret generated with that live key ID. Keep it server-side. |
| `RAZORPAY_WEBHOOK_SECRET` | A separate random secret, at least 32 characters, shared by the backend and the Razorpay webhook configuration. It is not the API key secret. |

The application returns the key ID to Razorpay Checkout but keeps the key secret
and webhook secret on the backend. The backend rejects a live-key configuration
without a sufficiently long webhook secret.

## 1. Prepare the Razorpay account

1. Sign in to the Razorpay Dashboard and confirm the merchant account is
   activated for live payments, including any required business verification
   and payment-method approvals.
2. Switch the Dashboard from **Test Mode** to **Live Mode**.
3. Go to **Account & Settings > Website and app settings > API Keys**, then
   generate a live key pair. If live key generation is unavailable, complete
   the account/website verification requested in your dashboard. Copy the
   Key ID and Key Secret directly into a secure password manager or secret
   store. The secret may only be shown when generated; do not put it in browser
   code.
4. In **Account & Settings > Payments Capture**, configure **Automatic Capture**
   for the account. The account owner controls this setting; follow the current
   dashboard prompts for its capture window and save the change. This integration
   creates Orders API orders without a per-order capture override, and it does
   not call the payment-capture API itself. If you choose manual capture, someone
   must capture eligible payments separately before this app can confirm them.

Keep the test and live pairs separate. A test key ID must never be paired with a
live secret, or vice versa.

Reference: [Razorpay API keys](https://razorpay.com/docs/payments/dashboard/account-settings/api-keys/)
and [capture settings](https://razorpay.com/docs/payments/payments/capture-settings/).
The server supplies the key ID to Checkout dynamically; you do not need to paste
a live key into the frontend HTML or JavaScript.

## 2. Create the webhook secret

Generate a new random value of at least 32 characters. For example, on a
trusted machine with Node.js:

```sh
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Treat the output as a secret. Store the exact same value in the backend's
`RAZORPAY_WEBHOOK_SECRET` setting and in the Razorpay webhook configuration.
Do not reuse the API key secret or the Shiprocket webhook token.

## 3. Configure the AWS backend

### EC2 with Docker Compose

Prefer AWS Secrets Manager or Systems Manager Parameter Store (SecureString)
for the production values. If the current EC2 deployment reads an environment
file, update the ignored production environment file on the EC2 host—not a
tracked example file or a developer's local copy. Restrict its permissions
(for example, `chmod 600` on Linux) and ensure it is not served by the web
server or included in an image.

Set the live key pair and webhook secret together. Replace every placeholder;
preserve the existing database, Redis, admin, JWT and email configuration:

```dotenv
NODE_ENV=production
FRONTEND_URL=https://brainygrasp.com
ALLOWED_ORIGINS=https://brainygrasp.com,https://www.brainygrasp.com
RAZORPAY_KEY_ID=rzp_live_REPLACE_WITH_LIVE_KEY_ID
RAZORPAY_KEY_SECRET=REPLACE_WITH_MATCHING_LIVE_KEY_SECRET
RAZORPAY_WEBHOOK_SECRET=REPLACE_WITH_THE_RANDOM_WEBHOOK_SECRET
```

Use only the HTTPS origins you actually serve. The current frontend defaults to
calling its own page origin, so the public `/api/*` routes must reach this backend.
If you intentionally host the API separately, configure the existing frontend API
override and backend allowed origins consistently; never put secrets in that override.

Use the existing Compose deployment command from the project directory,
substituting the actual environment-file path used on EC2:

```sh
docker compose --env-file backend/.env -f docker-compose.prod.yml config --quiet
docker compose --env-file backend/.env -f docker-compose.prod.yml up -d --build backend
docker compose --env-file backend/.env -f docker-compose.prod.yml ps
```

`config --quiet` validates Compose interpolation without printing expanded
credentials. Do not run Compose configuration without `--quiet` in shared logs.
The backend must be restarted or redeployed after changing secrets; a running
process does not automatically reload them. For Compose, use `up` to recreate the
container with changed environment values: `docker compose restart` alone does
not inject a changed key pair. These commands deploy the service and are intended
for the production change window, after the checks below are prepared.

If the AWS deployment uses ECS/Fargate instead, put the values in Secrets
Manager or Parameter Store, map them to the three environment-variable names in
the task definition's `secrets` section, grant the task execution role access
to those specific secret ARNs (and the KMS key if applicable), then deploy a
new task revision. Do not put secret values directly in a checked-in task
definition.

### Direct Node or another managed host

For direct Node deployment, update the ignored `backend/.env` used on that server
or its service-manager environment, then restart the Node service. For managed
hosting, set the three variables in the backend service's runtime settings and
redeploy. Existing process environment values take precedence over `.env` with
the current dotenv configuration. Editing your laptop's `.env` does not update AWS.

Use a continuously available backend and persistent PostgreSQL. An accessible
frontend alone does not provide payment verification or webhook processing.

## 4. Configure the Razorpay webhook

In the Razorpay Dashboard's **Live Mode**, open **Accounts & Settings > Website
and app settings > Webhooks > Add New Webhook**, then configure:

- URL: `https://brainygrasp.com/api/webhooks/razorpay`
- Secret: the exact `RAZORPAY_WEBHOOK_SECRET` value configured on AWS
- Events: `payment.captured` and `order.paid`
- Alert email: an actively monitored operations address
- Status: enabled

If your API uses another public hostname, substitute it while preserving
`/api/webhooks/razorpay`. This URL is a backend POST endpoint, not the frontend
checkout page or the Shiprocket tracking endpoint. See the
[official webhook setup steps](https://razorpay.com/docs/webhooks/setup-edit-payments/).

The endpoint must be publicly reachable over HTTPS. The AWS proxy/load balancer
must forward this exact path to the backend, preserve the request body and
`X-Razorpay-Signature` header, and must not cache the route or put an
interactive browser challenge in front of it. The application verifies the
signature against the unmodified request body.

After saving, confirm the Dashboard shows the webhook under **Live Mode**; a
test-mode webhook does not configure live payments.

The app requires a webhook secret even if the dashboard describes it as optional.
Its route is mounted with a raw body parser before the normal JSON parser; the
original bytes and `X-Razorpay-Signature` must survive the proxy unchanged.
[Razorpay signature guidance](https://razorpay.com/docs/webhooks/validate-test/).

Check actual delivery latency. Razorpay currently requires a 2xx response within
5 seconds, retries failed deliveries, and can disable repeatedly failing webhooks.
This implementation fetches Razorpay payment details and commits the database
transaction before acknowledging; its gateway timeout is 10 seconds, so slow
gateway/database responses can miss the webhook deadline. Verify successful timely
delivery and monitor the alert email; an enabled webhook alone does not prove
recovery works. [Delivery requirements](https://razorpay.com/docs/webhooks/setup-edit-payments/).

This code handles only `payment.captured` and `order.paid` as confirmation events.
It does not automatically reconcile refunds or disputes just because additional
event types are selected in the dashboard. An HTTP 200 for an ignored event or an
unknown order also does not prove that a store order was marked paid.

## 5. Pre-cutover checks

Before switching production keys:

1. Deploy the current backend and frontend together and confirm the public
   frontend calls the intended AWS API.
2. Back up the production database. Run
   [`payment-readiness.sql`](./payment-readiness.sql) against that database and
   investigate pending online orders and any paid orders without verified
   payment details. Do not assume an order is paid based only on its status.
3. Resolve or reconcile pending test-mode checkouts before changing keys. Each
   saved online order is bound to the key ID used to create it; after a key
   switch, resuming an order from the previous mode is deliberately rejected
   for review.
4. Run `npm test` from `backend`. These tests use simulated gateway responses;
   they do not prove that a live payment, AWS secret injection, webhook delivery,
   or settlement works.
5. Confirm the production environment has `NODE_ENV=production` and the
   intended database, frontend origin, and HTTPS routing. Do not enable live
   keys in a developer or test environment by mistake.

### Verify public routing without a payment

From PowerShell, use `curl.exe` (on Linux/macOS use `curl`):

```powershell
curl.exe -i https://brainygrasp.com/api/health
curl.exe -i https://brainygrasp.com/api/payment/orders/1
curl.exe -i -X POST https://brainygrasp.com/api/webhooks/razorpay -H "Content-Type: application/json" --data-binary '{}'
```

| Check | Expected result with this code |
| --- | --- |
| Health | HTTP 200 JSON when the backend/database are healthy |
| Payment status without a login token | HTTP 401 from authentication; this does not read another customer's order |
| Empty unsigned webhook | HTTP 400 for invalid signature when the webhook secret is configured; HTTP 503 if it is missing |

These requests create no payment. A 404, HTML page, browser challenge or redirect
to a login page indicates routing/proxy problems to investigate. A health response
does not authenticate your Razorpay key or prove webhook delivery. Browser GET
navigation to the POST webhook route is not a valid webhook test.

### Verify the live environment without printing secrets

For a direct Node deployment, run this from `backend` after installing production
values. It checks format/mode only and makes no Razorpay request:

```sh
node -e "require('dotenv').config({quiet:true});try{const e=process.env;if(e.NODE_ENV!=='production'||!e.RAZORPAY_KEY_ID?.startsWith('rzp_live_'))throw new Error('Production environment and live key required');require('./paymentService').validateConfig(e);console.log('Live payment configuration format passed; credentials not authenticated.');}catch(e){console.error(e.message);process.exitCode=1;}"
```

For Docker, run the check inside the actual container from the project directory:

```sh
docker compose --env-file backend/.env -f docker-compose.prod.yml exec -T backend node -e "try{const e=process.env;if(e.NODE_ENV!=='production'||!e.RAZORPAY_KEY_ID?.startsWith('rzp_live_'))throw new Error('Production environment and live key required');require('./paymentService').validateConfig(e);console.log('Live payment configuration format passed; credentials not authenticated.');}catch(e){console.error(e.message);process.exitCode=1;}"
```

Neither command prints the keys or webhook secret. The validator checks key format,
non-empty API secret and webhook-secret length; only a real authenticated operation
can establish that the pair is valid. The documented production commands have not
been run against your host while updating this guide.

## 6. Deploy and verify live mode

1. Schedule the change with the person authorized to make a real charge. Update
   the **matching** live key ID and secret, plus the webhook secret, in the AWS
   runtime configuration.
2. Deploy/restart the backend. Verify deployment health and inspect startup
   logs for configuration errors, without printing environment variables.
3. Make one controlled, low-value real payment with the owner's explicit
   approval. Do not use a test card or a test-mode checkout for this step.
4. Verify in the application and Razorpay Dashboard that the payment is
   captured, the order has the matching payment ID, amount and INR currency,
   and the application's payment verification timestamp is set.
5. Confirm Razorpay reports successful delivery of the live webhook. Check that
   retrying or receiving duplicate events does not create duplicate order
   effects. Reconcile the payment with the Razorpay settlement record.
6. Handle any refund separately through the approved Razorpay refund process;
   refunds and disputes are not automatically processed by this application.

For the controlled order, verify the following evidence rather than only a success
popup:

| Location | Evidence |
| --- | --- |
| Razorpay Live dashboard | Correct payment/order IDs, captured status, exact amount and INR currency |
| Application database/order | Matching `payment_id`, `razorpay_order_id`, `amount_paise`, live `razorpay_key_id`, and non-null `payment_verified_at` |
| Store order status | Initially `Paid`; may advance if shipping/tracking is active |
| Webhook delivery record | Relevant live event reaches the intended endpoint successfully and within the delivery deadline |
| Shipping job | One job for the store order; queued for prepared live shipping or held if shipping was disabled |

Use test mode to exercise failed/authorized payments, reload/resume and duplicate
events before the live change. Verify recovery without relying only on the browser
callback. If an authorized payment is awaiting capture, resume/check that same
order; do not create another payment merely because confirmation is delayed.

Captured payment is not bank settlement. Confirm eventual settlement separately in
Razorpay; settlement, refund and dispute reconciliation are operational tasks in
this project.

If `SHIPROCKET_ENABLED=true`, online checkout also requires a live key and valid
Shiprocket production configuration and parcel profiles. If shipping is
disabled, successful payment does not automatically book a shipment; the order
is held for review.

### Shiprocket handoff

With shipping enabled, the backend checks parcel measurements and courier
serviceability before creating a new Razorpay payment order. Missing shipping
configuration or an unsupported parcel/PIN can therefore block payment checkout.
After verified payment, the saved shipping job is processed by the shipping worker.

Complete [Shiprocket setup](../shiprocket.md), including the missing Compose
environment mappings, before enabling it. Live Razorpay alone does not enable
shipping. Orders paid while shipping was disabled remain held and need review;
enabling shipping later does not automatically release them. A shipping error after
payment confirmation does not automatically refund the payment. COD uses its own
order route and does not pass through Razorpay.

## 7. Troubleshooting and rollback cautions

- **Online payments are not configured**: verify that the backend received a
  valid key ID and non-empty matching secret; do not print the secret to debug.
- **Live payments require a strong webhook secret**: set a separate
  `RAZORPAY_WEBHOOK_SECRET` of at least 32 characters and configure the same
  value in the live webhook settings.
- **Webhook signature errors**: compare the backend and Dashboard webhook
  secrets securely; verify the proxy preserves the request body and signature
  header. Never disable signature verification as a workaround.
- **Payment remains pending**: check whether Razorpay reports `authorized`,
  `captured`, failed or refunded; confirm capture settings, resume the saved
  checkout and inspect webhook delivery. A customer dashboard refresh alone
  does not invoke payment reconciliation.
- **Payment window cannot load**: confirm the page can load
  `https://checkout.razorpay.com/v1/checkout.js` and that its API requests reach
  the current backend rather than an old host or HTML fallback.
- **Webhook delivery times out or becomes disabled**: investigate gateway/database
  latency and host availability, fix the cause, then re-enable it in Razorpay.
- **Online checkout is not ready for live shipping**: Shiprocket is enabled but
  the runtime still has a test Razorpay key. Correct the mode/configuration;
  do not change order status to bypass verification.
- **This order uses a previous payment configuration**: do not retry it with a
  different key. Reconcile its status with Razorpay before taking further
  action.
- If live checkout must be paused, stop accepting new online checkouts using
  the deployment's approved operational procedure. Reconcile any already
  created orders before changing key modes again. A key rollback does not
  change the key ID saved on existing orders.

There is no `RAZORPAY_ENABLED` toggle implemented here. Do not invent one in `.env`
and assume it pauses checkout. Use your deployment/storefront controls while
preserving webhook and recovery access for outstanding payments.

Coordinate key and webhook-secret rotation with pending orders. This implementation
uses one current API key pair and one webhook secret; it has no built-in overlap
for old/new configurations. Razorpay retries of older webhook requests can require
the previous secret, which the current single-secret validator cannot accept after
replacement. Reconcile affected payments during rotation and keep secrets in secure
storage, not in this document. See [webhook rotation guidance](https://razorpay.com/docs/webhooks/validate-test/).

## Launch completion checklist

- [ ] Live merchant account and website approval verified; new matching live keys stored securely.
- [ ] Automatic capture configured and observed on a controlled payment.
- [ ] Production backend receives all three payment variables and correct origins.
- [ ] HTTPS health, authenticated payment routes and unsigned-webhook rejection verified.
- [ ] Database backed up/migrated; readiness queries and old pending orders reviewed.
- [ ] Live webhook enabled for both confirmation events with matching secret and monitored alerts.
- [ ] Controlled payment confirmed once in Razorpay and the store; recovery verified.
- [ ] Webhook response time and backend availability verified.
- [ ] Shipping either deliberately held for review or separately configured and verified live.
- [ ] Refund, settlement, key rotation and support procedures understood before public launch.

## Related project guidance

- [PAYMENTS_SETUP.md](./PAYMENTS_SETUP.md) — payment flow and test-mode checks
- [PAYMENTS_LIVE_READINESS.md](./PAYMENTS_LIVE_READINESS.md) — repository
  readiness findings; local checks do not certify AWS
- [EC2_DEPLOYMENT.md](../EC2_DEPLOYMENT.md) — EC2, Compose, proxy and restart
  procedures
- [currentworkflow.md](../currentworkflow.md) — implemented prepaid, COD and tracking flow
- [shiprocket.md](../shiprocket.md) — live shipping activation and verification
- [paymentService.js](./paymentService.js) — configuration, payment confirmation and recovery
- [Razorpay Standard Checkout integration](https://razorpay.com/docs/payments/payment-gateway/web-integration/standard/integration-steps/)
- [Razorpay webhook setup](https://razorpay.com/docs/webhooks/setup-edit-payments)
- [Razorpay webhook signature validation](https://razorpay.com/docs/webhooks/validate-test/)
