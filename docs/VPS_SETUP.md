# VPS & Nginx Setup Guide

Getting the scholarship site live on your own VPS, from a bare Ubuntu box to a
working HTTPS site with auto-deploy.

Assumes Ubuntu 22.04/24.04 and a domain you control. Replace
`scholarships.neithlogic.com` with your actual hostname throughout.

---

## What you're building

```
                    ┌─────────────────────────────────────┐
   Browser  ──443──▶│  nginx                              │
                    │                                     │
                    │  /              → static SPA files  │
                    │  /api/*         → 127.0.0.1:8080    │
                    │  /admin/*       → 127.0.0.1:8080    │
                    │  /auth/*        → 127.0.0.1:8080    │
                    │  /webhooks/*    → 127.0.0.1:8080    │
                    └─────────────────────────────────────┘
                                      │
                                      ▼
                        ┌──────────────────────────┐
                        │  Node (systemd)  :8080   │──▶ MongoDB
                        │  wraith-api              │──▶ Paystack
                        └──────────────────────────┘
```

**The Node process never listens on a public port.** It binds `127.0.0.1:8080`
and nginx is the only thing exposed. This matters: it means your API cannot be
reached except through nginx's rate limits, TLS and headers, even if a firewall
rule is later misconfigured.

---

## Step 1 — DNS

Point an A record at your VPS before anything else. Certbot verifies domain
ownership over HTTP, so this must resolve first or TLS issuance fails.

| Type | Name | Value |
|---|---|---|
| A | `scholarships` | your VPS IPv4 |
| AAAA | `scholarships` | your VPS IPv6 (if you have one) |

Verify it has propagated:

```bash
dig +short scholarships.neithlogic.com
# should print your VPS IP
```

Don't continue until this returns the right address.

---

## Step 2 — Base packages

```bash
sudo apt update && sudo apt upgrade -y
sudo apt install -y nginx git curl ufw

# Node 20 LTS
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

node -v   # expect v20.x
nginx -v
```

---

## Step 3 — Firewall

```bash
sudo ufw allow OpenSSH
sudo ufw allow 'Nginx Full'     # opens 80 and 443
sudo ufw enable
sudo ufw status
```

**Do not open 8080.** If you can reach `http://your-vps-ip:8080` from outside,
something is wrong — the app should only be reachable through nginx.

---

## Step 4 — Application user and directories

Running the app as a dedicated non-login user limits what a compromise can
reach.

```bash
sudo useradd --system --create-home --shell /usr/sbin/nologin wraith

sudo mkdir -p /srv/wraith
sudo mkdir -p /var/www/scholarships/releases

sudo chown -R wraith:wraith /srv/wraith
sudo chown -R www-data:www-data /var/www/scholarships
```

---

## Step 5 — Deploy the code

```bash
sudo -u wraith git clone https://github.com/YOUR-ORG/YOUR-REPO.git /srv/wraith
# or: unzip the bundle into /srv/wraith and chown -R wraith:wraith /srv/wraith

cd /srv/wraith/backend
sudo -u wraith cp .env.example .env
sudo -u wraith nano .env
```

Fill in at minimum:

```bash
NODE_ENV=production
PORT=8080
MONGO_URI=mongodb+srv://...

# Must include the site host, or the browser blocks admin API calls
CORS_ORIGIN=https://scholarships.neithlogic.com

COOKIE_SECURE=true
COOKIE_SAMESITE=LAX

JWT_ACCESS_SECRET=<64 random chars>
JWT_REFRESH_SECRET=<64 random chars>
ENCRYPTION_KEY_BASE64=<base64 of 32 random bytes>

INITIAL_ADMIN_EMAIL=you@example.com
INITIAL_ADMIN_PASSWORD=<strong password>

PAYSTACK_SECRET_KEY=sk_live_...
PAYSTACK_CALLBACK_BASE_URL=https://scholarships.neithlogic.com

# Scholarship site
SCHOLARSHIP_SITE_URL=https://scholarships.neithlogic.com
SCHOLARSHIP_FREE_VIEWS_PER_MONTH=5
ADS_ENABLED=true

# Leave the crawler off until the site is up and verified
SCHOLARSHIP_CRAWLER_ENABLED=false
```

Generate secrets properly — don't invent them by hand:

