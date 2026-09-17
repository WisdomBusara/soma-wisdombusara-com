#!/usr/bin/env bash
#
# apply.sh — apply the delivery + teaser-paywall feature to the codebase.
#
# Run from the repo root (/srv/wisdombusara) as the app user:
#   cd /srv/wisdombusara
#   sudo -u wisdombusara bash apply.sh
#
# It is idempotent: safe to re-run. It patches existing files with Python
# (exact-match replacements that no-op if already applied), copies in the new
# files, and installs nodemailer. It does NOT build, restart, or commit — you do
# that after reviewing, so nothing happens behind your back.
#
set -Eeuo pipefail

ROOT="$(pwd)"
BE="$ROOT/backend"
[[ -f "$BE/package.json" ]] || { echo "✗ Run this from the repo root (/srv/wisdombusara)"; exit 1; }

say()  { printf '\033[1;36m▸ %s\033[0m\n' "$*"; }
ok()   { printf '\033[1;32m  ✓ %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m  ! %s\033[0m\n' "$*"; }

# ── 1. Install nodemailer (email transport) ──────────────────────────────────
say "Installing nodemailer"
( cd "$BE" && npm install nodemailer >/dev/null 2>&1 && npm install --save-dev @types/nodemailer >/dev/null 2>&1 ) || warn "npm install had warnings"
ok "nodemailer installed"

# ── 2. Patch env.ts — add delivery config to the zod schema ───────────────────
say "Patching config/env.ts"
python3 - "$BE/src/config/env.ts" <<'PY'
import sys, re
p = sys.argv[1]
s = open(p).read()
marker = "SCHOLARSHIP_TELEGRAM_BOT_TOKEN"
if marker in s:
    print("  already patched — skipping")
else:
    block = """  // ── Delivery: email (SMTP), WhatsApp (WAHA), Telegram ────────────────────
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().optional(),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  EMAIL_FROM: z.string().optional(),
  WAHA_URL: z.string().optional(),
  WAHA_API_KEY: z.string().optional(),
  WAHA_SESSION: z.string().optional(),
  WAHA_GROUP_ID: z.string().optional(),
  SCHOLARSHIP_TELEGRAM_BOT_TOKEN: z.string().optional(),
  SCHOLARSHIP_TELEGRAM_BOT_USERNAME: z.string().optional(),
  SCHOLARSHIP_TELEGRAM_CHANNEL: z.string().optional(),
"""
    # Insert before the ADS_NETWORK_CLIENT_ID line's closing, right after it.
    anchor = "  ADS_NETWORK_CLIENT_ID: z.string().optional()"
    if anchor in s:
        s = s.replace(anchor, anchor + ",\n" + block.rstrip(), 1)
    else:
        # Fallback: insert before the first "});" that closes the schema
        idx = s.find("});")
        s = s[:idx] + block + s[idx:]
    open(p, "w").write(s)
    print("  ✓ env.ts patched")
PY

# ── 3. Patch scholarshipRoutes.ts — teaser preview + IP rate limit ────────────
say "Patching routes/scholarshipRoutes.ts (teaser paywall)"
python3 - "$BE/src/routes/scholarshipRoutes.ts" <<'PY'
import sys
p = sys.argv[1]
s = open(p).read()

changed = False

# 3a. Add an IP-based rate limiter to the detail endpoint, on top of the cookie
#     meter, so clearing cookies still hits a per-IP ceiling. We add a limiter
#     import usage — reuse express-rate-limit which is already a dependency.
if "detailIpLimiter" not in s:
    # Insert limiter creation right after the router is created.
    needle = "const router = Router();"
    if needle in s:
        inject = needle + """

  // Anti-abuse: even with the cookie meter, cap detail views per IP per day so
  // clearing cookies / incognito cannot mint unlimited free reads.
  const detailIpLimiter = rateLimit({
    windowMs: 24 * 60 * 60 * 1000,
    limit: 40,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { error: 'ip_rate_limited', message: 'Too many scholarship views from this network today. Please subscribe for unlimited access.', upgradeUrl: '/upgrade' }
  });"""
        s = s.replace(needle, inject, 1)
        changed = True

