#!/usr/bin/env bash
#
# bootstrap.sh — provision a fresh Ubuntu VPS for the scholarship platform.
#
# Run ONCE on a clean box. It installs Node, MongoDB, nginx and Certbot, sets up
# the firewall, creates the app user, clones your repo, builds, and starts the
# service. After this, use ops/deploy.sh for every update.
#
# Usage:
#   # 1. Edit the CONFIG block below (repo URL, domain).
#   # 2. Copy this script to the VPS and run it:
#   scp ops/bootstrap.sh you@your-vps:/tmp/
#   ssh you@your-vps
#   sudo bash /tmp/bootstrap.sh
#
# It is idempotent-ish: re-running skips things already installed, but review the
# output rather than running it blindly a second time.
#
set -euo pipefail

# ─────────────────────────────────────────────────────────────────────────────
# CONFIG — edit these three, then run.
# ─────────────────────────────────────────────────────────────────────────────
REPO_URL="${REPO_URL:-https://github.com/YOUR-ORG/YOUR-REPO.git}"
DOMAIN="${DOMAIN:-soma.wisdombusara.com}"
BRANCH="${BRANCH:-main}"

# Paths (change only if you have a reason)
APP_DIR="/srv/wraith"
WEB_ROOT="/var/www/scholarships"
APP_USER="wraith"
NODE_MAJOR="20"
MONGO_VERSION="7.0"

# ─────────────────────────────────────────────────────────────────────────────
log()  { printf '\n\033[1;36m▸ %s\033[0m\n' "$*"; }
ok()   { printf '\033[1;32m  ✓ %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m  ! %s\033[0m\n' "$*"; }
die()  { printf '\033[1;31m  ✗ %s\033[0m\n' "$*" >&2; exit 1; }

[[ $EUID -eq 0 ]] || die "Run with sudo: sudo bash bootstrap.sh"
[[ "$REPO_URL" == *"YOUR-ORG"* ]] && die "Edit the CONFIG block first — set REPO_URL to your repo."

UBUNTU_CODENAME="$(. /etc/os-release && echo "$VERSION_CODENAME")"
log "Provisioning for $DOMAIN on Ubuntu $UBUNTU_CODENAME"

# ─────────────────────────────────────────────────────────────────────────────
# 1. System packages
# ─────────────────────────────────────────────────────────────────────────────
log "Updating base system"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get upgrade -y -qq
apt-get install -y -qq curl gnupg ca-certificates git ufw build-essential >/dev/null
ok "base packages installed"

# ─────────────────────────────────────────────────────────────────────────────
# 2. Swap (only if there's little RAM — protects the frontend build from OOM)
# ─────────────────────────────────────────────────────────────────────────────
TOTAL_RAM_MB=$(free -m | awk '/^Mem:/{print $2}')
if [[ "$TOTAL_RAM_MB" -lt 3000 ]] && ! swapon --show | grep -q '/swapfile'; then
  log "Only ${TOTAL_RAM_MB}MB RAM — adding a 2G swapfile so builds don't get OOM-killed"
  fallocate -l 2G /swapfile || dd if=/dev/zero of=/swapfile bs=1M count=2048
  chmod 600 /swapfile
  mkswap /swapfile >/dev/null
  swapon /swapfile
  grep -q '/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
  ok "2G swap active"
else
  ok "swap not needed (${TOTAL_RAM_MB}MB RAM)"
fi

# ─────────────────────────────────────────────────────────────────────────────
# 3. Node.js
# ─────────────────────────────────────────────────────────────────────────────
if ! command -v node >/dev/null || [[ "$(node -v | cut -d. -f1 | tr -d v)" -lt "$NODE_MAJOR" ]]; then
  log "Installing Node.js ${NODE_MAJOR} LTS"
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
fi
ok "node $(node -v), npm $(npm -v)"

