'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const http = require('node:http');
const { spawn } = require('node:child_process');
const express = require('express');
const { once } = require('node:events');
const { mountFrontend } = require('../serveFrontend');
const { createCorsPolicy } = require('../corsPolicy');

const root = path.resolve(__dirname, '../..');
async function site(t, env = { NODE_ENV: 'production', ALLOWED_ORIGINS: 'https://brainygrasp.com/, https://www.brainygrasp.com' }) {
  const app = express();
  app.set('trust proxy', 1);
  app.use(createCorsPolicy(env));
  app.post('/api/webhooks/razorpay', express.raw({ type: 'application/json' }), (req, res) =>
    res.json({ hash: crypto.createHash('sha256').update(req.body).digest('hex'), signature: req.get('x-razorpay-signature') }));
  app.use(express.json());
  app.all('/api/probe', (req, res) => res.json({ ok: true }));
  mountFrontend(app);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  return `http://127.0.0.1:${server.address().port}`;
}

test('one server serves every storefront, admin and affiliate page with local scripts, styles and images', async t => {
  const base = await site(t);
  const pages = ['/', '/admin/', '/affiliate/', '/frontend/'];
  for (const [folder, prefix] of [['frontend', '/'], ['admin', '/admin/'], ['frontend/affiliate', '/affiliate/']]) {
    pages.push(...fs.readdirSync(path.join(root, folder)).filter(file => file.endsWith('.html')).map(file => prefix + file.slice(0, -5)));
  }
  const checked = new Set();
  for (const page of pages) {
    const response = await fetch(base + page);
    assert.equal(response.status, 200, page);
    assert.match(response.headers.get('content-type'), /text\/html/);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const html = await response.text();
    assert.match(html, /Brain[y]?Grasp|BrainGrasp/i);
    const resources = [...html.matchAll(/<(?:script|link|img)\b[^>]*(?:src|href)=["']([^"']+)["']/gi)]
      .map(match => new URL(match[1], base + page)).filter(url => url.origin === base);
    for (const url of resources) {
      if (checked.has(url.href)) continue;
      checked.add(url.href);
      const asset = await fetch(url);
      assert.equal(asset.status, 200, `${page}: ${url.pathname}`);
      if (/\.js$/.test(url.pathname)) assert.match(asset.headers.get('content-type'), /javascript/);
      if (/\.css$/.test(url.pathname)) assert.match(asset.headers.get('content-type'), /text\/css/);
      await asset.arrayBuffer();
    }
  }
});

test('portal directory redirects preserve relative assets; backend files and unknown API routes stay private', async t => {
  const base = await site(t);
  for (const page of ['/admin', '/affiliate', '/frontend']) {
    const response = await fetch(base + page, { redirect: 'manual' });
    assert.equal(response.status, 301); assert.equal(response.headers.get('location'), page + '/');
  }
  for (const page of ['/.env', '/backend/.env', '/server.js', '/.git/config', '/frontend/..%2fbackend%2f.env']) {
    const response = await fetch(base + page);
    assert.notEqual(response.status, 200, page);
  }
  const response = await fetch(base + '/api/does-not-exist');
  assert.equal(response.status, 404); assert.deepEqual(await response.json(), { error: 'API route not found' });
});

test('CORS permits domain, www and same-origin POST/preflight without enabling unrelated origins', async t => {
  const base = await site(t);
  for (const origin of ['https://brainygrasp.com', 'https://www.brainygrasp.com', base]) {
    for (const method of ['POST', 'OPTIONS']) {
      const response = await fetch(base + '/api/probe', { method, headers: { Origin: origin,
        'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization,content-type' } });
      assert.equal(response.status, method === 'OPTIONS' ? 204 : 200);
      assert.equal(response.headers.get('access-control-allow-origin'), origin);
      assert.match(response.headers.get('vary'), /Origin/);
      assert.match(response.headers.get('access-control-allow-headers'), /Authorization/);
    }
  }
  for (const origin of ['https://unrelated.example', 'null', 'http://localhost:5500']) {
    const response = await fetch(base + '/api/probe', { method: 'OPTIONS', headers: { Origin: origin } });
    assert.equal(response.status, 403); assert.equal(response.headers.get('access-control-allow-origin'), null);
  }
  assert.equal((await fetch(base + '/api/probe')).status, 200);
});

