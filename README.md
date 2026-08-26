# Global Scholarship Intelligence Engine

A scholarship discovery engine and public site, built as a new vertical inside
the existing Wraith platform. Jobs, tenders, auth, subscriptions, WhatsApp and
Telegram are untouched and verified working.

**245 tests passing · 51/51 end-to-end checks · both builds clean.**

---

## What's in this bundle

```
backend/          Node + TypeScript + Express + Mongoose API and crawler
frontend/         React + Vite — public site and admin
waha/             Existing WhatsApp HTTP API service (unchanged)
ops/              nginx config, systemd unit, deploy script, setup guide
docs/             Reports and guides
```

### Start here

| If you want to… | Read |
|---|---|
| Put it on your VPS (from scratch) | **`ops/bootstrap.sh`** + `docs/PREREQUISITES.md` |
| Understand what the VPS needs | `docs/PREREQUISITES.md` |
| Step-by-step manual setup | `ops/VPS_SETUP.md` |
| Understand the engine | `docs/IMPLEMENTATION_REPORT.md` |
| Understand the paywall & ads | `docs/SITE_AND_PAYWALL_GUIDE.md` |
| Just run it locally | Below |

---

## Run it locally

```bash
# Backend
cd backend
npm install
cp .env.example .env      # fill in MONGO_URI and the secrets
npm test                  # 245 tests
npm run dev               # :8080

# Frontend (separate terminal)
cd frontend
npm install
npm run dev               # :5173
```

Then seed and crawl:

```bash
cd backend
npm run scholarships:seed -- --countries=KE,GB
npm run scholarships:discover-universities -- --countries=KE,GB
npm run scholarships:discover -- --limit=3 --dry-run    # inspect first
npm run scholarships:crawl -- --limit=20 --dry-run      # inspect first
npm run scholarships:crawl -- --limit=20
npm run scholarships:status
```

Every command supports `--dry-run`, which does all the fetching and
classification and writes nothing.

---

## Routes

**Public site** — `/` landing, `/scholarships` search, `/scholarships/:id`
detail, `/universities`, `/about`, `/upgrade`, `/restore`

**Admin** (existing auth) — `/scholarships-admin`

**Public API** — `/api/scholarships`, `/api/scholarships/:id`,
`/api/scholarships/facets`, `/api/scholarships/match` (paid),
`/api/universities`, `/api/access/*`, `/api/ads`, `/api/sitemap.xml`

---

## Three design decisions worth knowing

**1. Absent is not false.** Every extracted boolean is `boolean | null` wrapped
in a provenance envelope with a `CONFIRMED / PROBABLE / UNKNOWN / NEGATIVE`
certainty. A page silent on IELTS yields `null` and the UI says "not confirmed";
a page that waives it yields `false`. Conflating those is how applicants miss
deadlines they could have met.

**2. The AI cannot silently overwrite.** Rule-based extraction always runs, even
with AI enabled. The AI may fill gaps or raise confidence where it agrees, but a
contradiction keeps the deterministic value, downgrades certainty, and records
the disagreement for review.

**3. "International students" is not "all countries."** Scope and explicit
country lists are separate fields. The API reports *how* a nationality matched,
and the matcher returns `PROBABLY_ELIGIBLE` rather than a hard yes.

---

## Before you take real money

Two gaps are documented in `docs/SITE_AND_PAYWALL_GUIDE.md` and worth repeating:

1. **Restore codes are shown once and never again.** No email or SMS delivery is
   wired up. Losing the code means manual admin lookup. Wiring it into your
   existing WAHA sender would close this and fits the M-Pesa flow.
2. **No live payment has been tested.** The full chain — checkout, webhook,
   grant, cookie, premium unlock — is verified end-to-end against a real
   MongoDB, but Paystack's API was never actually called. Run one real
   transaction first.

---

## Verification

```bash
cd backend
npm test                                  # 245 unit + integration tests
npx tsx src/scripts/verifyEndToEnd.ts     # 51 checks, real Mongo + real HTTP
npm run build

cd ../frontend
npm run build
```

The end-to-end script boots a real MongoDB and the real Express app, and crawls
fixture pages served over real HTTP — so the genuine fetcher, robots handling,
Cheerio parsing and content hashing all execute. Only the origin is local;
nothing downstream is mocked.