# ─────────────────────────────────────────────────────────────────────────────
# 4. MongoDB — bound to localhost, no public exposure
# ─────────────────────────────────────────────────────────────────────────────
if ! command -v mongod >/dev/null; then
  log "Installing MongoDB ${MONGO_VERSION}"
  curl -fsSL "https://www.mongodb.org/static/pgp/server-${MONGO_VERSION}.asc" \
    | gpg -o "/usr/share/keyrings/mongodb-server-${MONGO_VERSION}.gpg" --dearmor
  echo "deb [signed-by=/usr/share/keyrings/mongodb-server-${MONGO_VERSION}.gpg] https://repo.mongodb.org/apt/ubuntu ${UBUNTU_CODENAME}/mongodb-org/${MONGO_VERSION} multiverse" \
    > "/etc/apt/sources.list.d/mongodb-org-${MONGO_VERSION}.list"
  apt-get update -qq
  apt-get install -y -qq mongodb-org >/dev/null
fi

# Confirm it only listens on localhost — this is the security-critical setting.
# The default already binds 127.0.0.1, but we assert it rather than assume.
if ! grep -qE '^\s*bindIp:\s*127\.0\.0\.1\s*$' /etc/mongod.conf; then
  sed -i 's/^\(\s*bindIp:\).*/\1 127.0.0.1/' /etc/mongod.conf
  warn "forced MongoDB to bind 127.0.0.1 only"
fi

systemctl enable --now mongod >/dev/null
sleep 2
systemctl is-active --quiet mongod && ok "MongoDB running on 127.0.0.1:27017" || die "MongoDB failed to start — check: journalctl -u mongod"

# ─────────────────────────────────────────────────────────────────────────────
# 5. nginx + Certbot
# ─────────────────────────────────────────────────────────────────────────────
if ! command -v nginx >/dev/null; then
  log "Installing nginx"
  apt-get install -y -qq nginx >/dev/null
fi
if ! command -v certbot >/dev/null; then
  apt-get install -y -qq certbot python3-certbot-nginx >/dev/null
fi
systemctl enable --now nginx >/dev/null
ok "nginx $(nginx -v 2>&1 | grep -oE '[0-9.]+' | head -1) running"

# ─────────────────────────────────────────────────────────────────────────────
# 6. Firewall — SSH + web only. 8080 and 27017 stay closed to the world.
# ─────────────────────────────────────────────────────────────────────────────
log "Configuring firewall"
ufw allow OpenSSH >/dev/null
ufw allow 'Nginx Full' >/dev/null
ufw --force enable >/dev/null
ok "ufw: SSH + HTTP/HTTPS open; app port and DB port not exposed"

# ─────────────────────────────────────────────────────────────────────────────
# 7. App user and directories
# ─────────────────────────────────────────────────────────────────────────────
if ! id "$APP_USER" >/dev/null 2>&1; then
  useradd --system --create-home --shell /usr/sbin/nologin "$APP_USER"
  ok "created system user '$APP_USER'"
fi
mkdir -p "$APP_DIR" "$WEB_ROOT/releases"
chown -R "$APP_USER:$APP_USER" "$APP_DIR"
chown -R www-data:www-data "$WEB_ROOT"

# ─────────────────────────────────────────────────────────────────────────────
# 8. Clone and build
# ─────────────────────────────────────────────────────────────────────────────
if [[ ! -d "$APP_DIR/.git" ]]; then
  log "Cloning $REPO_URL"
  sudo -u "$APP_USER" git clone --branch "$BRANCH" "$REPO_URL" "$APP_DIR"
else
  log "Repo already present — pulling latest"
  sudo -u "$APP_USER" git -C "$APP_DIR" fetch --quiet origin "$BRANCH"
  sudo -u "$APP_USER" git -C "$APP_DIR" reset --hard --quiet "origin/$BRANCH"
fi
ok "code at $(sudo -u "$APP_USER" git -C "$APP_DIR" rev-parse --short HEAD)"

log "Building backend"
cd "$APP_DIR/backend"
sudo -u "$APP_USER" npm ci --no-audit --no-fund
sudo -u "$APP_USER" npm run build
ok "backend built"

