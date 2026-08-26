# VPS Prerequisites & Provisioning

Everything your VPS needs before the app can run, and why each piece is there.
Pair this with `docs/VPS_SETUP.md` (the step-by-step) and `ops/bootstrap.sh`
(the script that installs most of it for you).

---

## The shape of the deployment

```
   Internet
      │  443 (HTTPS)
      ▼
   ┌─────────────────────────────────────────┐
   │  nginx  — the only thing publicly exposed │
   └─────────────────────────────────────────┘
      │ 127.0.0.1:8080 (never public)
      ▼
   ┌──────────────────────┐      ┌──────────────────────┐
   │  Node (systemd)      │─────▶│  MongoDB (localhost) │
   │  wraith-api          │      │  127.0.0.1:27017     │
   └──────────────────────┘      └──────────────────────┘
              │
              ▼
         Paystack API (outbound HTTPS)
```

Three processes run on the box: **nginx**, **Node**, **MongoDB**. Only nginx is
reachable from outside. Node and MongoDB both bind to localhost, so even a
misconfigured firewall can't expose your database or your API directly.

---

## 1. The server itself

| Requirement | Minimum | Comfortable |
|---|---|---|
| OS | Ubuntu 22.04 LTS | Ubuntu 24.04 LTS |
| RAM | 2 GB | 4 GB |
| Disk | 20 GB SSD | 40 GB SSD |
| CPU | 1 vCPU | 2 vCPU |

**Why 2 GB is the floor.** MongoDB wants ~1 GB for its cache, Node sits around
150–300 MB, and the `npm run build` step (especially the frontend) is
memory-hungry. On a 1 GB box the build gets OOM-killed. If you're stuck on 1 GB,
add swap (the bootstrap script does this automatically) — it's slower but it
won't fall over.

**Disk** grows with the scholarship data and MongoDB's own overhead. 20 GB is
plenty to start; the crawler's data footprint is small (text, not media).

---

## 2. A domain and DNS

You're using Cloudflare with `wisdombusara.com` on a creative subdomain (e.g.
`soma.wisdombusara.com`).

Before provisioning, the subdomain's A record must point at the VPS IP and be
set to **DNS only (grey cloud)** for the initial certificate issuance. See the
Cloudflare notes in `docs/VPS_SETUP.md`. Verify with:

```bash
dig +short soma.wisdombusara.com    # must return your VPS IP
```

Nothing else works until this resolves — Certbot proves domain ownership over
HTTP, and it can't if the name doesn't point at the box.

---

## 3. Software the bootstrap script installs

You don't install these by hand — `ops/bootstrap.sh` does — but here's what
goes on and why.

### Node.js 20 LTS
The runtime. Pinned to 20 because it's the current LTS and what the code is
tested against. Installed from NodeSource, not Ubuntu's default repo (which
ships an ancient version).

### MongoDB 7.0 (Community)
Your database, running locally. Installed from MongoDB's official apt repo.
Configured to bind `127.0.0.1` only — it is never exposed to the internet, and
it needs no password for a localhost-only single-app setup (though the script
notes how to add auth if you want defence in depth).

### nginx
The reverse proxy and static file server. The only public-facing process.

### Certbot
Issues and auto-renews the Let's Encrypt TLS certificate.

### git, curl, ufw, build-essential
Plumbing: pulling your code, health checks, the firewall, and native module
compilation for npm.

---

## 4. Secrets you must generate

