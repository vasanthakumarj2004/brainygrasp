# Razorpay live readiness — 18 November 2026

Status: local preparation completed. The owner confirmed AWS and brainygrasp.com;
live activation is blocked on the AWS resource details, deployment and access.
No live key was installed and no payment was initiated.

## Confirmed domain and prepared routing

The storefront, admin and affiliate production API base now follows the current
page origin (for example, `https://brainygrasp.com` or its `www` hostname).
The application serves frontend pages and API routes on the same port. Local
split-port development and explicit API overrides remain available. See
`../EC2_DEPLOYMENT.md` for packaging, startup and proxy instructions.
The production environment templates specify:

```dotenv
FRONTEND_URL=https://brainygrasp.com
ALLOWED_ORIGINS=https://brainygrasp.com,https://www.brainygrasp.com
```

The prepared design serves the frontend and backend on one public domain:

| Public route | Required destination |
| --- | --- |
| https://brainygrasp.com/ | Frontend |
| https://brainygrasp.com/admin/ | Admin frontend |
| https://brainygrasp.com/affiliate/ | Affiliate frontend |
| https://brainygrasp.com/api/* | Backend, preserving the entire /api/... path |
| https://brainygrasp.com/api/webhooks/razorpay | Backend POST webhook, preserving the original body and X-Razorpay-Signature |
| https://brainygrasp.com/api/health | Backend health endpoint |

The edge proxy must forward API requests rather than fall back to an HTML page,
must not cache payment routes, and must not place browser login or challenge pages
in front of the webhook. The application's webhook signature verification remains
required. Terminate HTTPS with a valid certificate for the actual public hostname.
If using an AWS Application Load Balancer, configure its HTTPS listener and path
routing rules; the specific AWS service has not yet been confirmed.

Read-only domain checks on 18 November 2026: the HTTPS root returned 200, but
`/api/health` returned 404. DNS returned two apex A records and a www CNAME to the
apex. A separate HTTPS request for www failed resolution, so www reachability and
TLS still require verification. No DNS, certificate, AWS or Razorpay settings
were changed. The webhook URL above is prepared, not verified operational.

## Changes completed

- Removed `.env` from the nested backend repository's index using `git rm --cached`.
  The local file remains intact. Removal is staged, not committed; old commits
  still contain credentials. The project repository already excluded this file.
- Broadened the backend ignore rules to exclude all `.env.*` files except
  `.env.example`. Checked that `.env.production` and `.env.live` are ignored.
- Generated a random 256-bit webhook secret in the ignored local `backend/.env`.
  Its value was not printed. This has NOT been configured on a host or Razorpay,
  and an already-running process will not load it until restarted.
- Added the three Razorpay variables to `docker-compose.prod.yml`; production
  Compose now requires explicit credentials and a frontend URL instead of
  falling back to built-in passwords or localhost.
- Corrected the AWS environment template to use `ALLOWED_ORIGINS` and added the
  missing webhook secret and admin configuration placeholders.
- Added `payment-readiness.sql` for read-only inspection of the intended database.
- Corrected the setup document's outdated description of the shipping job queue.

## Verification results

| Check | Result | Scope |
| --- | --- | --- |
| Payment, checkout, HTTP route and shipping tests | 48 passed, 0 failed | Simulated gateway and transactional fixtures |
| Payment schema columns | Present | Local PostgreSQL configured by backend/.env |
| Payment uniqueness indexes | All three present, unique and valid | Local PostgreSQL |
| Shipping job table | Present | Local PostgreSQL |
| Payment and shipping migration repeatability | Each ran twice successfully inside a rolled-back transaction | Local PostgreSQL only |
| Pending online orders | 0 | Local PostgreSQL |
| Legacy online orders marked Paid without payment_verified_at | 2, key mode unknown; unchanged | Local PostgreSQL; reconcile separately |
| Incomplete verified online orders | 0 | Local PostgreSQL |
| Local API health | HTTP 200 | localhost:3000 |
| Render candidate health | HTTP 200 | https://braingrasp-devin-1.onrender.com/health |
| Render payment status endpoint | HTTP 404 | GET /api/payment/orders/1; current local implementation should return 401 without a token |
| Render webhook endpoint | HTTP 404 | POST /api/webhooks/razorpay with unsigned empty JSON; no payment event sent |
| Render root frontend metadata | http://localhost:5500 | Missing/stale deployment configuration |
| AWS candidate API | Connection refused | http://16.178.149.138:3000/health; does not assess another port or an HTTPS proxy |

The earlier candidate addresses came from repository configuration. The owner
subsequently confirmed the intended deployment is AWS at brainygrasp.com. Render
is not the target, and its health response does not certify the AWS deployment.

## Credential remediation

The nested backend HEAD includes EMAIL_PASS, RESEND_API_KEY, JWT_SECRET,
DB_PASSWORD, REDIS_PASSWORD, RAZORPAY_KEY_SECRET and ADMIN_PASSWORD. The current
JWT, database, Redis, Razorpay and admin values still match that committed copy.
The email and Resend values differ or are absent now; revocation of their old
values is unverified. No credentials were rotated at their providers.

Reconcile unresolved payments on the actual production database before replacing
Razorpay keys. Rotate exposed credentials with coordinated provider/runtime
updates. JWT rotation invalidates existing sessions. Database and Redis password
changes must update the service itself as well as application configuration;
changing a Compose variable does not reset an existing PostgreSQL volume's user
password. Do not remove persistent volumes to accomplish rotation.

## Remaining live setup

1. Identify the AWS service/instance and region for brainygrasp.com and establish
   deployment access. Apply the routing above and deploy the current backend and
   frontend together. Set NODE_ENV=production,
   FRONTEND_URL and exact HTTPS ALLOWED_ORIGINS; verify the frontend API base.
2. Back up the intended database. Run the normal startup migrations, then execute
   `payment-readiness.sql` on that database. Reconcile pending payments and legacy
   unverified paid orders against Razorpay records; do not mark them paid by guess.
3. Verify merchant activation in the Razorpay dashboard. In Live mode, under
   Accounts & Settings > Webhooks, configure
   `https://brainygrasp.com/api/webhooks/razorpay` for `payment.captured` and `order.paid`.
   Set the same independent webhook secret in the host and dashboard. Enable
   automatic capture. These dashboard settings remain unverified and unchanged.
4. Before enabling live checkout, confirm hosted authentication, CORS and signature
   rejection, and complete test-mode checkout/reload/duplicate-webhook recovery.
   Keep live shipping disabled during test-mode checkout.
5. Install a matching, unexposed live key pair in the host's secret environment,
   restart the backend, and perform a controlled small payment with the owner.
   Check one Paid order, payment ID, exact amount/currency, verification timestamp,
   successful webhook delivery and eventual settlement. Test refund/dispute
   handling separately; they are not automatically reconciled by this code.

Dashboard access was unavailable: the computer/browser access host could not be
reached. No Razorpay connector was found. Render integration was offered but was
not connected during this work. Production secrets and database access were not
available through a confirmed deployment session.

Sources: [Razorpay integration](https://razorpay.com/docs/payments/payment-gateway/web-integration/standard/integration-steps),
[webhook setup](https://razorpay.com/docs/webhooks/setup-edit-payments),
[AWS load balancer listeners](https://docs.aws.amazon.com/elasticloadbalancing/latest/application/load-balancer-listeners.html).
