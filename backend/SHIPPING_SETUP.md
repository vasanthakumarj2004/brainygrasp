# Automatic shipping setup

The code is prepared for one pickup location and one parcel per order. Live shipping
has not been enabled or exercised as part of this change. Existing checkout orders
created while shipping is disabled remain held for review after activation.

## What checkout now does

1. Read product prices, quantities and unit shipping measurements from the database.
2. Save the delivery address and calculated parcel as an immutable order snapshot.
3. When shipping is enabled, check Shiprocket serviceability for the pickup PIN,
   destination PIN, packed weight/dimensions, payment mode and order value **before**
   saving a new COD order or creating the Razorpay payment order.
4. Confirm COD immediately; confirm prepaid only after verified captured payment.
5. Insert exactly one queued shipping job in the same database transaction as
   confirmation. Pending online payments have no shipping job.
6. The worker (every 15 seconds) rechecks courier availability, creates or reconciles
   the Shiprocket order, assigns AWB, requests pickup, and generates label/manifest.
7. Save booking progress and process tracking webhooks. Unknown mutation results
   are reconciled by reads instead of blindly creating another shipment.

The customer shipping charge remains INR 60 below an INR 999 merchandise subtotal,
and zero at/above that threshold. Discounts follow the existing checkout policy.
This is a store pricing policy, not a live courier quote. The store pays the actual
carrier charge, which may differ. Courier choice is Shiprocket's recommendation
when available, otherwise the lowest returned rate.

## Measure products and boxes first

In Admin > Products, enter all four shipping fields for each purchasable product:

- Unit weight in whole grams, including that unit's protective wrapping.
- Unit length, width and height in centimetres, including the same wrapping.

Draft products may leave all fields blank, but live checkout rejects incomplete
measurements. No default product weight is assumed. Combo products must describe
the complete sellable combo as one unit. Editing a product does not change a
previous order's recorded measurements.

Configure `SHIPROCKET_PACKAGES` as a JSON array of **your measured boxes**. This is
an illustrative format only; do not enable shipping with unverified sample values:

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

Outer dimensions are sent to Shiprocket. Inner dimensions are the usable space
after protective lining. Tare includes the outer box, tape and additional packing
material; do not count unit wrapping twice. Maximum weight is the packed box limit.

The conservative packing rule places each unit flat on its two longest sides,
stacks the shortest sides, and chooses the smallest configured outer box that fits
the entire stack (allowing rotation of the stack) and supports its total weight.
Weight = sum(unit grams × quantity) + box tare, converted to kg. Warehouse staff
must follow the recorded packing layout, shown in Shipping details. This rule is
intended for stackable, rotatable products. It may reject a basket that a person
could pack differently. Oversized baskets require arranging a custom order; the
customer is blocked before payment rather than charged for an unbookable parcel.
Automatic multi-box splitting, fragile/orientation-specific packing, inventory
reservations and multiple pickup warehouses are not included.

