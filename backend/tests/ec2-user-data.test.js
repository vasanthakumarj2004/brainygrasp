'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const bash = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : '/bin/bash';
const options = { skip: !fs.existsSync(bash) && 'Bash is needed to validate the Linux User data script' };
const file = path.resolve(__dirname, '../../deploy/ec2-user-data.sh');
const source = fs.readFileSync(file, 'utf8');
const heredoc = tag => source.split(`<<'${tag}'\n`)[1].split(`\n${tag}\n`)[0];

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'brainygrasp-userdata-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'state'));
  fs.writeFileSync(path.join(root, 'config'), 'DOMAIN=brainygrasp.com\nINCLUDE_WWW=true\nLE_EMAIL=ops@example.invalid\n');
  fs.writeFileSync(path.join(root, 'probe'), 'this-instance\n');
  // Execute only the issuer, with all paths redirected to a disposable folder.
  const issuer = heredoc('ISSUER')
    .replace('source /etc/brainygrasp-proxy.env', 'source "$TEST_ROOT/config"')
    .replace('STATE=/var/lib/brainygrasp-tls', 'STATE="$TEST_ROOT/state"')
    .replace('PROBE=/var/www/brainygrasp-acme/.well-known/acme-challenge/brainygrasp-readiness', 'PROBE="$TEST_ROOT/probe"');
  fs.writeFileSync(path.join(root, 'issuer'), issuer);
  const wrapper = `
curl() {
  printf 'curl %s\\n' "$*" >> "$TEST_ROOT/calls"
  [[ $PROBE_RESULT != fail ]] || return 7
  if [[ $PROBE_RESULT == mismatch && $* == *www.* ]]; then printf other-server; else printf this-instance; fi
}
certbot() { printf 'certbot %s\\n' "$*" >> "$TEST_ROOT/calls"; [[ $ACME_RESULT == success ]]; }
nginx() { printf 'nginx %s\\n' "$*" >> "$TEST_ROOT/calls"; }
systemctl() { printf 'systemctl %s\\n' "$*" >> "$TEST_ROOT/calls"; }
source "$TEST_ROOT/issuer"
`;
  return {
    root,
    run: (env = {}) => spawnSync(bash, ['-c', wrapper], {
      encoding: 'utf8', timeout: 10000,
      env: { ...process.env, TEST_ROOT: root.replace(/\\/g, '/'), PROBE_RESULT: 'match', ACME_RESULT: 'success', ...env }
    }),
    calls: () => fs.existsSync(path.join(root, 'calls')) ? fs.readFileSync(path.join(root, 'calls'), 'utf8') : '',
  };
}

test('EC2 bootstrap and embedded scripts have valid shell syntax and Unix line endings', options, () => {
  assert.equal(source.includes('\r'), false);
  assert.ok(Buffer.byteLength(source) < 16 * 1024, 'EC2 raw User data limit');
  for (const script of [source, heredoc('ISSUER'), heredoc('RENEW')]) {
    const result = spawnSync(bash, ['-n'], { input: script, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  }
});

test('Nginx template expands app settings while preserving Nginx variables', options, () => {
  const template = source.split('<<NGINX\n')[1].split('\nNGINX\n')[0];
  const result = spawnSync(bash, ['-c', `cat <<NGINX\n${template}\nNGINX`], {
    encoding: 'utf8', env: { ...process.env, MARKER: '# fixture', NAMES: 'shop.example.com www.shop.example.com', APP_PORT: '3000' }
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /server_name shop.example.com www.shop.example.com;/);
  assert.match(result.stdout, /proxy_pass http:\/\/127\.0\.0\.1:3000;/);
  assert.match(result.stdout, /proxy_set_header Host \$host;/);
  assert.match(result.stdout, /proxy_set_header X-Forwarded-Proto \$scheme;/);
  assert.match(result.stdout, /try_files \$uri =404;/);
});

test('DNS/HTTP failure or a domain reaching another server never requests a certificate', options, t => {
  const f = fixture(t);
  for (const PROBE_RESULT of ['fail', 'mismatch']) {
    const result = f.run({ PROBE_RESULT });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Waiting for/);
  }
  assert.doesNotMatch(f.calls(), /certbot/);
});

test('successful issuance configures both domains and stops initial retries', options, t => {
  const f = fixture(t), result = f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.match(f.calls(), /certbot .*--nginx .*--redirect -d brainygrasp.com -d www.brainygrasp.com/);
  assert.match(f.calls(), /nginx -t/);
  assert.match(f.calls(), /systemctl reload nginx/);
  assert.match(f.calls(), /systemctl disable --now brainygrasp-tls.timer/);
  assert.equal(fs.existsSync(path.join(f.root, 'state/configured')), true);
  const calls = f.calls();
  assert.equal(f.run().status, 0);
  assert.equal(f.calls(), calls, 'Configured instance must not request another certificate');
});

test('failed certificate attempt cools down for six hours, then retries', options, t => {
  const f = fixture(t);
  assert.equal(f.run({ ACME_RESULT: 'failure' }).status, 1);
  assert.equal(fs.existsSync(path.join(f.root, 'state/configured')), false);
  const waiting = f.run();
  assert.equal(waiting.status, 0); assert.match(waiting.stdout, /cooling down/);
  assert.equal(f.calls().split('\n').filter(line => line.startsWith('certbot ')).length, 1);
  fs.writeFileSync(path.join(f.root, 'state/last-attempt'), String(Math.floor(Date.now() / 1000) - 21601));
  assert.equal(f.run().status, 0);
  assert.equal(f.calls().split('\n').filter(line => line.startsWith('certbot ')).length, 2);
});

test('www is optional when only the apex domain is configured', options, t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.root, 'config'), 'DOMAIN=brainygrasp.com\nINCLUDE_WWW=false\nLE_EMAIL=ops@example.invalid\n');
  assert.equal(f.run().status, 0);
  assert.doesNotMatch(f.calls(), /www\./);
});