log "Building frontend"
cd "$APP_DIR/frontend"
sudo -u "$APP_USER" npm ci --no-audit --no-fund
sudo -u "$APP_USER" npm run build
RELEASE="$WEB_ROOT/releases/$(date +%Y%m%d%H%M%S)-initial"
mkdir -p "$RELEASE"
cp -r dist/. "$RELEASE/"
ln -sfn "$RELEASE" "$WEB_ROOT/current"
cat > "$RELEASE/robots.txt" <<ROBOTS
User-agent: *
Allow: /
Disallow: /admin
Disallow: /login
Sitemap: https://${DOMAIN}/sitemap.xml
ROBOTS
chown -R www-data:www-data "$WEB_ROOT"
ok "frontend built and released"

# ─────────────────────────────────────────────────────────────────────────────
# 9. Generate .env with real secrets (only if it doesn't exist yet)
# ─────────────────────────────────────────────────────────────────────────────
ENV_FILE="$APP_DIR/backend/.env"
if [[ ! -f "$ENV_FILE" ]]; then
  log "Generating starter .env with fresh secrets"
  JWT_A=$(openssl rand -hex 32)
  JWT_R=$(openssl rand -hex 32)
  ENC=$(openssl rand -base64 32)
  cat > "$ENV_FILE" <<ENVEOF
NODE_ENV=production
PORT=8080

# Local MongoDB installed by this script — bound to localhost, no password needed.
MONGO_URI=mongodb://127.0.0.1:27017/wraith

CORS_ORIGIN=https://${DOMAIN}
COOKIE_SECURE=true
COOKIE_SAMESITE=LAX

JWT_ACCESS_SECRET=${JWT_A}
JWT_REFRESH_SECRET=${JWT_R}
JWT_ISSUER=wraith-backend
ENCRYPTION_KEY_BASE64=${ENC}

# ⚠️  FILL THESE IN — the script cannot generate them for you.
INITIAL_ADMIN_EMAIL=CHANGE_ME@example.com
INITIAL_ADMIN_PASSWORD=CHANGE_ME_min_12_chars
PAYSTACK_SECRET_KEY=sk_live_ROTATE_AND_PASTE_HERE
PAYSTACK_CALLBACK_BASE_URL=https://${DOMAIN}

# Scholarship site
SCHOLARSHIP_SITE_URL=https://${DOMAIN}
SCHOLARSHIP_FREE_VIEWS_PER_MONTH=5
ADS_ENABLED=true

# Crawler stays OFF until you've verified the site works.
SCHOLARSHIP_CRAWLER_ENABLED=false
ENVEOF
  chown "$APP_USER:$APP_USER" "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  ok ".env created with generated secrets"
  ENV_WAS_GENERATED=1
else
  ok ".env already exists — left untouched"
  ENV_WAS_GENERATED=0
fi

# ─────────────────────────────────────────────────────────────────────────────
# 10. systemd service
# ─────────────────────────────────────────────────────────────────────────────
log "Installing systemd service"
cp "$APP_DIR/ops/wraith-api.service" /etc/systemd/system/
systemctl daemon-reload
systemctl enable wraith-api >/dev/null
ok "wraith-api service installed"

# ─────────────────────────────────────────────────────────────────────────────
# 11. nginx site
# ─────────────────────────────────────────────────────────────────────────────
log "Configuring nginx site for $DOMAIN"
sed "s/scholarships\.neithlogic\.com/${DOMAIN}/g" \
  "$APP_DIR/ops/nginx/scholarships.conf" > /etc/nginx/sites-available/scholarships

# If the box has no IPv6, an `[::]:80` listen directive makes nginx -t fail with
# "Address family not supported". Detect it and comment those lines out.
if [[ ! -f /proc/net/if_inet6 ]] || [[ ! -s /proc/net/if_inet6 ]]; then
  sed -i 's|^\(\s*\)listen \[::\]|\1# listen [::]|' /etc/nginx/sites-available/scholarships
  warn "no IPv6 on this host — commented out IPv6 listen directives"