Shiprocket considers actual and volumetric weights for charges. See its
[weight guidance](https://support.shiprocket.in/support/solutions/articles/43000664201-explain-the-different-types-of-weight-terminology-used-in-the-platform-).

## Account and server configuration

Complete Shiprocket KYC, fund the wallet, register/verify the pickup location and
check COD/remittance settings in the dashboard. Create a dedicated API user with
access to orders, couriers, shipments, tracking and shipment documents, including
the buyer details needed for order read-back. See the
[official API documentation](https://apidocs.shiprocket.in/).

Set backend environment variables, never frontend code:

| Variable | Required value |
| --- | --- |
| `NODE_ENV` | `production` for real shipping |
| `SHIPROCKET_ENABLED` | Keep `false` until ready; `true` activates automatic booking for new checkouts |
| `SHIPROCKET_EMAIL` / `SHIPROCKET_PASSWORD` | Dedicated API-user credentials, exchanged for a bearer token by the server |
| `SHIPROCKET_CHANNEL_ID` | Positive numeric ID of this store's Shiprocket channel |
| `SHIPROCKET_PICKUP_LOCATION` | Exact registered pickup name |
| `SHIPROCKET_PICKUP_POSTCODE` | Six-digit PIN matching that pickup |
| `SHIPROCKET_ORDER_PREFIX` | Unique nonzero 1–8 digit prefix for this store/environment; keep stable |
| `SHIPROCKET_PACKAGES` | Measured box profiles as JSON above |
| `SHIPROCKET_WEBHOOK_SECRET` | Independent random secret of at least 32 characters |
| `RAZORPAY_KEY_ID` / `RAZORPAY_KEY_SECRET` | Live credentials for online checkout with live shipping |
| `RAZORPAY_WEBHOOK_SECRET` | Independent secret matching Razorpay webhook configuration |

Do not reuse an order prefix/channel with another store or reset its order sequence.
Changing pickup/channel/prefix while jobs are active puts those jobs into review;
their saved booking identity is intentionally retained. Never delete/reset a job
to recover an uncertain remote creation.

Use an HTTPS backend with persistent PostgreSQL and a continuously running Node
process. The in-process worker cannot run while the host sleeps. Configure an
always-on hosting plan before launch. `render.yaml` deliberately keeps shipping
disabled; review that switch on subsequent blueprint deployments as well.

Startup applies additive schema migrations: product measurements, order snapshots,
shipping jobs and webhook inbox. Existing products are not assigned invented
measurements. Follow the normal database backup and deployment procedure.

## Webhooks

- Shiprocket: **POST `https://YOUR_BACKEND/api/delivery-events`**, enabled in
  Settings > API > Webhooks, security token sent as **`x-api-key`** matching
  `SHIPROCKET_WEBHOOK_SECRET`. Do not put it in a query string or use the obsolete
  `/api/webhooks/shiprocket` route. The public GET health response does not validate
  a tracking update; verify a real authenticated POST.
- Razorpay: **POST `https://YOUR_BACKEND/api/webhooks/razorpay`**, subscribe to
  `payment.captured` and `order.paid` with the matching independent secret.

The Shiprocket webhook is acknowledged only after the tracking event is stored.
The worker applies events, handles duplicates and avoids regressing terminal
delivery states. See `PAYMENTS_SETUP.md` for payment configuration details.

## Admin operations

Admin > Orders > Shipping details shows the parcel, package code/packing layout,
queue state, last error, AWB and document download links. Use Refresh progress to
read worker progress; Refresh courier tracking queries Shiprocket.

Held legacy/development COD orders require measured parcel details and explicit
Queue / resume shipment. Existing booking attempts retain their reference, parcel
and pending stage. Resume is available even when an AWB exists but pickup/documents
need attention. A queued response means work is pending, not pickup success.
Test-paid and unverified prepaid orders cannot be booked.

The worker makes up to six attempts with backoff before `needs_review`. Review
wallet balance, address availability and the existing remote order first. Unknown
creation/AWB/pickup outcomes are never blindly retried as new mutations. If remote
lookup cannot resolve an uncertain outcome, reconcile it in Shiprocket before any
manual recovery. A confirmed pickup remains confirmed if document generation fails;
document retries do not rebook the pickup.

Print the label and manifest, pack the recorded box and have it ready for collection.
Requesting pickup does not guarantee immediate physical collection; actual timing
is determined by Shiprocket/courier scheduling.

Cancellation and refunds remain operational tasks: cancel the remote shipment in
Shiprocket, refresh tracking, and handle any payment refund in Razorpay. A local
status edit does not cancel a courier pickup. Automatic refund, return/NDR workflows,
and stock management have not been added.

## Verification before launch

From `backend`, run `npm test` (`npm.cmd test` in PowerShell if script policy blocks
`npm.ps1`). Tests use in-memory database adapters and simulated gateways; they do
not load `.env`, migrate a real database or create actual shipments.

Before opening checkout to customers:

1. Deploy with shipping disabled; verify database migration and enter real product
   measurements/box profiles. Verify HTTPS, webhook routing and worker uptime.
2. Configure and validate the real account credentials, channel and pickup.
3. Enable shipping for a controlled COD order and one verified live prepaid order.
   These are real orders with real courier/payment charges, not sandbox tests.
4. Check item quantities, destination, parcel weight/dimensions, discount/shipping
   totals, COD amount or prepaid mode against Shiprocket before collection.
5. Verify exactly one remote order, AWB and pickup, and downloadable label/manifest.
   Test response-loss recovery and tracking delivery without creating duplicates.
6. Verify an unsupported PIN is rejected before payment and failed/unconfirmed
   payments never book. Verify customer tracking receives webhook updates.

Live account validation, real PostgreSQL migration verification and physical
pickup/delivery remain deployment checks; passing mocked tests does not prove them.