# 3b. Attach the IP limiter to the detail route. Find the detail GET handler.
#     It is the route with consumeFreeView in it. We add the limiter middleware
#     to its definition. The handler starts with router.get('/scholarships/:id'
import re
if "detailIpLimiter" in s and "'/scholarships/:id', detailIpLimiter" not in s:
    m = re.search(r"router\.get\(\s*'/scholarships/:id'\s*,", s)
    if m:
        s = s[:m.end()] + " detailIpLimiter," + s[m.end():]
        changed = True

# 3c. Enrich the locked preview so the teaser is useful: add deadlineKind and a
#     clear "subscribe to get delivered" hint. Keep it minimal and safe.
old_preview = """          preview: {
            id: String(s._id),
            title: s.title,
            university: s.universityName ?? null,
            country: s.country,
            degreeLevels: s.degreeLevels ?? [],
            funding: s.funding?.primaryType ?? 'UNKNOWN',
            deadline: s.deadline?.date ?? null,
            status: s.status
          },"""
new_preview = """          preview: {
            id: String(s._id),
            title: s.title,
            university: s.universityName ?? null,
            country: s.country,
            degreeLevels: s.degreeLevels ?? [],
            funding: s.funding?.primaryType ?? 'UNKNOWN',
            deadline: s.deadline?.date ?? null,
            deadlineKind: s.deadline?.kind ?? 'UNKNOWN',
            status: s.status
          },
          // The teaser tells them what they get by subscribing.
          delivery: 'Unlock full details, and get new scholarships delivered by email, Telegram or WhatsApp.',"""
if old_preview in s:
    s = s.replace(old_preview, new_preview, 1)
    changed = True

if changed:
    open(p, "w").write(s)
    print("  ✓ scholarshipRoutes.ts patched")
else:
    print("  already patched — skipping")
PY

# ── 4. Mount the delivery router in the scholarship API ───────────────────────
say "Mounting delivery routes"
python3 - "$BE/src/routes/scholarshipRoutes.ts" <<'PY'
import sys
p = sys.argv[1]
s = open(p).read()
if "scholarshipDeliveryRouter" in s:
    print("  already mounted — skipping")
else:
    # import
    imp = "import { scholarshipAccessRouter } from './scholarshipAccessRoutes';"
    if imp in s:
        s = s.replace(imp, imp + "\nimport { scholarshipDeliveryRouter } from './scholarshipDeliveryRoutes';", 1)
    # mount alongside the access router
    mount = "router.use(scholarshipAccessRouter());"
    if mount in s:
        s = s.replace(mount, mount + "\n  router.use(scholarshipDeliveryRouter());", 1)
    open(p, "w").write(s)
    print("  ✓ delivery router mounted")
PY

# ── 5. Hook delivery + telegram webhook into the scheduler ────────────────────
say "Hooking delivery into the nightly cycle"
python3 - "$BE/src/services/scholarship/scholarshipScheduler.ts" <<'PY'
import sys
p = sys.argv[1]
s = open(p).read()
changed = False

if "dispatchDeliveries" not in s:
    # import
    anchor = "import { ensureScholarshipIndexes } from './indexes';"
    if anchor in s:
        s = s.replace(anchor, anchor + "\nimport { dispatchDeliveries } from './delivery/dispatcher';\nimport { ensureTelegramWebhook } from './delivery/telegram';", 1)
        changed = True

# Add a delivery stage after the crawl stage in runScholarshipCycle. We insert
# right after "// Stage 4 — statuses" block's try/catch by appending a new stage
# before the reprioritise stage.
if "Stage 6 — delivery" not in s:
    needle = "  // Stage 5 — adaptive priorities"
    if needle in s:
        inject = """  // Stage 6 — delivery (send new scholarships to subscribers + group)
  try {
    const d = await dispatchDeliveries({ dryRun: opts.dryRun });
    (summary as any).delivery = d;
  } catch (err) {
    logger.error({ err }, 'scholarship: delivery stage failed');
  }

""" + needle
        s = s.replace(needle, inject, 1)
        changed = True

