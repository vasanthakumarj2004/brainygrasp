# Frontend and API deployment on EC2

The application now serves the storefront, admin, affiliate portal and API from
one Node process on port 3000. You do not need to run `frontend-server.js` or expose
5500/5501 in production. The browser uses its current origin for `/api` requests,
whether opened on the EC2 IP, `brainygrasp.com` or `www.brainygrasp.com`.

## Deploy the complete project

Upload/checkout the project including `backend/`, `frontend/` and `admin/`.
Uploading only `backend/` cannot serve the frontend. Keep the real environment
file outside Git and preserve the existing database and credentials.

Set these values in the EC2 backend runtime or its ignored `backend/.env`:

```dotenv
NODE_ENV=production
PORT=3000
SERVE_FRONTEND=true
FRONTEND_URL=https://brainygrasp.com
ALLOWED_ORIGINS=https://brainygrasp.com,https://www.brainygrasp.com
```

Retain the correct database, Redis, authentication and existing service settings.
This frontend fix does not require switching payment keys. The application must
connect to its database and Redis during startup before it can serve requests.

For a direct Node deployment, run from the project directory:

```sh
cd backend
npm ci --omit=dev
npm start
```

Run that command under the process supervisor already used on EC2 so it survives
SSH disconnects and reboots. Do not start a second copy on an occupied port.

For the existing Docker Compose deployment, run from the project directory:

```sh
docker compose --env-file backend/.env -f docker-compose.prod.yml config --quiet
docker compose --env-file backend/.env -f docker-compose.prod.yml up -d --build
```

The Docker build context is now the project root. For a standalone image build:

```sh
docker build -f backend/Dockerfile -t brainygrasp .
```

The image includes both frontend directories and excludes `.env`, Git history and
local node_modules. The Compose deployment uses its own PostgreSQL/Redis services;
if your EC2 deployment already uses other database services, retain that existing
deployment arrangement. Do not replace an existing database, change the Compose
project name or remove volumes as part of this frontend fix.

## Existing HTTPS proxy

Forward **all paths** to the application on port 3000, not only `/api`. For a host
Nginx proxy, the location block inside the existing TLS server is:

```nginx
location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Host $http_host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-For $remote_addr;
}
```

This example assumes Nginx is the single trusted proxy on the same EC2 machine.
Keep your existing domain certificate configuration. If using an ALB instead,
forward the site's requests to the app target and preserve the original host and
HTTPS scheme. Restrict direct backend access to the proxy where appropriate.
The application currently trusts one proxy hop; a different proxy chain needs
its trust setting reviewed. No proxy, certificate or AWS change was applied here.

## Verify after restart

From EC2, these checks should pass before testing the public domain:

```sh
curl -I http://127.0.0.1:3000/
curl -I http://127.0.0.1:3000/js/config.js
curl http://127.0.0.1:3000/api/health
```

Expected: HTML at `/`, JavaScript at `/js/config.js`, and healthy JSON at
`/api/health`. Then open `/`, `/admin/` and `/affiliate/` through the public domain.
Check DevTools Network: API requests should use the same public origin, with no
Render address, localhost address, unexpected port 3000, or mixed HTTP/HTTPS.

If the local checks pass but the domain does not, inspect the existing DNS,
security group and proxy routing. A CORS change cannot fix a closed port or a
domain routed to a different server. Do not use a wildcard CORS allowlist as a fix.

Local development still supports the separate frontend on localhost:5500/5501
calling localhost:3000. API-only deployments can set `SERVE_FRONTEND=false`.

## Verification performed

The regression suite tests page/asset serving, portal redirects, same-origin
requests, explicit allowed origins, rejected unrelated origins, local development,
proxy HTTPS handling and unchanged raw webhook bodies. The production Docker image
is also tested with separate disposable PostgreSQL and Redis containers, without
using the local application's data or credentials.

Result on 18 November 2026: 85 automated tests passed. The built Linux image
started successfully, served all 34 HTML pages and 53 referenced local assets
without errors, and passed API health, authentication, catalog and CORS checks.
The packaged portal scripts resolved their API URLs to the same test origin.
These are local production-image checks; the EC2 host itself was not modified
or verified in this task.

References: [Express static files](https://expressjs.com/en/starter/static-files/),
[Express proxy configuration](https://expressjs.com/en/guide/behind-proxies/).
