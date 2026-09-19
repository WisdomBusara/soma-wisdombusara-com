#!/usr/bin/env bash
#
# auto-deploy.sh — checks origin/main for a new commit, deploys only if one
# exists. Meant to run on a cron schedule (see the crontab line documented
# below) rather than on every push — no GitHub-side configuration needed,
# since the VPS already has read-only SSH access to the repo.
#
# Install (as root):
#   chmod +x /srv/wisdombusara/ops/auto-deploy.sh
#   crontab -e
#   # add this line:
#   */5 * * * * /srv/wisdombusara/ops/auto-deploy.sh >> /var/log/wisdombusara-autodeploy.log 2>&1
#
set -euo pipefail

APP_DIR="${APP_DIR:-/srv/wisdombusara}"
BRANCH="${BRANCH:-main}"

cd "$APP_DIR"
git fetch --quiet origin "$BRANCH"

LOCAL="$(git rev-parse HEAD)"
REMOTE="$(git rev-parse "origin/$BRANCH")"

if [[ "$LOCAL" != "$REMOTE" ]]; then
  echo "$(date -Iseconds) New commit on $BRANCH ($LOCAL -> $REMOTE) — deploying"
  "$APP_DIR/ops/deploy.sh"
else
  echo "$(date -Iseconds) Up to date at $LOCAL — nothing to do"
fi