```bash
openssl rand -hex 32                 # for each JWT secret
openssl rand -base64 32              # for ENCRYPTION_KEY_BASE64
```

Lock the file down; it holds your live Paystack key:

```bash
sudo chmod 600 /srv/wraith/backend/.env
sudo chown wraith:wraith /srv/wraith/backend/.env
```

Build:

```bash
cd /srv/wraith/backend
sudo -u wraith npm ci
sudo -u wraith npm run build

cd /srv/wraith/frontend
sudo -u wraith npm ci
sudo -u wraith npm run build

sudo cp -r dist/. /var/www/scholarships/releases/initial/
sudo ln -sfn /var/www/scholarships/releases/initial /var/www/scholarships/current
sudo chown -R www-data:www-data /var/www/scholarships
```

---

## Step 6 — systemd service

```bash
sudo cp /srv/wraith/ops/wraith-api.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now wraith-api

systemctl status wraith-api
curl -s http://127.0.0.1:8080/health
```

You should get a JSON health response. If not, read the logs before going
further — nginx cannot fix a backend that isn't running:

```bash
sudo journalctl -u wraith-api -n 50 --no-pager
```

---

## Step 7 — Nginx

```bash
sudo cp /srv/wraith/ops/nginx/scholarships.conf /etc/nginx/sites-available/scholarships
sudo nano /etc/nginx/sites-available/scholarships   # set your server_name
sudo ln -s /etc/nginx/sites-available/scholarships /etc/nginx/sites-enabled/

# Remove the default site or it will answer for unmatched hostnames
sudo rm -f /etc/nginx/sites-enabled/default

sudo nginx -t
sudo systemctl reload nginx
```

`nginx -t` must pass before you reload. A reload with a broken config is
rejected and leaves the old config running, but a *restart* would take the site
down — so always `-t` then `reload`, never `restart`.

### TLS

```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d scholarships.neithlogic.com
```

Certbot edits your server block in place to add the certificate paths and the
HTTP→HTTPS redirect. Renewal is installed automatically; confirm it works:

```bash
sudo certbot renew --dry-run
```

---

## Step 8 — Verify

```bash
curl -I https://scholarships.neithlogic.com/
# 200, and Cache-Control: no-cache  (index.html must never be cached)

curl -s https://scholarships.neithlogic.com/api/scholarships | head -c 200
# JSON

curl -I https://scholarships.neithlogic.com/scholarships/anything
# 200 — the SPA fallback is working

curl -I https://scholarships.neithlogic.com/assets/index-XXXX.js
# Cache-Control: public, immutable
```

That third check is the one people miss. Without `try_files … /index.html`,
anyone landing directly on a scholarship URL — from a Google result or a shared
WhatsApp link — gets a 404 instead of the page.

---

## Step 9 — Paystack webhook

In the Paystack dashboard, set the webhook URL to:

```
https://scholarships.neithlogic.com/webhooks/paystack
```

The nginx config sets `proxy_request_buffering off` for `/webhooks/`. That is
deliberate and required: the webhook handler verifies an HMAC signature over the
**exact raw body**. Any buffering or rewriting breaks signature verification and
every payment silently fails to grant access.

Test it with Paystack's "Send test webhook", then check:

```bash
sudo journalctl -u wraith-api -n 30 --no-pager | grep -i paystack
```

---

## Step 10 — Turn the crawler on

Only after the site is confirmed working:

```bash
cd /srv/wraith/backend
sudo -u wraith npm run scholarships:seed -- --countries=KE,GB
sudo -u wraith npm run scholarships:discover-universities -- --countries=KE,GB
sudo -u wraith npm run scholarships:discover -- --limit=3 --dry-run   # inspect
sudo -u wraith npm run scholarships:crawl -- --limit=20 --dry-run     # inspect
sudo -u wraith npm run scholarships:crawl -- --limit=20
sudo -u wraith npm run scholarships:status
```

When you're satisfied with what it's finding, enable the schedule:

```bash
sudo -u wraith sed -i 's/SCHOLARSHIP_CRAWLER_ENABLED=false/SCHOLARSHIP_CRAWLER_ENABLED=true/' /srv/wraith/backend/.env
sudo systemctl restart wraith-api
```

---

## Step 11 — Auto-deploy

