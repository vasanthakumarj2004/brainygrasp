# Admin product publishing

## Sentence Safari and Mag Clash catalog

`catalog-products.json` contains the owner's two products and image galleries.
The six original images are copied into `frontend/images/products/` so they work
on both the local storefront and Vercel. The originals remain in `products/`.

On the first backend start, `catalogMigration.js` replaces the mock catalog in a
single transaction. It stores all previous product rows in
`catalog_migrations.previous_products` under migration
`2026-11-15-sentence-safari-mag-clash`. It does not delete orders or users, reuse
old product IDs, or reset future admin edits on subsequent starts. Existing cart
items for removed IDs are rejected by checkout. To apply it to an initialized
database manually, run `node backend/import-catalog.js` from the project root.
Deploy frontend assets and backend changes together.

Both products start at 50 units in `stock_quantity`; this is catalog metadata,
not an automated inventory reservation/decrement system. Existing admin edits
preserve `details` and stock. The admin list displays the recorded stock.

The storefront uses the supplied age 5–8 for Sentence Safari, although its
provided artwork reads 5–7. The eighth grammar category, Preposition, appears
on the supplied contents image. The listed contents use exactly 130 cards.
Dimensions are stored in inches for display and converted to centimetres for
shipping. Sentence Safari's unit weight with its extra cover is 320 g; Mag
Clash is 580 g. Outer shipment packaging remains configured separately.

## Publishing admin edits

Product saves update PostgreSQL through the admin API. Public catalog and search
requests read the database directly and return `Cache-Control: no-store`. Legacy
catalog/search Redis entries are also cleared on create, edit and delete.

After deployment, a newly opened or reloaded storefront page reads the latest
catalog. Visible open pages refresh every 60 seconds and when focus returns
(requests within five seconds are deduplicated/throttled). This is polling, so an
already open page does not update at the exact instant the admin clicks Save.
Collections, age/category filters, search and displayed gift recommendations
respond to refreshed data. Product groups determine placement on the home page.

## Images

The admin currently accepts **one image URL per product**, not file uploads or a
gallery. Use a direct public HTTPS image URL or an existing storefront path such
as `/images/toy.jpg`. The admin checks that the image loads before saving; the API
validates URL syntax. Google sharing-page links are rejected. Storefront cards
use a local placeholder if an image later becomes unavailable.

When replacing an image, publish it under a new filename/URL to avoid the image
host's browser/CDN cache. Relative paths must exist on both the admin preview
origin and storefront origin; a public absolute HTTPS URL avoids that ambiguity.
The application does not upload or host a new image from the URL field.

## Deployment verification

1. Deploy backend, admin and frontend changes together. Ensure both configs point
   to the same production backend and that its database is the intended catalog.
2. Confirm `brainygrasp.com` and `www.brainygrasp.com` resolve to the storefront
   deployment, with valid HTTPS. Domain resolution failed from the audit environment;
   this alone does not establish that the domain is unavailable everywhere.
3. Reload the admin so it receives the image-validation code. Add/edit an intended
   catalog product and verify its image, price, group, category, age and skills in
   the storefront, search and applicable collection. Verify an already open page
   updates after its next refresh interval.
4. Follow `SHIPPING_SETUP.md` for unit weight/dimensions, packaging and live shipping
   activation. Saving a product alone does not activate shipping.

Local tests use a disposable in-memory database and mocked browser objects. Run
`npm test` in `backend`. They verify create/edit/delete visibility, filtering,
pagination, cart selection and rejected image saves. Actual browser rendering and
the deployed production database still require the deployment check above.
