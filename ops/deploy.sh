#!/usr/bin/env bash
#
# deploy.sh — build and release, atomically.
#
# Run on the VPS, either by hand or from a git post-receive hook / GitHub
# Actions runner (see AUTO-DEPLOY at the bottom).
#
# The important property here is that the frontend swap is a symlink flip, not
# a file copy into a live directory. Copying into the served root means there is
# a window where index.html references bundles that have not landed yet, and
# anyone loading the site in that window gets a white screen. Build to a new
# release directory, then move the pointer.
#
#   sudo ./ops/deploy.sh
#
set -euo pipefail

APP_DIR="${APP_DIR:-/srv/wisdombusara}"
WEB_ROOT="${WEB_ROOT:-/var/www/scholarships}"
SERVICE="${SERVICE:-wraith-api}"
KEEP_RELEASES="${KEEP_RELEASES:-5}"
BRANCH="${BRANCH:-main}"

log()  { printf '\033[1;32m▸\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m✗\033[0m %s\n' "$*" >&2; exit 1; }

[[ -d "$APP_DIR" ]] || die "APP_DIR not found: $APP_DIR"
cd "$APP_DIR"

# ── 1. Source ────────────────────────────────────────────────────────────────
log "Fetching $BRANCH"
git fetch --quiet origin "$BRANCH"
PREV_SHA="$(git rev-parse HEAD)"
git reset --hard --quiet "origin/$BRANCH"
NEW_SHA="$(git rev-parse --short HEAD)"
log "At $NEW_SHA ($(git log -1 --pretty=%s))"

# ── 2. Backend ───────────────────────────────────────────────────────────────
log "Installing backend dependencies"
cd "$APP_DIR/backend"
npm ci --omit=dev --no-audit --no-fund

log "Running tests"
# Tests need dev dependencies; install them separately so production node_modules
# stays lean. A failing test aborts the deploy before anything is swapped.
npm ci --no-audit --no-fund >/dev/null
if ! npm test; then
  warn "Tests failed — rolling back source to $PREV_SHA"
  git reset --hard --quiet "$PREV_SHA"
  die "Deploy aborted. Nothing was released."
fi

log "Building backend"
npm run build
npm prune --omit=dev

# ── 3. Frontend → new release dir ────────────────────────────────────────────
log "Building frontend"
cd "$APP_DIR/frontend"
npm ci --no-audit --no-fund
npm run build

RELEASE="$WEB_ROOT/releases/$(date +%Y%m%d%H%M%S)-$NEW_SHA"
mkdir -p "$RELEASE"
cp -r dist/. "$RELEASE/"

# robots.txt is generated so the sitemap URL always matches the deployed host
cat > "$RELEASE/robots.txt" <<ROBOTS
User-agent: *
Allow: /
Disallow: /admin
Disallow: /login
Disallow: /upgrade/complete
Sitemap: https://${SITE_HOST:-scholarships.neithlogic.com}/sitemap.xml
ROBOTS

# ── 4. Atomic swap ───────────────────────────────────────────────────────────
log "Releasing $RELEASE"
ln -sfn "$RELEASE" "$WEB_ROOT/current.tmp"
mv -Tf "$WEB_ROOT/current.tmp" "$WEB_ROOT/current"

# ── 5. Restart API ───────────────────────────────────────────────────────────
log "Restarting $SERVICE"
systemctl restart "$SERVICE"

# Wait for health before declaring success — a service that restarts into a
# crash loop should fail the deploy loudly, not silently.
for i in $(seq 1 20); do
  if curl -fsS --max-time 2 http://127.0.0.1:8090/health >/dev/null 2>&1; then
    log "API healthy after ${i}s"
    break
  fi
  if [[ $i -eq 20 ]]; then
    warn "API did not become healthy — check: journalctl -u $SERVICE -n 50"
    die "Deploy finished but the API is unhealthy."
  fi
  sleep 1
done

# ── 6. Reload nginx & prune ──────────────────────────────────────────────────
nginx -t >/dev/null 2>&1 && systemctl reload nginx && log "nginx reloaded"

cd "$WEB_ROOT/releases"
ls -1dt ./*/ 2>/dev/null | tail -n +$((KEEP_RELEASES + 1)) | xargs -r rm -rf
log "Kept the last $KEEP_RELEASES releases"

log "Deployed $NEW_SHA"

# ─────────────────────────────────────────────────────────────────────────────
# AUTO-DEPLOY
#
# Option A — GitHub Actions (recommended). Add a workflow that SSHes in:
#
#   - name: Deploy
#     uses: appleboy/ssh-action@v1
#     with:
#       host: ${{ secrets.VPS_HOST }}
#       username: deploy
#       key: ${{ secrets.VPS_SSH_KEY }}
#       script: sudo /srv/wisdombusara/ops/deploy.sh
#
# Option B — git post-receive hook on the VPS itself:
#
#   # /srv/wisdombusara.git/hooks/post-receive
#   #!/usr/bin/env bash
#   while read _old _new ref; do
#     [[ "$ref" == "refs/heads/main" ]] && sudo /srv/wisdombusara/ops/deploy.sh
#   done
#
# Grant the deploy user exactly these, and nothing more:
#   deploy ALL=(root) NOPASSWD: /srv/wisdombusara/ops/deploy.sh
# ─────────────────────────────────────────────────────────────────────────────
