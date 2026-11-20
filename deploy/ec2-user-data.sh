#!/bin/bash
# Paste this ENTIRE file into EC2 > Launch instance > Advanced details > User data.
# For a NEW Ubuntu 24.04 LTS instance (also accepts Ubuntu 22.04).
# Edit LE_EMAIL before launching. Set INCLUDE_WWW=false if www has no DNS record.
# This installs the host proxy and certificates; deploy/start the app separately.
# DNS must point here, inbound 80/443 and outbound HTTPS must be allowed.
# Running the script authorizes Certbot to accept the Let's Encrypt terms.
set -Eeuo pipefail

DOMAIN="brainygrasp.com"
INCLUDE_WWW=true
LE_EMAIL="CHANGE_ME@example.com"
APP_PORT=3000

[[ $EUID -eq 0 ]] || { echo 'Run as root (EC2 User data already does).'; exit 1; }
exec > >(tee -a /var/log/brainygrasp-bootstrap.log) 2>&1
trap 'echo "Bootstrap failed at line $LINENO. See /var/log/brainygrasp-bootstrap.log."' ERR

source /etc/os-release
if [[ $ID != ubuntu || ! $VERSION_ID =~ ^(22\.04|24\.04)$ ]]; then
    echo 'Use an Ubuntu 24.04 or 22.04 AMI. This script is not for Amazon Linux.'
    exit 1
