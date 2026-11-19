# Shiprocket live setup for BrainyGrasp

This guide explains how to activate the existing shipping integration and receive live tracking updates. Reviewed against this repository on 19 November 2026. Creating this guide does not enable shipping or change any credentials.

## 1. Understand what you need

This implementation uses a **Shiprocket API-user email and password**, not a permanent API key pasted into the code. The backend calls `POST https://apiv2.shiprocket.in/v1/external/auth/login`, caches the returned bearer token, renews it before its 10-day expiry, and retries authentication once after an HTTP 401. See the [official authentication documentation](https://apidocs.shiprocket.in/).

Keep three things separate:

| Item | Where it belongs | Purpose |
| --- | --- | --- |
| API-user email/password | Backend environment | Authenticate outbound Shiprocket requests |
| Bearer token | Managed automatically in backend memory | Authorize API calls; no token environment variable is required |
| Webhook secret | Backend environment and Shiprocket webhook settings | Authenticate incoming tracking updates |

The earlier local review found development mode, missing Shiprocket settings, no configured boxes, and Razorpay test credentials. These findings describe the local `backend/.env`, not the deployed server. Fourteen mocked shipping tests passed; live account access and deployment remain to be verified.

**Deployment gap:** the current `docker-compose.prod.yml` does not inject Shiprocket settings into the backend container. If you deploy with this file, complete section 5; editing an environment file alone is insufficient.

## 2. Prepare your Shiprocket account

1. Complete the account's business/KYC requirements and ensure shipping is activated.
2. Add funds to the shipping wallet and verify your COD/remittance setup if accepting COD.
3. Register and verify the warehouse/pickup address. Record its exact pickup name and six-digit PIN code.
4. Identify the numeric channel ID for this store. Use the actual channel ID from your account, not a channel name or an invented number. If the dashboard does not expose it, use Shiprocket's documented channel-list API or ask Shiprocket support.
5. Open **Settings > API**, then **Configure / Create an API user** (labels may vary). Use an API email different from your main account email. Save the password created or supplied by that workflow securely. [Official API-user setup](https://support.shiprocket.in/support/solutions/articles/43000604103).
6. If the form offers module permissions, enable the operations this app needs: orders, couriers, shipments, tracking and shipment documents, with buyer details available for order read-back. The newer dashboard workflow may send the API-user password to the registered account email. [Official getting-started guide](https://apidocs-test.shiprocket.in/guides/getting-started/).

Use these API-user credentials in the application, rather than the main dashboard login.

## 3. Enter product and package measurements

In **Admin > Products**, edit every product customers can purchase and save:

| Field | Unit |
| --- | --- |
| Unit weight (`shipping_weight_g`) | Whole grams, including the unit's protective wrapping |
| Unit length (`shipping_length_cm`) | Centimetres, including wrapping |
| Unit width (`shipping_breadth_cm`) | Centimetres, including wrapping |
| Unit height (`shipping_height_cm`) | Centimetres, including wrapping |

For a combo, measure the complete sellable combo as one unit. Missing measurements block checkout when shipping is enabled.

Measure your actual shipping boxes. `SHIPROCKET_PACKAGES` must contain at least one valid box. This example explains the format only; replace the measurements with your own:

```json
[
  {
    "code": "SMALL",
    "length": 22,
    "breadth": 18,
    "height": 12,
    "inner_length": 20,
    "inner_breadth": 16,
    "inner_height": 10,
    "tare_weight_g": 100,
    "max_weight_kg": 5
  }
]
```

- Outer and inner dimensions are in centimetres. Inner dimensions describe usable space and cannot exceed the outer dimensions.
- `tare_weight_g` includes the empty box, tape and additional packing material. Do not count product wrapping twice.
- `max_weight_kg` is the box's total packed-weight limit, in kilograms.
- Each box needs a unique code. Outer dimensions must exceed 0.5 cm and be no more than 300 cm; packed weight must be positive and no more than 100 kg.
- The code stacks products and chooses a fitting box. One order uses one parcel and one pickup location. It does not split a large basket into multiple parcels.

Warehouse staff must follow the saved packing details. See [the existing packing guide](backend/SHIPPING_SETUP.md) for the algorithm and limitations.

## 4. Fill in the backend environment

For a direct Node deployment, edit the ignored `backend/.env` on the server. For managed hosting, set these names in the backend service's environment settings. For Docker Compose, use the production environment file plus section 5.

Keep credentials server-side. Do not add them to frontend JavaScript, this guide, or committed example files. Preserve existing database, Redis, admin, JWT, email and frontend-origin settings.

Start with shipping disabled:

```dotenv
NODE_ENV=production
SHIPROCKET_ENABLED=false
SHIPROCKET_EMAIL="REPLACE_WITH_API_USER_EMAIL"
SHIPROCKET_PASSWORD="REPLACE_WITH_API_USER_PASSWORD"
SHIPROCKET_CHANNEL_ID=REPLACE_WITH_ACTUAL_NUMERIC_CHANNEL_ID
SHIPROCKET_PICKUP_LOCATION="REPLACE_WITH_EXACT_REGISTERED_PICKUP_NAME"
SHIPROCKET_PICKUP_POSTCODE=REPLACE_WITH_SIX_DIGIT_PICKUP_PIN
SHIPROCKET_ORDER_PREFIX=REPLACE_WITH_UNIQUE_NUMERIC_PREFIX
SHIPROCKET_PACKAGES=[]
SHIPROCKET_WEBHOOK_SECRET=REPLACE_WITH_NEW_RANDOM_SECRET
```

Replace every placeholder before activation. The empty packages array deliberately prevents live activation until you provide measured boxes.

| Setting | Requirement |
| --- | --- |
| `NODE_ENV` | Exactly `production` for live shipping |
| `SHIPROCKET_ENABLED` | Exactly `false` during setup; `true` only at activation |
| `SHIPROCKET_EMAIL`, `SHIPROCKET_PASSWORD` | Your dedicated API-user credentials |
| `SHIPROCKET_CHANNEL_ID` | Positive numeric ID from your Shiprocket account |
| `SHIPROCKET_PICKUP_LOCATION` | Exact registered pickup name, including spaces/case |
| `SHIPROCKET_PICKUP_POSTCODE` | Six digits matching that pickup address |
| `SHIPROCKET_ORDER_PREFIX` | Unique 1–8 digit prefix starting with 1–9; keep stable for this store/environment |
| `SHIPROCKET_PACKAGES` | JSON array of measured boxes using the format in section 3 |
| `SHIPROCKET_WEBHOOK_SECRET` | Independent random secret of at least 32 characters |

For `.env`, put the package array on one line inside single quotes. For example, after replacing all sample measurements:

```dotenv
SHIPROCKET_PACKAGES='[{"code":"SMALL","length":22,"breadth":18,"height":12,"inner_length":20,"inner_breadth":16,"inner_height":10,"tare_weight_g":100,"max_weight_kg":5}]'
```

In a hosting dashboard, enter the raw JSON array without the surrounding `.env` single quotes. Ensure special characters in passwords are preserved by your environment-file format; Compose single-quoted values can prevent unintended dollar-sign interpolation.

Generate the webhook secret on your trusted machine:

```sh
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Save the output securely in the backend and webhook settings. Do not reuse the API password, JWT secret or Razorpay webhook secret.

### Prepaid orders also need live Razorpay configuration

COD shipping does not require a Razorpay payment. Prepaid shipping requires matching live Razorpay credentials and verified captured payment. Test-paid or unverified orders are blocked.

Follow [the Razorpay live setup guide](backend/razorpay.md), including `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET`, capture settings and the payment webhook. With shipping enabled, online checkout using a test Razorpay key is rejected.

## 5. Pass the settings into production

### AWS EC2 / Docker Compose

The current Compose backend has an explicit environment list but no Shiprocket entries. `--env-file` supplies values for Compose interpolation; it does not automatically forward every variable into the container. The project's `.dockerignore` also excludes `.env` files from the image.

**Required deployment-file change:** add the following entries under the existing `services > backend > environment` list in `docker-compose.prod.yml`. This guide documents the change; it has not applied it.

```yaml
      - SHIPROCKET_ENABLED=${SHIPROCKET_ENABLED:-false}
      - SHIPROCKET_EMAIL=${SHIPROCKET_EMAIL}
      - SHIPROCKET_PASSWORD=${SHIPROCKET_PASSWORD}
      - SHIPROCKET_CHANNEL_ID=${SHIPROCKET_CHANNEL_ID}
      - SHIPROCKET_PICKUP_LOCATION=${SHIPROCKET_PICKUP_LOCATION}
      - SHIPROCKET_PICKUP_POSTCODE=${SHIPROCKET_PICKUP_POSTCODE}
      - SHIPROCKET_ORDER_PREFIX=${SHIPROCKET_ORDER_PREFIX}
      - SHIPROCKET_PACKAGES=${SHIPROCKET_PACKAGES}
      - SHIPROCKET_WEBHOOK_SECRET=${SHIPROCKET_WEBHOOK_SECRET}
```

On the production host, from the repository directory, validate and redeploy using the actual secured environment-file path. These examples assume it is `backend/.env`:

```sh
docker compose --env-file backend/.env -f docker-compose.prod.yml config --quiet
docker compose --env-file backend/.env -f docker-compose.prod.yml up -d --build backend
docker compose --env-file backend/.env -f docker-compose.prod.yml ps
```

Keep `SHIPROCKET_ENABLED=false` for this initial deployment. Use `config --quiet` so expanded secrets are not printed. Use `up` to recreate the backend with changed environment values; a container restart alone does not replace its environment.

### Direct Node or another host

Set the variables in the actual backend runtime and restart/redeploy that service. Local `.env` edits do not update a remote server. Host environment variables take precedence over `.env` values with the current dotenv setup.

For Render, the checked-in `backend/render.yaml` defaults shipping to `false`. Review this setting when activating and on later blueprint deployments.

For all hosts, provide HTTPS, persistent PostgreSQL, and a continuously running backend. Back up the production database before deploying schema changes. Startup applies shipping-related migrations; verify startup completes successfully. A sleeping service delays background work.

## 6. Configure real-time tracking webhooks

In Shiprocket **Settings > API > Webhooks**, configure:

| Field | Value |
| --- | --- |
| URL | `https://YOUR_BACKEND_HOST/api/delivery-events` |
| Enabled | On |
| Security token | Exactly the backend's `SHIPROCKET_WEBHOOK_SECRET` |
| Delivery format | POST JSON; security token sent in `x-api-key` |

Replace the hostname with the public host that routes to your Express backend. If the website and API share a domain, use that domain only if `/api/delivery-events` reaches the backend. The endpoint and header follow [Shiprocket's webhook documentation](https://apidocs.shiprocket.in/).

Ensure your proxy forwards the path, body and `x-api-key` header. The route must be publicly reachable without a browser login or challenge. Use the exact route above; `/api/webhooks/shiprocket` is not this application's route.

This implementation requires the webhook security token even if the dashboard describes it as optional. It returns HTTP 200 after saving a valid event, 401 for a missing/wrong token, 400 for invalid payloads, and an error if storage fails. Opening the URL in a browser only checks the GET health response; it does not verify webhook authentication or tracking delivery.

### What “real-time” means here

1. The courier/Shiprocket reports a tracking event to your webhook.
2. The backend saves it in the database.
3. The worker checks pending events every 15 seconds and updates the matching order by AWB.
4. The signed-in customer orders page refreshes every 30 seconds while visible.

Updates therefore depend on the courier's reporting delay, worker load/retries and page refresh. This is near-real-time status tracking, not continuous GPS or guaranteed instant delivery. **Admin > Orders > Shipping details > Refresh courier tracking** performs a direct tracking query when an AWB exists.

## 7. Validate before enabling automatic booking

From `backend`, run the existing shipping tests:

```sh
node --test tests/shipping.test.js
```

These tests simulate gateways and do not create real shipments. They cannot prove that production credentials, account permissions, pickup details or webhook routing work.

For a direct Node environment, the following PowerShell command validates your configured shipping fields and measured box format, then checks API login without creating an order, AWB or pickup. Run from `backend` after replacing the placeholders:

```powershell
@'
require('dotenv').config({ quiet: true });
const env = { ...process.env, SHIPROCKET_ENABLED: 'true' };
(async () => {
  require('./shippingPolicy').shippingConfig(env);
  require('./parcelPacking').packageProfiles(env);
  await require('./shiprocketService').createShiprocketClient({ env }).getToken();
  console.log('Shipping configuration format and API login passed. No shipment created.');
})().catch(err => {
  console.error('Check failed:', err.code || 'unexpected_error');
  process.exitCode = 1;
});
'@ | node
```

The `true` override exists only in this short-lived validation process. It does not edit `.env` or start the shipping worker. `NODE_ENV` must already be `production`. The command does not print the token or credentials. Successful login does not confirm that the channel or pickup belongs to the account.

For Docker, validate the settings actually injected into the running backend with this equivalent command from the repository directory (shipping remains disabled in the server):

```sh
docker compose --env-file backend/.env -f docker-compose.prod.yml exec -T backend node -e "const env={...process.env,SHIPROCKET_ENABLED:'true'};(async()=>{require('./shippingPolicy').shippingConfig(env);require('./parcelPacking').packageProfiles(env);await require('./shiprocketService').createShiprocketClient({env}).getToken();console.log('Configuration format and API login passed. No shipment created.');})().catch(e=>{console.error('Check failed:',e.code||'unexpected_error');process.exitCode=1;});"
```

These login commands are provided for you to run; they were not executed against your live account while writing this guide.

## 8. Activate and verify controlled live orders

Once account setup, measurements, deployment and webhooks are ready:

1. Keep checkout access controlled during verification. Set `SHIPROCKET_ENABLED=true` in the production environment and redeploy/recreate the backend. Live operations can incur courier charges; prepaid verification also involves a real payment.
2. Confirm startup succeeds. Missing shipping settings or boxes will prevent startup when shipping is enabled.
3. Place one controlled **new COD order** to a serviceable address. Confirm it appears in Admin > Orders and its shipping job progresses.
4. Check exactly one matching order in Shiprocket. Compare recipient details, quantities, package measurements, payment method and COD collection amount with the saved store order.
5. Confirm an AWB is assigned, pickup is confirmed, and label/manifest links work. A queued job or AWB alone does not prove pickup was scheduled.
6. If offering prepaid, place one controlled **new live prepaid order**. Confirm Razorpay captured payment and the application verified it before shipment booking. Check Shiprocket shows Prepaid and the correct total.
7. Print the documents and pack the saved box. Arrange the real pickup with the courier; requesting pickup does not mean immediate collection.
8. Verify a real Shiprocket tracking POST receives HTTP 200 and the matching order updates in both admin and the customer page. Do not post invented delivered/cancelled events against a real AWB to test the route.
9. Check that an unsupported destination is rejected before payment and an unpaid/failed payment has no shipment booking.
10. Open checkout to customers after these checks pass.

Orders created while shipping was disabled stay held for review; enabling shipping does not automatically release them. For eligible held orders, review measured parcel details and use **Queue / resume shipment**. Test-paid prepaid orders cannot be converted into valid live-paid shipments by changing their status.

## 9. Troubleshooting and daily operation

| Symptom | What to check |
| --- | --- |
| Shipping stays disabled after editing `.env` | Correct server environment; Compose mappings; backend recreated with new values |
| `environment` / real shipping requires production | Set `NODE_ENV=production` in the backend runtime |
| `configuration` | Replace placeholders; verify numeric channel/prefix, pickup PIN and secret length |
| `packages` or product measurement errors | Valid measured box JSON and all four shipping fields for purchased products |
| HTTP 401/403 from Shiprocket | Dedicated API-user credentials, active user and necessary permissions |
| Online checkout not ready for live shipping | Matching live Razorpay credentials and payment configuration |
| No courier available | Pickup/destination PINs, parcel dimensions/weight and COD/prepaid serviceability |
| AWB or pickup fails | Wallet balance, account eligibility, courier availability and current remote shipment state |
| Webhook HTTP 401 | Exact secret match and preserved `x-api-key` header |
| Webhook 200 but no visible update | AWB matches the order; worker running; event not pending/review; page refresh; recognized status |
| Job stuck or `needs_review` | Open Shipping details, read the last error and reconcile the existing Shiprocket order before resuming |

The worker retries failed booking stages with backoff, up to six attempts before review. Use **Refresh progress** for saved job progress and **Refresh courier tracking** for current remote tracking. Never delete/reset a job to force a second shipment after an uncertain response.

To pause automatic booking, set `SHIPROCKET_ENABLED=false` and redeploy. This does not cancel existing Shiprocket shipments, stop an already-running request, or stop checkout from accepting orders held for review. Manage storefront availability separately if you need to stop new orders. Cancel shipments in Shiprocket and handle payment refunds separately; changing a local order status does not cancel a courier pickup.

Customer shipping fees follow the store's existing pricing policy, not the live courier quote. Check actual courier charges against your margins. Multiple warehouses, automatic parcel splitting, automated returns/refunds and inventory reservation are outside this shipping flow.

## Completion checklist

- [ ] API user can log in; required account permissions are enabled.
- [ ] Pickup name/PIN and channel ID are verified against the account.
- [ ] Every purchasable product and shipping box has real measurements.
- [ ] All Shiprocket variables reach the production backend, including Compose mappings if used.
- [ ] HTTPS, persistent database, startup migrations and always-on worker are verified.
- [ ] Shiprocket webhook is enabled with the matching security token.
- [ ] Live Razorpay payment/webhook setup is verified if offering prepaid.
- [ ] Controlled live order has correct amounts, one shipment/AWB, confirmed pickup and usable documents.
- [ ] Real tracking events reach admin and the customer page.
- [ ] Staff know how to review held orders, resume jobs, cancel shipments and handle refunds.

Implementation references: [API client](backend/shiprocketService.js), [configuration guards](backend/shippingPolicy.js), [packing](backend/parcelPacking.js), [worker](backend/orderFulfillment.js), [webhook route](backend/routes/shiprocket.js), [deployment configuration](docker-compose.prod.yml), and [detailed shipping guide](backend/SHIPPING_SETUP.md).