fi

ln -sfn /etc/nginx/sites-available/scholarships /etc/nginx/sites-enabled/scholarships
rm -f /etc/nginx/sites-enabled/default

# The shipped config is HTTP-only on purpose, so nginx starts before any cert
# exists. Certbot adds the HTTPS server block in step 3 of the next-steps list.
if nginx -t >/dev/null 2>&1; then
  systemctl reload nginx
  ok "nginx configured (HTTP only for now — Certbot adds HTTPS next)"
else
  warn "nginx config test failed — review /etc/nginx/sites-available/scholarships"
  nginx -t || true
fi

# ─────────────────────────────────────────────────────────────────────────────
# 12. Nightly MongoDB backup
# ─────────────────────────────────────────────────────────────────────────────
log "Installing nightly database backup"
mkdir -p /var/backups/mongo
cat > /etc/cron.daily/mongo-backup <<'CRON'
#!/usr/bin/env bash
set -e
STAMP=$(date +%F)
OUT="/var/backups/mongo/wraith-$STAMP"
mongodump --db wraith --out "$OUT" --quiet
# Keep the last 7 days only
find /var/backups/mongo -maxdepth 1 -type d -name 'wraith-*' -mtime +7 -exec rm -rf {} +
CRON
chmod +x /etc/cron.daily/mongo-backup
ok "nightly mongodump installed (keeps 7 days in /var/backups/mongo)"

# ─────────────────────────────────────────────────────────────────────────────
# 13. Start the API
# ─────────────────────────────────────────────────────────────────────────────
if [[ "${ENV_WAS_GENERATED}" == "1" ]]; then
  warn "NOT starting the API yet — you must fill in .env first (see below)."
else
  log "Starting the API"
  systemctl restart wraith-api
  sleep 3
  if curl -fsS --max-time 3 http://127.0.0.1:8080/health >/dev/null 2>&1; then
    ok "API healthy on 127.0.0.1:8080"
  else
    warn "API did not respond — check: journalctl -u wraith-api -n 40"
  fi
fi

# ─────────────────────────────────────────────────────────────────────────────
# Done — next steps
# ─────────────────────────────────────────────────────────────────────────────
cat <<DONE

╔═══════════════════════════════════════════════════════════════════════╗
  Bootstrap complete.
╚═══════════════════════════════════════════════════════════════════════╝

Installed: Node $(node -v) · MongoDB ${MONGO_VERSION} (localhost) · nginx · Certbot
Firewall:  SSH + HTTP/HTTPS open. Port 8080 and 27017 are NOT public.
Backups:   Nightly mongodump → /var/backups/mongo (7-day retention)

NEXT STEPS — in order:

  1. Fill in the real values in your .env:
       sudo nano ${ENV_FILE}
     Set: INITIAL_ADMIN_EMAIL, INITIAL_ADMIN_PASSWORD (12+ chars),
          PAYSTACK_SECRET_KEY (rotate it first!)

  2. Start / restart the API:
       sudo systemctl restart wraith-api
       curl http://127.0.0.1:8080/health        # expect JSON

  3. Issue the TLS certificate (DNS must resolve, Cloudflare grey cloud):
       sudo certbot --nginx -d ${DOMAIN}

  4. In Cloudflare: flip the record to orange cloud, SSL mode = Full (strict).

  5. Point the Paystack webhook at:
       https://${DOMAIN}/webhooks/paystack

  6. Verify:
       curl -I https://${DOMAIN}/
       curl -I https://${DOMAIN}/scholarships/anything   # 200, not 404

  7. Seed and crawl, then turn the crawler on:
       cd ${APP_DIR}/backend
       sudo -u ${APP_USER} npm run scholarships:seed -- --countries=KE,GB
       sudo -u ${APP_USER} npm run scholarships:crawl -- --limit=20 --dry-run
       # when happy: set SCHOLARSHIP_CRAWLER_ENABLED=true, then restart

  From now on, deploy updates with:  sudo ${APP_DIR}/ops/deploy.sh

DONE