fi
if [[ ! $DOMAIN =~ ^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$ || ${#DOMAIN} -gt 249 ]]; then
    echo 'Set DOMAIN to a lowercase domain name without https:// or a path.'; exit 1
fi
if [[ $INCLUDE_WWW != true && $INCLUDE_WWW != false ]]; then
    echo 'INCLUDE_WWW must be true or false.'; exit 1
fi
if [[ $LE_EMAIL == CHANGE_ME@example.com || ! $LE_EMAIL =~ ^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$ ]]; then
    echo 'Replace LE_EMAIL with your real email address before launching.'; exit 1
fi
if [[ ! $APP_PORT =~ ^[1-9][0-9]{0,4}$ ]] || (( APP_PORT > 65535 )); then
    echo 'APP_PORT must be between 1 and 65535.'; exit 1
fi

export DEBIAN_FRONTEND=noninteractive
apt-get -o DPkg::Lock::Timeout=180 -o Acquire::Retries=3 update
apt-get -o DPkg::Lock::Timeout=180 -o Acquire::Retries=3 install -y \
    nginx certbot python3-certbot-nginx curl ca-certificates

SITE=/etc/nginx/sites-available/brainygrasp
ENABLED=/etc/nginx/sites-enabled/brainygrasp
MARKER="# BrainyGrasp bootstrap: domain=$DOMAIN www=$INCLUDE_WWW port=$APP_PORT"
NAMES="$DOMAIN"
if [[ $INCLUDE_WWW == true ]]; then NAMES+=" www.$DOMAIN"; fi

# Preserve certificates and redirect rules installed by Certbot on later runs.
if [[ -e $SITE ]]; then
    if ! grep -Fxq "$MARKER" "$SITE"; then
        echo "An existing or differently configured site is at $SITE. Review it manually; it was not overwritten."
        exit 1
    fi
else
    cat > "$SITE" <<NGINX
$MARKER
server {
    listen 80;
    listen [::]:80;
    server_name $NAMES;
    server_tokens off;
    access_log /var/log/nginx/brainygrasp.access.log;
    error_log /var/log/nginx/brainygrasp.error.log warn;
    client_max_body_size 256k;
    client_body_timeout 30s;

    # Serves the readiness probe without requiring the Node app to be running.
    location ^~ /.well-known/acme-challenge/ {
        root /var/www/brainygrasp-acme;
        default_type text/plain;
        try_files \$uri =404;
    }

    location / {
        proxy_pass http://127.0.0.1:$APP_PORT;
        proxy_http_version 1.1;
        proxy_set_header Connection "";
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        # Nginx is the only proxy hop; overwrite untrusted forwarded headers.
        proxy_set_header X-Forwarded-For \$remote_addr;
        proxy_set_header X-Forwarded-Host \$host;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_set_header X-Forwarded-Port \$server_port;
        proxy_connect_timeout 5s;
        proxy_send_timeout 60s;
        proxy_read_timeout 60s;
        proxy_cache off;
        proxy_intercept_errors off;
        proxy_next_upstream off;
    }
}
NGINX
fi
if [[ -e $ENABLED || -L $ENABLED ]]; then
    [[ $(readlink -f "$ENABLED") == "$SITE" ]] || { echo "Review existing $ENABLED; it was not replaced."; exit 1; }
else
    ln -s "$SITE" "$ENABLED"
fi

install -d -m 0755 /var/lib/brainygrasp-tls /var/www/brainygrasp-acme/.well-known/acme-challenge
PROBE=/var/www/brainygrasp-acme/.well-known/acme-challenge/brainygrasp-readiness
if [[ ! -s $PROBE ]]; then cat /proc/sys/kernel/random/uuid > "$PROBE"; fi
chmod 0644 "$PROBE"
printf 'DOMAIN=%q\nINCLUDE_WWW=%q\nLE_EMAIL=%q\n' "$DOMAIN" "$INCLUDE_WWW" "$LE_EMAIL" > /etc/brainygrasp-proxy.env
chmod 0600 /etc/brainygrasp-proxy.env

nginx -t
systemctl enable --now nginx
systemctl reload nginx

cat > /usr/local/sbin/brainygrasp-issue-certificate <<'ISSUER'
#!/bin/bash
set -Eeuo pipefail
source /etc/brainygrasp-proxy.env
STATE=/var/lib/brainygrasp-tls
PROBE=/var/www/brainygrasp-acme/.well-known/acme-challenge/brainygrasp-readiness

# A systemd oneshot service cannot overlap itself. Certbot also owns its locks.
if [[ -f $STATE/configured ]]; then exit 0; fi
domains=("$DOMAIN")
if [[ $INCLUDE_WWW == true ]]; then domains+=("www.$DOMAIN"); fi
expected=$(cat "$PROBE")
for domain in "${domains[@]}"; do
    if ! actual=$(curl --noproxy '*' --location --max-redirs 3 --fail --silent --show-error --connect-timeout 5 --max-time 15 \
        "http://$domain/.well-known/acme-challenge/brainygrasp-readiness") || [[ $actual != "$expected" ]]; then
        echo "Waiting for $domain to reach this Nginx server over HTTP. Will check again in 15 minutes."
        exit 0
    fi
done

# DNS seen here can differ from ACME resolvers. Limit failed production ACME
# attempts to once per six hours; readiness checks themselves do not contact ACME.
now=$(date +%s)
if [[ -f $STATE/last-attempt ]]; then
    last=$(cat "$STATE/last-attempt")
    if [[ $last =~ ^[0-9]+$ ]] && (( now - last < 21600 )); then
        echo 'Certificate retry is cooling down after a previous attempt.'
        exit 0
    fi
fi
printf '%s\n' "$now" > "$STATE/last-attempt"
args=()
for domain in "${domains[@]}"; do args+=(-d "$domain"); done
if ! certbot --nginx --non-interactive --agree-tos --email "$LE_EMAIL" \
    --cert-name "$DOMAIN" --redirect "${args[@]}"; then
    echo 'Certificate setup failed; inspect /var/log/letsencrypt/letsencrypt.log. Retrying after six hours.'
    exit 1
fi
nginx -t
systemctl reload nginx
touch "$STATE/configured"
systemctl disable --now brainygrasp-tls.timer
echo 'HTTPS configured. certbot.timer now handles certificate renewal.'
ISSUER
chmod 0755 /usr/local/sbin/brainygrasp-issue-certificate

cat > /etc/systemd/system/brainygrasp-tls.service <<'SERVICE'
[Unit]
Description=Configure BrainyGrasp HTTPS when DNS is ready
Wants=network-online.target
After=network-online.target nginx.service

[Service]
Type=oneshot
ExecStart=/usr/local/sbin/brainygrasp-issue-certificate
TimeoutStartSec=5min
SERVICE

cat > /etc/systemd/system/brainygrasp-tls.timer <<'TIMER'
[Unit]
Description=Retry initial BrainyGrasp certificate setup

[Timer]
OnBootSec=2min
OnUnitInactiveSec=15min
RandomizedDelaySec=30s
Unit=brainygrasp-tls.service

[Install]
WantedBy=timers.target
TIMER

install -d -m 0755 /etc/letsencrypt/renewal-hooks/deploy
cat > /etc/letsencrypt/renewal-hooks/deploy/brainygrasp-nginx-reload <<'RENEW'
#!/bin/sh
set -eu
nginx -t
systemctl reload nginx
RENEW
chmod 0755 /etc/letsencrypt/renewal-hooks/deploy/brainygrasp-nginx-reload

systemctl daemon-reload
systemctl enable --now certbot.timer
if [[ ! -f /var/lib/brainygrasp-tls/configured ]]; then
    systemctl enable --now brainygrasp-tls.timer
    systemctl start --no-block brainygrasp-tls.service
fi
echo "Nginx is ready for $NAMES. Deploy the application on port $APP_PORT separately."
echo 'Certificate progress: journalctl -u brainygrasp-tls.service'