The app refuses to boot without these (the config schema validates them at
startup — that's deliberate, a half-configured server should fail loudly). The
bootstrap script generates them for you and writes a starter `.env`, but if
you're doing it by hand:

```bash
openssl rand -hex 32        # JWT_ACCESS_SECRET
openssl rand -hex 32        # JWT_REFRESH_SECRET  (must differ from the above)
openssl rand -base64 32     # ENCRYPTION_KEY_BASE64
```

**Never invent these by hand or reuse them across environments.** They sign
session tokens and encrypt stored bot credentials.

### What you must fill in yourself

The script can't generate these — they're yours:

| Variable | What it is |
|---|---|
| `PAYSTACK_SECRET_KEY` | Your live `sk_live_…` key from the Paystack dashboard |
| `INITIAL_ADMIN_EMAIL` | The first admin login |
| `INITIAL_ADMIN_PASSWORD` | Min 12 chars — the schema enforces this |
| `CORS_ORIGIN` | `https://soma.wisdombusara.com` — exact, no trailing slash |
| `SCHOLARSHIP_SITE_URL` | Same as above |
| `PAYSTACK_CALLBACK_BASE_URL` | Same as above |

**⚠️ Rotate the Paystack key first.** The `sk_live` key in your original upload
travelled through a channel you don't control — treat it as compromised, rotate
it in the Paystack dashboard, and use the new one here.

---

## 5. Two things about MongoDB on a VPS

**It binds to localhost, so it needs no password here.** A single app talking to
a database on the same machine, with the database not listening on any public
interface, is a standard and safe setup. Nobody can reach `127.0.0.1:27017` from
outside the box. If you later add other apps or want defence-in-depth, enable
auth — the guide shows how — but it's not required for this.

**Back it up.** The scholarship data is rebuildable by re-crawling, but
`Payment`, `Subscription` and `ScholarshipAccess` are your **revenue records**
and are not. The bootstrap script installs a nightly `mongodump` cron. Confirm
it's running after setup and, ideally, copy the dumps off-box periodically
(Cloudflare R2, S3, or even `scp` to another machine).

---

## 6. The GitHub → VPS flow you asked for

Your workflow is: **push to GitHub, pull on the VPS.** The scripts support
exactly this.

```
   Your laptop                 GitHub                    VPS
   ───────────                 ──────                    ───
   git push origin main  ──▶   repo   ◀──  git pull  ──  ops/deploy.sh
                                            (or auto via webhook/Action)
```

- **First time:** `ops/bootstrap.sh` provisions the whole box from a fresh
  Ubuntu install — installs everything above, clones your repo, builds, and
  starts the service.
- **Every update after:** `ops/deploy.sh` pulls the latest, runs the test suite,
  and releases only if tests pass — rolling back automatically if they don't.

Both are in this bundle. Setup instructions below.

---

## 7. Provisioning checklist

Run through this in order. Details for each in `docs/VPS_SETUP.md`.

- [ ] VPS running Ubuntu 22.04+ with ≥2 GB RAM
- [ ] SSH access as a sudo-capable user
- [ ] Subdomain A record → VPS IP, **grey cloud**, resolving (`dig +short`)
- [ ] Paystack key **rotated**
- [ ] Code pushed to a GitHub repo you can clone on the VPS
- [ ] Run `ops/bootstrap.sh` (installs Node, Mongo, nginx, Certbot, firewall,
      clones, builds, starts)
- [ ] Fill in the real values in `/srv/wraith/backend/.env`
- [ ] `sudo certbot --nginx -d soma.wisdombusara.com`
- [ ] Flip Cloudflare to orange cloud + SSL mode **Full (strict)**
- [ ] Point Paystack webhook at `https://soma.wisdombusara.com/webhooks/paystack`
- [ ] Verify (the four `curl` checks in `VPS_SETUP.md`)
- [ ] Seed + crawl, then enable `SCHOLARSHIP_CRAWLER_ENABLED=true`
- [ ] Run one real KSh 20 transaction end-to-end

---

## 8. Ongoing operations

```bash
# Watch the app
sudo journalctl -u wraith-api -f

# Watch MongoDB
sudo systemctl status mongod
sudo journalctl -u mongod -n 50 --no-pager

# Engine health
cd /srv/wraith/backend && sudo -u wraith npm run scholarships:status

# Manual DB backup
mongodump --db wraith --out /var/backups/mongo/manual-$(date +%F)

# Restore from a backup
mongorestore --db wraith --drop /var/backups/mongo/<dump>/wraith
```

**Resource pressure to watch on a small box:** if the site feels slow, check
`free -h` (Mongo cache pressure) and `df -h` (disk from logs + backups). The
bootstrap script rotates both nginx logs and old backups so they don't fill the
disk, but it's worth a monthly glance.
