'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '../..');
const dockerAvailable = spawnSync('docker', ['compose', 'version'], { encoding: 'utf8' }).status === 0;

for (const file of ['docker-compose.yml', 'docker-compose.prod.yml']) {
  test(`${file} resolves to separate apps with private persistent dependencies`, { skip: !dockerAvailable }, t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'brainygrasp-compose-config-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const fixture = path.join(dir, 'fixture.env');
    const values = { APP_ENV_FILE: fixture.replace(/\\/g, '/'), DB_PASSWORD: 'fixture-database', REDIS_PASSWORD: 'fixture-cache',
      JWT_SECRET: 'fixture-jwt', ADMIN_USERNAME: 'fixture-admin', ADMIN_PASSWORD: 'fixture-admin-password',
      DB_USER: 'fixture', DB_NAME: 'fixture', FRONTEND_URL: 'https://brainygrasp.com', ALLOWED_ORIGINS: 'https://brainygrasp.com',
      SHIPROCKET_ENABLED: 'false', SHIPROCKET_PACKAGES: '[]', SHIPROCKET_WEBHOOK_SECRET: 'fixture-shipping',
      RAZORPAY_WEBHOOK_SECRET: 'fixture-payment', EMAIL_USER: 'fixture@example.invalid', EMAIL_PASS: 'fixture-mail' };
    fs.writeFileSync(fixture, Object.entries(values).map(([k, v]) => `${k}=${v}`).join('\n'));
    const result = spawnSync('docker', ['compose', '--env-file', fixture, '-f', file, 'config', '--format', 'json'], {
      cwd: root, encoding: 'utf8', env: { ...process.env, ...values }, timeout: 30000
    });
    assert.equal(result.status, 0, result.stderr);
    const { services, volumes } = JSON.parse(result.stdout);
    assert.deepEqual(Object.keys(services).sort(), ['backend', 'db', 'frontend', 'redis']);
    for (const [name, port, target] of [['frontend', '3000', 8080], ['backend', '5000', 5000]]) {
      const service = services[name];
      assert.equal(service.build.dockerfile, `${name}/Dockerfile`);
      assert.equal(service.pull_policy, 'build');
      assert.equal(service.ports.length, 1);
      assert.equal(service.ports[0].host_ip, '127.0.0.1');
      assert.equal(String(service.ports[0].published), port);
      assert.equal(service.ports[0].target, target);
    }
    assert.equal(services.frontend.environment, undefined);
    assert.equal(services.db.ports, undefined);
    assert.equal(services.redis.ports, undefined);
    assert.ok(volumes.postgres_data); assert.ok(volumes.redis_data);
    assert.equal(services.backend.environment.PORT, '5000');
    assert.equal(services.backend.environment.SERVE_FRONTEND, 'false');
    assert.equal(services.backend.environment.DB_HOST, 'db');
    assert.equal(services.backend.environment.REDIS_HOST, 'redis');
    assert.equal(services.backend.environment.SHIPROCKET_WEBHOOK_SECRET, values.SHIPROCKET_WEBHOOK_SECRET);
    assert.equal(services.backend.environment.RAZORPAY_WEBHOOK_SECRET, values.RAZORPAY_WEBHOOK_SECRET);
    assert.equal(services.backend.environment.EMAIL_PASS, values.EMAIL_PASS);
    assert.equal(services.backend.depends_on.db.condition, 'service_healthy');
    assert.equal(services.backend.depends_on.redis.condition, 'service_healthy');
  });
}

// Optional integration checks against a disposable stack and reverse proxy.
// DOCKER_SMOKE_URL=http://127.0.0.1:18080 DOCKER_API_URL=http://127.0.0.1:15000
// Never point these tests at a live store. They make read-only/unauthenticated requests.
const base = process.env.DOCKER_SMOKE_URL;
const api = process.env.DOCKER_API_URL;
const smoke = { skip: !base || !api };
const get = (url, options = {}) => fetch(url, { signal: AbortSignal.timeout(10000), ...options });

test('Docker proxy serves every HTML page and referenced local script/style/image', smoke, async t => {
  const assets = new Set(); let pages = 0;
  for (const folder of ['frontend', 'admin']) {
    for (const file of fs.readdirSync(path.join(root, folder), { recursive: true }).filter(f => f.endsWith('.html'))) {
      const route = (folder === 'admin' ? '/admin/' : '/') + file.replace(/\\/g, '/');
      const url = new URL(route, base);
      const response = await get(url);
      assert.equal(response.status, 200, route);
      assert.match(response.headers.get('content-type'), /text\/html/, route);
      assert.match(response.headers.get('cache-control'), /no-store/, route);
      pages++;
      const html = await response.text();
      for (const [, ref] of html.matchAll(/(?:src|href)=["']([^"']+)["']/g)) {
        const asset = new URL(ref, url);
        if (asset.origin === url.origin && /\.(js|css|png|jpg|jpeg|svg|webp|ico)$/i.test(asset.pathname)) assets.add(asset.href);
      }
    }
  }
  for (const url of assets) assert.equal((await get(url)).status, 200, url);
  t.diagnostic(`${pages} HTML pages and ${assets.size} local assets served successfully`);
});

test('Docker proxy preserves portal redirects, legacy URLs and API paths', smoke, async () => {
  for (const route of ['/', '/admin/', '/affiliate/', '/frontend/index.html', '/frontend/js/config.js', '/about']) {
    const response = await get(new URL(route, base));
    assert.equal(response.status, 200, route);
  }
  for (const route of ['/admin', '/affiliate', '/frontend']) {
    const response = await get(new URL(route, base), { redirect: 'manual' });
    assert.equal(response.status, 301, route);
    assert.equal(response.headers.get('location'), route + '/');
  }
  for (const route of ['/api', '/api/health?probe=1', '/api/products']) {
    const response = await get(new URL(route, base));
    assert.equal(response.status, 200, route);
    assert.match(response.headers.get('content-type'), /application\/json/);
  }
  assert.equal((await get(new URL('/api/orders?fresh=1', base))).status, 401);
  assert.equal((await get(new URL('/api/payment/create-order', base), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 401);
  assert.equal((await get(new URL('/api/not-a-route', base))).status, 404);
  assert.equal((await get(new URL('/.env', base))).status, 403);
});

test('Docker API starts independently and reports healthy database and Redis', smoke, async () => {
  const response = await get(new URL('/api/health', api));
  assert.equal(response.status, 200);
  const health = await response.json();
  assert.equal(health.services.database, 'healthy');
  assert.equal(health.services.redis, 'healthy');
  assert.equal((await get(new URL('/checkout_cod.html', api))).status, 404);
  assert.equal((await get(new URL('/admin/index.html', api))).status, 404);
});