test('local split-port development remains usable with a production domain in the allowlist', async t => {
  const base = await site(t, { NODE_ENV: 'development', ALLOWED_ORIGINS: 'https://brainygrasp.com' });
  const response = await fetch(base + '/api/probe', { headers: { Origin: 'http://localhost:5501' } });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('access-control-allow-origin'), 'http://localhost:5501');
});

test('HTTPS proxy same-origin works without trusting X-Forwarded-Host as an allowed origin', async t => {
  const base = await site(t);
  const origin = base.replace('http:', 'https:');
  assert.equal((await fetch(base + '/api/probe', { headers: { Origin: origin, 'X-Forwarded-Proto': 'https' } })).status, 200);
  assert.equal((await fetch(base + '/api/probe', { headers: { Origin: 'https://unrelated.example',
    'X-Forwarded-Proto': 'https', 'X-Forwarded-Host': 'unrelated.example' } })).status, 403);
});

test('frontend serving and CORS do not parse or modify raw webhook bytes', async t => {
  const base = await site(t); const body = '{ "event": "fixture", "payload": {} }\n';
  const response = await fetch(base + '/api/webhooks/razorpay', { method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Razorpay-Signature': 'fixture-signature' }, body });
  assert.deepEqual(await response.json(), { hash: crypto.createHash('sha256').update(body).digest('hex'), signature: 'fixture-signature' });
});

test('every portal chooses the current EC2/domain origin while retaining local development and overrides', () => {
  for (const [file, key] of [['frontend/js/config.js', 'BG_CONFIG'], ['admin/js/config.js', 'BG_ADMIN_CONFIG'],
    ['frontend/affiliate/js/config.js', 'AFF_CONFIG']]) {
    const source = fs.readFileSync(path.join(root, file), 'utf8');
    for (const [url, expected] of [
      ['https://brainygrasp.com', 'https://brainygrasp.com'], ['https://www.brainygrasp.com', 'https://www.brainygrasp.com'],
      ['http://16.178.149.138:3000', 'http://16.178.149.138:3000'], ['http://54.1.2.3', 'http://54.1.2.3'],
      ['http://localhost:5500', 'http://localhost:3000'], ['http://localhost:5501', 'http://localhost:3000'],
      ['http://localhost:3000', 'http://localhost:3000'], ['http://localhost', 'http://localhost'],
      ['http://localhost:8080', 'http://localhost:8080'], ['http://127.0.0.1:52612', 'http://127.0.0.1:52612'],
      ['http://192.168.1.2:5500', 'http://192.168.1.2:5500'],
      ['http://10.70.130.121:5500', 'http://10.70.130.121:5500'], ['file:///site/index.html', 'http://localhost:3000'],
    ]) {
      const window = { location: new URL(url) }; vm.runInNewContext(source, { window });
      assert.equal(window[key].API_BASE, expected, `${file}: ${url}`);
    }
    const window = { location: new URL('https://brainygrasp.com'), BG_API_BASE: 'https://api.example.com/' };
    vm.runInNewContext(source, { window }); assert.equal(window[key].API_BASE, 'https://api.example.com');
  }
});

test('deployment configuration fails clearly for missing assets or invalid CORS origins', () => {
  assert.throws(() => mountFrontend(express(), { root: path.join(root, 'missing-deployment-fixture') }), /Frontend files are missing/);
  assert.throws(() => createCorsPolicy({ NODE_ENV: 'production', ALLOWED_ORIGINS: '*' }), /CORS configuration/);
});

test('frontend server proxies API methods, bodies and responses to the local backend', async t => {
  const backend = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({
        method: req.method,
        path: req.url,
        body: Buffer.concat(chunks).toString(),
        authorization: req.headers.authorization || null,
      }));
    });
  });
  backend.listen(0, '127.0.0.1');
  await once(backend, 'listening');

  const reservation = http.createServer();
  reservation.listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const frontendPort = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));

  const frontend = spawn(process.execPath, [path.join(root, 'frontend-server.js')], {
    cwd: root,
    env: { ...process.env, FRONTEND_PORT: String(frontendPort), BACKEND_PORT: String(backend.address().port) },
    stdio: 'ignore',
  });
  const frontendExit = once(frontend, 'exit');
  t.after(async () => {
    if (frontend.exitCode === null) frontend.kill();
    await frontendExit;
    await new Promise(resolve => backend.close(resolve));
  });

  let response;
  for (let attempt = 0; attempt < 40; attempt++) {
    try {
      response = await fetch(`http://127.0.0.1:${frontendPort}/api/products?source=mobile`);
      break;
    } catch {
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }
  assert.ok(response, 'frontend server should accept catalog requests');
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    method: 'GET', path: '/api/products?source=mobile', body: '', authorization: null,
  });

  const body = JSON.stringify({ email: 'test@example.com' });
  const otpResponse = await fetch(`http://127.0.0.1:${frontendPort}/api/auth/request-otp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-token' },
    body,
  });

  for (const legacy of ['/index.html', '/admin/orders.html', '/affiliate/login.html', '/frontend/cart.html']) {
    const base = 'http://127.0.0.1:' + frontendPort;
    const redirect = await fetch(base + legacy + '?ref=PARTNER', { redirect: 'manual' });
    assert.equal(redirect.status, 308);
    assert.equal(redirect.headers.get('location'), legacy.slice(0, -5) + '?ref=PARTNER');
    assert.equal((await fetch(base + redirect.headers.get('location'))).status, 200);
  }
  const directory = await fetch('http://127.0.0.1:' + frontendPort + '/affiliate', { redirect: 'manual' });
  assert.equal(directory.status, 301);
  assert.equal(directory.headers.get('location'), '/affiliate/');
  assert.equal(otpResponse.status, 200);
  assert.deepEqual(await otpResponse.json(), {
    method: 'POST', path: '/api/auth/request-otp', body, authorization: 'Bearer test-token',
  });
});


test('all legacy HTML pages redirect to clean URLs and preserve query parameters', async t => {
  const base = await site(t);
  for (const [folder, prefix] of [['frontend', '/'], ['admin', '/admin/'], ['frontend', '/frontend/']]) {
    for (const file of fs.readdirSync(path.join(root, folder), { recursive: true }).filter(file => file.endsWith('.html'))) {
      const legacy = prefix + file.replaceAll('\\', '/');
      const query = '?ref=PARTNER&search=blocks%20%26%20games&next=cart.html';
      const clean = legacy.slice(0, -5) + query;
      for (const method of ['GET', 'HEAD']) {
        const redirect = await fetch(base + legacy + query, { method, redirect: 'manual' });
        assert.equal(redirect.status, 308, legacy);
        assert.equal(redirect.headers.get('location'), clean);
        const response = await fetch(base + clean, { method, redirect: 'manual' });
        assert.equal(response.status, 200, clean);
        assert.match(response.headers.get('content-type'), /text\/html/);
        assert.equal(response.headers.get('cache-control'), 'no-store');
        await response.arrayBuffer();
      }
    }
  }
  assert.equal((await fetch(base + '/nonexistent-page')).status, 404);
  const api = await fetch(base + '/api/missing.html', { redirect: 'manual' });
  assert.equal(api.status, 404);
  assert.equal(api.headers.get('location'), null);
});
