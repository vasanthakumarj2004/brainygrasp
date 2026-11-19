# Razorpay live-key setup for AWS

This runbook covers switching BrainyGrasp from Razorpay test mode to live mode
on the AWS EC2/Docker Compose deployment. It does not contain or require sharing
any key values. Do not paste credentials into chat, Git, screenshots, issue
trackers, or build logs.

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
3. In the live account's API-key settings, generate a live key pair. Copy the
   Key ID and Key Secret directly into a secure password manager or secret
   store. The secret may only be shown when generated; do not put it in browser
   code.
4. Confirm automatic capture is enabled. This integration confirms an order
   only after Razorpay reports a captured payment; it does not capture an
   authorized payment itself.

Keep the test and live pairs separate. A test key ID must never be paired with a
live secret, or vice versa.

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

Set the live key pair and webhook secret together:

```dotenv
RAZORPAY_KEY_ID=rzp_live_REPLACE_WITH_LIVE_KEY_ID
RAZORPAY_KEY_SECRET=REPLACE_WITH_MATCHING_LIVE_KEY_SECRET
RAZORPAY_WEBHOOK_SECRET=REPLACE_WITH_THE_RANDOM_WEBHOOK_SECRET
```

Use the existing Compose deployment command from the project directory,
substituting the actual environment-file path used on EC2:

```sh
docker compose --env-file backend/.env -f docker-compose.prod.yml config --quiet
docker compose --env-file backend/.env -f docker-compose.prod.yml up -d --build
```

`config --quiet` validates Compose interpolation without printing expanded
credentials. Do not run Compose configuration without `--quiet` in shared logs.
The backend must be restarted or redeployed after changing secrets; a running
process does not automatically reload them.

If the AWS deployment uses ECS/Fargate instead, put the values in Secrets
Manager or Parameter Store, map them to the three environment-variable names in
the task definition's `secrets` section, grant the task execution role access
to those specific secret ARNs (and the KMS key if applicable), then deploy a
new task revision. Do not put secret values directly in a checked-in task
definition.

## 4. Configure the Razorpay webhook

In the Razorpay Dashboard's **Live Mode**, create or update the webhook:

- URL: `https://brainygrasp.com/api/webhooks/razorpay`
- Secret: the exact `RAZORPAY_WEBHOOK_SECRET` value configured on AWS
- Events: `payment.captured` and `order.paid`

The endpoint must be publicly reachable over HTTPS. The AWS proxy/load balancer
must forward this exact path to the backend, preserve the request body and
`X-Razorpay-Signature` header, and must not cache the route or put an
interactive browser challenge in front of it. The application verifies the
signature against the unmodified request body.

After saving, confirm the Dashboard shows the webhook under **Live Mode**; a
test-mode webhook does not configure live payments.

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

If `SHIPROCKET_ENABLED=true`, online checkout also requires a live key and valid
Shiprocket production configuration and parcel profiles. If shipping is
disabled, successful payment does not automatically book a shipment; the order
is held for review.

## 7. Troubleshooting and rollback cautions

- **Online payments are not configured**: verify that the backend received a
  valid key ID and non-empty matching secret; do not print the secret to debug.
- **Live payments require a strong webhook secret**: set a separate
  `RAZORPAY_WEBHOOK_SECRET` of at least 32 characters and configure the same
  value in the live webhook settings.
- **Webhook signature errors**: compare the backend and Dashboard webhook
  secrets securely; verify the proxy preserves the request body and signature
  header. Never disable signature verification as a workaround.
- **This order uses a previous payment configuration**: do not retry it with a
  different key. Reconcile its status with Razorpay before taking further
  action.
- If live checkout must be paused, stop accepting new online checkouts using
  the deployment's approved operational procedure. Reconcile any already
  created orders before changing key modes again. A key rollback does not
  change the key ID saved on existing orders.

## Related project guidance

- [PAYMENTS_SETUP.md](./PAYMENTS_SETUP.md) — payment flow and test-mode checks
- [PAYMENTS_LIVE_READINESS.md](./PAYMENTS_LIVE_READINESS.md) — repository
  readiness findings; local checks do not certify AWS
- [EC2_DEPLOYMENT.md](../EC2_DEPLOYMENT.md) — EC2, Compose, proxy and restart
  procedures
- [Razorpay Standard Checkout integration](https://razorpay.com/docs/payments/payment-gateway/web-integration/standard/integration-steps/)
- [Razorpay webhook setup](https://razorpay.com/docs/webhooks/setup-edit-payments)
- [Razorpay webhook signature validation](https://razorpay.com/docs/webhooks/validate-test/)
