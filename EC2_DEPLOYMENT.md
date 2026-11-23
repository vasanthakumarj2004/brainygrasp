# Docker frontend, API and host Nginx deployment

The default deployment uses separate frontend and backend images. Run commands
from the repository root (the directory containing docker-compose.yml).

| Service | Host binding | Purpose |
| --- | --- | --- |
| Frontend | 127.0.0.1:3000 -> container 8080 | Static storefront, admin and affiliate pages |
| Backend | 127.0.0.1:5000 -> container 5000 | API, payment webhooks and shipping worker |
| PostgreSQL | No published port | Persistent database on the Compose network |
| Redis | No published port | Persistent cache on the Compose network |

Host Nginx routes / to port 3000 and /api or /api/... directly to port 5000.
Browsers use the public domain for API calls. Keep ports 3000/5000 private; only
host Nginx needs them. TLS certificates and Certbot stay on the host.

For the Nginx site shown in the AWS setup, the root `.env` should use:

```dotenv
FRONTEND_URL=https://brainygrasp.com
ALLOWED_ORIGINS=https://brainygrasp.com,https://www.brainygrasp.com
PORT=5000
SERVE_FRONTEND=false
```

Compose publishes only `127.0.0.1:3000` (frontend) and `127.0.0.1:5000`
(backend), matching the host Nginx upstreams. Do not expose these container
ports publicly or change the Nginx upstreams to the container-only ports.

## Configure and start

For a new deployment:

```sh
cp .env.example .env
chmod 600 .env
# Edit .env with your actual database, authentication, email and service values.
docker compose config --quiet
docker compose up -d
docker compose ps
```

The images are named brainygrasp-frontend:local and brainygrasp-backend:local.
Compose's pull_policy: build builds them from this checkout on up, reusing cached
layers. PostgreSQL and Redis use their official images. To deploy code updates,
update the checkout and run docker compose up -d again.

The ignored root .env supplies both Compose variables and backend runtime
settings. Real environment files are excluded from image builds. Backend-only
settings (including all Razorpay, Shiprocket and SMTP values) never enter the
frontend container. Do not use the example credentials in production.

Compose forces PORT=5000 and SERVE_FRONTEND=false. It also forces connections
to its db and redis services, using separate password fields rather than URLs.
This default stack does not use RDS, Neon, Upstash or an existing external database.
If you already have production data elsewhere, retain that deployment until you
have deliberately configured the connections or migrated the data.

For an existing Compose database, retain the project name, postgres_data volume,
DB_USER, DB_NAME and DB_PASSWORD. Changing POSTGRES_PASSWORD does not change an
existing database user's password. Do not run docker compose down -v on real data.
The former pgAdmin service is not part of this production stack.

docker-compose.prod.yml is an equivalent standalone entry point:

```sh
docker compose -f docker-compose.prod.yml up -d
```

To explicitly use another environment file, supply it to both Compose and the
backend (the path below is an example, not a file provided by this repository):

```sh
APP_ENV_FILE=/secure/brainygrasp.env docker compose --env-file /secure/brainygrasp.env up -d
```

Keep SHIPROCKET_ENABLED=false until the existing shipping setup is ready.
Confirmation still queues automatic shipment creation when enabled. This packaging
change does not alter payment verification or shipment logic.

### Temporary Razorpay verification login

The storefront's test-account email/password login is disabled unless the backend
environment has all of the following:

- `REVIEWER_LOGIN_ENABLED=true`
- `REVIEWER_PASSWORD_HASH` set to a bcryptjs cost-12 hash of the agreed test password
- `RAZORPAY_KEY_ID` and `RAZORPAY_KEY_SECRET` set to matching Razorpay **test** credentials
- `SHIPROCKET_ENABLED=false`

In the AWS EC2 deployment, put these values in the backend runtime environment
file: the root Compose `.env` when `APP_ENV_FILE` is unset, or the file named by
`APP_ENV_FILE` otherwise. Keep the hash out of Git and wrap it in single quotes:
Compose may otherwise expand `$` sequences in bcrypt hashes. For example:

```dotenv
REVIEWER_LOGIN_ENABLED=true
REVIEWER_PASSWORD_HASH='$2b$12$REPLACE_WITH_THE_COMPLETE_BCRYPT_HASH'
RAZORPAY_KEY_ID=rzp_test_REPLACE_WITH_TEST_KEY_ID
RAZORPAY_KEY_SECRET=REPLACE_WITH_MATCHING_TEST_KEY_SECRET
SHIPROCKET_ENABLED=false
```