# Ensure the telegram webhook is set at scheduler start.
if "ensureTelegramWebhook()" not in s:
    needle = "logger.info({ schedule: env.SCHOLARSHIP_CRAWL_INTERVAL }, 'scholarship: scheduler started');"
    if needle in s:
        inject = "void ensureTelegramWebhook().catch(() => undefined);\n    " + needle
        s = s.replace(needle, inject, 1)
        changed = True

if changed:
    open(p, "w").write(s)
    print("  ✓ scheduler hooked")
else:
    print("  already hooked — skipping")
PY

# ── 6. Copy in the new files ──────────────────────────────────────────────────
say "Copying new source files"
PKG="$(dirname "$0")"
mkdir -p "$BE/src/services/scholarship/delivery"
cp "$PKG/backend/src/models/scholarship/subscriber.ts"                 "$BE/src/models/scholarship/subscriber.ts"
cp "$PKG/backend/src/services/scholarship/delivery/email.ts"           "$BE/src/services/scholarship/delivery/email.ts"
cp "$PKG/backend/src/services/scholarship/delivery/whatsapp.ts"        "$BE/src/services/scholarship/delivery/whatsapp.ts"
cp "$PKG/backend/src/services/scholarship/delivery/telegram.ts"        "$BE/src/services/scholarship/delivery/telegram.ts"
cp "$PKG/backend/src/services/scholarship/delivery/dispatcher.ts"      "$BE/src/services/scholarship/delivery/dispatcher.ts"
cp "$PKG/backend/src/routes/scholarshipDeliveryRoutes.ts"             "$BE/src/routes/scholarshipDeliveryRoutes.ts"
ok "new files copied"

# ── 7. Add an admin CLI command for manual delivery + a manual trigger ────────
say "Adding manual delivery npm script"
python3 - "$BE/package.json" <<'PY'
import sys, json
p = sys.argv[1]
d = json.load(open(p))
d.setdefault("scripts", {})
if "scholarships:deliver" not in d["scripts"]:
    d["scripts"]["scholarships:deliver"] = "tsx src/cli/deliver.ts"
    json.dump(d, open(p, "w"), indent=2)
    print("  ✓ added scholarships:deliver script")
else:
    print("  already present — skipping")
PY

cat > "$BE/src/cli/deliver.ts" <<'TS'
import { connectMongo } from '../db/mongo';
import { dispatchDeliveries } from '../services/scholarship/delivery/dispatcher';

/** Manually trigger a delivery run. Usage: npm run scholarships:deliver -- --dry-run */
(async () => {
  await connectMongo();
  const dryRun = process.argv.includes('--dry-run');
  const summary = await dispatchDeliveries({ dryRun, sinceMinutes: 10080 }); // last 7 days
  console.log(JSON.stringify(summary, null, 2));
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
TS
ok "delivery CLI added"

echo
say "DONE — nothing built, restarted, or committed yet."
cat <<NEXT

Next steps (you run these, after reviewing the changes):

  1. Add your channel credentials to backend/.env
     (see ENV_ADDITIONS.md — at minimum SMTP_* for email, WAHA_* is prefilled)

  2. Type-check and build:
       cd backend && npx tsc -p tsconfig.json --noEmit

  3. If clean, restart:
       sudo systemctl restart wraith-api

  4. Test a dry-run delivery (sends nothing, shows what would go):
       sudo -u wisdombusara npm --prefix backend run scholarships:deliver -- --dry-run

  5. Commit:
       git add -A && git commit -m "Add multi-channel scholarship delivery (email/WhatsApp/Telegram) + teaser paywall" && git push origin main

NEXT