```bash
sudo useradd --create-home --shell /bin/bash deploy
sudo usermod -aG wraith deploy

# Grant exactly one command, nothing more
echo 'deploy ALL=(root) NOPASSWD: /srv/wraith/ops/deploy.sh' | \
  sudo tee /etc/sudoers.d/deploy
sudo chmod 440 /etc/sudoers.d/deploy
sudo chmod +x /srv/wraith/ops/deploy.sh
```

Add the deploy user's public key to `/home/deploy/.ssh/authorized_keys`, then in
GitHub → Settings → Secrets add `VPS_HOST` and `VPS_SSH_KEY`, and create
`.github/workflows/deploy.yml`:

```yaml
name: Deploy
on:
  push:
    branches: [main]
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: appleboy/ssh-action@v1
        with:
          host: ${{ secrets.VPS_HOST }}
          username: deploy
          key: ${{ secrets.VPS_SSH_KEY }}
          script: sudo /srv/wraith/ops/deploy.sh
```

`deploy.sh` runs the test suite **before** releasing anything and rolls the
source back if it fails, then swaps the frontend by flipping a symlink rather
than copying into the live directory. Copying leaves a window where
`index.html` references bundles that haven't landed yet — anyone loading the
site during that window gets a white screen.

---

## Serving admin and site on separate hostnames (optional)

The default config serves both from one host. To split them:

```nginx
# admin.neithlogic.com — same root, but the public API is not exposed here
server {
    listen 443 ssl http2;
    server_name admin.neithlogic.com;
    root /var/www/scholarships/current;

    # Optional second lock on the admin, on top of app-level auth
    # auth_basic "Restricted";
    # auth_basic_user_file /etc/nginx/.htpasswd;

    location /admin/ { proxy_pass http://wraith_api; }
    location /auth/  { proxy_pass http://wraith_api; }
    location /       { try_files $uri $uri/ /index.html; }
}
```

Then add both hosts to `CORS_ORIGIN` (comma-separated) and re-issue certs with
`-d scholarships.neithlogic.com -d admin.neithlogic.com`.

---

## Troubleshooting

**502 Bad Gateway** — nginx is up, Node isn't.
```bash
systemctl status wraith-api
curl http://127.0.0.1:8080/health
sudo journalctl -u wraith-api -n 50 --no-pager
```

**404 on a deep link like `/scholarships/abc123`** — the SPA fallback isn't
applying. Confirm `try_files $uri $uri/ /index.html;` is inside `location / {}`
and that `root` points at the directory actually containing `index.html`.

**Site shows an old version after deploy** — `index.html` got cached. It must
carry `Cache-Control: no-cache, must-revalidate`. Verify with
`curl -I https://your-host/` and check for a caching CDN in front of nginx.

**Login works but admin calls fail with a CORS error** — `CORS_ORIGIN` doesn't
include the exact scheme+host you're browsing from. It must be
`https://scholarships.neithlogic.com`, not `http://`, not a trailing slash.

**Paywall never unlocks after payment** — cookies aren't surviving the proxy
hop. Confirm `COOKIE_SECURE=true` (you're on HTTPS), that
`proxy_set_header X-Forwarded-Proto $scheme;` is present, and that the webhook
location has `proxy_request_buffering off`.

**Ads don't render with a network configured** — the CSP header is blocking the
provider script. It's commented out in the shipped config precisely because it
must be tailored; uncomment it and add your network's script and frame domains.

**Certbot fails** — DNS isn't resolving yet, or port 80 is closed. Re-check
`dig +short your-host` and `sudo ufw status`.

---

## Ongoing operations

```bash
# Logs
sudo journalctl -u wraith-api -f
sudo tail -f /var/log/nginx/scholarships.error.log

# Engine health
cd /srv/wraith/backend && sudo -u wraith npm run scholarships:status

# Restart
sudo systemctl restart wraith-api

# Roll back to the previous release
ls -1dt /var/www/scholarships/releases/*/ | sed -n 2p   # find it
sudo ln -sfn <that-path> /var/www/scholarships/current
sudo systemctl reload nginx
```

Back up MongoDB on a schedule. The scholarship collections are rebuildable from
a re-crawl, but `Payment`, `Subscription` and `ScholarshipAccess` are not —
those are your revenue records.