The password hash must be generated from the exact test password entered on the
storefront, with bcryptjs cost 12. After editing the EC2 environment file, validate
Compose and recreate the backend:

```sh
docker compose config --quiet
docker compose up -d --build --force-recreate backend
docker compose exec -T backend node -e "const {reviewerConfigStatus}=require('./reviewerLogin'); console.log(reviewerConfigStatus(process.env))"
```

The final command prints only boolean checks, never credential values. Each check
must be `true`; otherwise correct the corresponding backend environment setting.
This mode disables normal OTP sign-in and rejects non-reviewer customer sessions;
turn it off and restore the normal payment configuration after verification.

## Install the host Nginx configuration

Use [deploy/nginx/brainygrasp.conf](deploy/nginx/brainygrasp.conf) on the EC2 host.
The separate [deploy/nginx/frontend.conf](deploy/nginx/frontend.conf) is packaged
inside the frontend image; it is not the host reverse proxy configuration.

For a new Ubuntu/Debian site, after installing Nginx:

```sh
curl --fail http://127.0.0.1:3000/health
curl --fail http://127.0.0.1:5000/api/health
sudo install -m 0644 deploy/nginx/brainygrasp.conf /etc/nginx/sites-available/brainygrasp
sudo ln -s /etc/nginx/sites-available/brainygrasp /etc/nginx/sites-enabled/brainygrasp
sudo nginx -t
sudo systemctl reload nginx
```

Only reload after nginx -t succeeds. If this site is already enabled, edit the
existing file rather than creating another server block with the same domain.
The host configuration preserves /api prefixes, request bodies, query strings,
authorization headers and webhook signatures. It disables upstream retries and
proxy caching so payment requests are not automatically replayed.

After both names resolve to the host, with ports 80/443 reachable and Certbot's
Nginx plugin installed:

```sh
sudo certbot --nginx --redirect -d brainygrasp.com -d www.brainygrasp.com
sudo nginx -t
sudo certbot renew --dry-run
```

Certbot adds HTTPS and the HTTP redirect. Do not overwrite the certificate-bearing
configuration with the HTTP bootstrap afterward. For an existing HTTPS site,
keep its TLS directives and apply the proxy headers and three location blocks
from brainygrasp.conf inside its HTTPS server block. Both the exact /api location
and the /api/ prefix go to port 5000, with no trailing slash on proxy_pass.

The earlier [EC2 User data script](deploy/ec2-user-data.sh) targets the legacy
combined Node app on port 3000. It does not install Docker or configure the new
separate API route. If that script already configured certificates, preserve its
ACME challenge location and TLS directives, then apply the new API locations and
shared proxy settings to that existing site. Use the manual instructions above
for a fresh split-container deployment.

## Verify the deployment

```sh
docker compose ps
docker compose logs --tail=100 backend frontend
curl -I https://brainygrasp.com/
curl -I https://brainygrasp.com/admin/
curl -I https://brainygrasp.com/affiliate/
curl --fail https://brainygrasp.com/api/health
```

The frontend health check verifies its static server. The API health check verifies
database access and reports Redis status. The backend starts after PostgreSQL and
Redis are healthy and initializes its schema before listening. Startup includes
the additive tracking reconciliation migration; the database user needs schema
creation/alteration privileges.

The frontend retains /frontend/... legacy paths, extensionless pages, HTML
no-store responses and asset revalidation. Unknown API requests never return a
storefront page. Direct calls to port 3000/api intentionally return 404: the host
reverse proxy is responsible for directing public API traffic to port 5000.

Open the domain in a browser and verify that API requests use the same HTTPS
origin. No browser request should target container names, localhost or port 5000.
Check Razorpay and Shiprocket webhook URLs continue to use the public /api paths.

Local npm development is unchanged: backend/server.js still defaults to the
combined app on port 3000 outside Docker, and frontend-server.js supports port
5500 for development. This document describes the separate production containers.

## Local verification

On 20 November 2026, both images built and started against disposable PostgreSQL
and Redis containers. Both Nginx configurations passed nginx -t. The proxy served
all 34 HTML pages and 56 referenced local assets; portal redirects, legacy URLs,
API routing and database/cache health checks passed. All 175 automated tests passed,
including the optional Docker integration checks. The temporary stack was removed;
the two built images remain available locally. No live service credentials were
used and no EC2 configuration was changed.

References: [Docker Compose build policy](https://docs.docker.com/reference/compose-file/services/#pull_policy),
[Nginx proxy_pass URI behavior](https://nginx.org/en/docs/http/ngx_http_proxy_module.html#proxy_pass).
