# Global Scholarship Intelligence Engine — Implementation Report

Built into the existing Wraith codebase as a new vertical. Jobs, tenders, auth,
subscriptions, WhatsApp and Telegram are untouched and verified working.

---

## Baseline vs. final

| | Before | After |
|---|---|---|
| Backend tests | 64 passing (1 file) | **230 passing (5 files)** |
| Backend `tsc` | clean | clean |
| Frontend build | clean | clean |
| End-to-end verification | — | **39/39 checks** against real MongoDB + real HTTP |

No existing test was modified or deleted.

---

## Architecture

The pipeline is built as a chain of independently testable stages:

```
University Discovery → verification → University Registry
        ↓
Scholarship URL Discovery (path probing + link classification)
        ↓
Crawl Target Queue (leased, prioritised, deduped by canonical URL)
        ↓
Fetch: HTTP/Cheerio → content-quality gate → Playwright only if needed
        ↓                                    → PDF path
Page Classification (rules, 3-class)
        ↓
Extraction: rules baseline (always) ⊕ validated AI overlay (optional)
        ↓
Normalization (degree / country / funding / mode / deadline / eligibility)
        ↓
Deduplication (canonical fingerprint) → source aggregation
        ↓
Status engine + change detection
        ↓
Search API / Matching → Admin + public site
```

### Three decisions that shaped everything else

**1. Absent ≠ false.** Every extracted boolean is `boolean | null` inside a
provenance envelope carrying a `CONFIRMED / PROBABLE / UNKNOWN / NEGATIVE`
certainty. A page silent on accommodation yields `null`; a page saying "does not
cover accommodation" yields `false`. This is enforced in the schema, the
extractors, the AI validator, the matcher and the UI — it isn't a convention that
can drift.

**2. The AI can fill gaps but cannot silently overwrite.** Rules always run, even
when AI is enabled. On merge, the AI may fill an unknown field or raise
confidence where it agrees — but a contradiction keeps the deterministic value,
downgrades certainty to `PROBABLE`, and records the disagreement for admin
review. Disagreements also reduce the confidence score.

**3. "International students" is not "all countries."** Eligibility scope and
explicit country lists are separate fields. `INTERNATIONAL` never populates
`countries`. The API returns *how* a nationality matched
(`EXPLICIT` / `INTERNATIONAL_UNCONFIRMED` / …) and the matcher returns
`PROBABLY_ELIGIBLE`, never a hard yes.

---

## Existing code reused

| Reused | How |
|---|---|
| `config/env.ts` | Extended the same zod schema + `parseBool` helper |
| `config/logger.ts` | All engine logging |
| `db/mongo.ts` | Unchanged; engine adds explicit index provisioning (see below) |
| `middleware/requireAuth` + `requireCsrf` | Admin routes mounted under existing `adminRouter` — no new auth path |
| `middleware/errorHandler` | All routes `next(err)` into it |
| `services/classifier.ts` **patterns** | `scholarshipClassifier` mirrors its `wb()` word-boundary matching, veto-before-score ordering and 3-class verdict |
| `services/jobScheduler.ts` **patterns** | `ScholarshipScheduler` uses the same node-cron class shape and Mongo-backed run lock |
| `routes/publicRoutes.ts` **patterns** | `/api` uses the same permissive GET CORS + own rate limit |
| Frontend design tokens | Site extends `--bg/--surface/--accent/--radius`; no second theme |
| `frontend/src/api/client.ts` **patterns** | New `publicFetch` mirrors it without credentials |
| vitest | Same runner; added a config only to inject test env |

---

## New models (7 collections)

`University`, `Scholarship`, `ScholarshipSource`, `CrawlTarget`, `CrawlRun`,
`ExtractionRun`, `ScholarshipChange`.

Funding, eligibility and requirements are **embedded sub-schemas**, not separate
collections — they are 1:1 with a scholarship, always read with it, never queried
independently. Splitting them would add a join to every search for no benefit.

Each uses a reusable `provenanceField()` wrapper producing
`{ value, confidence, certainty, sourceUrl, sourceText, method }` with
`_id: false`, so Mongo doesn't mint an ObjectId per extracted field.

### Indexes — and one production correctness issue found

All §45 indexes are declared. **`db/mongo.ts` connects with
`autoIndex: NODE_ENV !== 'production'`**, which is a sound default but meant the
new indexes would never be created in production. Three of them are correctness
mechanisms, not performance tuning:

- `University.domain` unique → one institution per domain
- `Scholarship.fingerprint` unique → the dedup backstop under concurrency
- `ScholarshipSource (scholarshipId, canonicalUrl)` unique → idempotent attachment

Without them, two workers crawling the same award concurrently both succeed and
duplicates accumulate silently. `services/scholarship/indexes.ts` provisions them
explicitly at engine startup and on every CLI invocation, independent of
`autoIndex`. This was caught by the end-to-end run, not by unit tests.

---

## New services

**Normalization** — `text` (canonical URL, domain, title, content hash,
fingerprint), `country` (40 countries + demonyms + region buckets), `degree`,
`studyMode`, `funding`, `deadline`, `eligibility`, `requirements`.

**Pipeline** — `scholarshipClassifier`, `politeness` (robots.txt, per-domain
concurrency/delay/backoff), `fetcher`, `universityDiscovery` (3 pluggable
providers + live domain verification), `scholarshipDiscovery`, `extractor/rules`,
`extractor/ai`, `extractor/schema`, `extractor/index`, `dedupe`, `status`,
`matcher`, `pipeline`, `scholarshipScheduler`, `indexes`.

**Optional dependencies are lazy-required inside try/catch.** Playwright and
`pdf-parse` are declared in `optionalDependencies`; if absent, the service still
builds, boots and crawls HTML correctly — a missing optional dep degrades a
capability rather than breaking the process.

---

## APIs

**Public** (`/api`, no auth, own CORS + 60/min rate limit)

```
GET  /api/scholarships          ?degree&country&university&field&funding
                                &fullyFunded&studyMode&attendance&nationality
                                &status&deadlineBefore&deadlineAfter&q
                                &minConfidence&sort&page&limit
GET  /api/scholarships/facets
GET  /api/scholarships/:id
POST /api/scholarships/match
GET  /api/universities          ?country&q&page&limit
GET  /api/universities/:id
```

The §30 query works verbatim and is verified end-to-end:
`?degree=MASTERS&country=GB&fullyFunded=true&nationality=KE`

**Admin** (`/admin/scholarship/*`, inherits existing auth + CSRF) — 20 endpoints
covering metrics, the review queue (`APPROVE`/`REJECT`/`EDIT`/`RECRAWL`),
universities (enable/disable/force-crawl), crawl targets, runs, extraction
failures, changes, blocked domains, and operations (discover / run / dry-run /
refresh-statuses / reprioritize / crawl-url).

---

## Frontend

**Public site** (routes outside the auth-gated `Shell`, so they resolve without a
session): `/scholarships` (faceted search), `/scholarships/:id` (detail),
`/universities`, `/universities/:id`, `/about`.

The UI makes provenance visible rather than hiding it — every card shows whether
the source is official, whether it was auto-extracted, and whether it needs
verification. Tri-state funding renders "Not stated" in grey italic with a `?`,
never a cross, so silence is never mistaken for a negative. Hovering any
extracted value reveals the source sentence.

**Admin**: `/scholarships-admin` — one tabbed page (overview / scholarships /
universities / targets / runs / changes), because the operational workflow moves
between the review queue and the run log constantly.

---

## CLI

```bash
npm run scholarships:seed                  # insert seed universities (UNVERIFIED)
npm run scholarships:discover-universities # verify domains, activate
npm run scholarships:discover              # find funding URLs
npm run scholarships:crawl                 # drain the queue
npm run scholarships:extract -- --url=…    # one URL, end to end
npm run scholarships:verify                # recrawl one, or refresh statuses
npm run scholarships:status                # engine metrics
npm run scholarships:run                   # full cycle
npm run scholarships:reprocess-failed
```

Every command supports `--dry-run` (does all reading and classification, writes
nothing), plus `--countries`, `--university`, `--limit`, `--no-ai`.

---

## Environment variables

~25 added to `.env.example`, **all defaulting to OFF or to safe values**, so an
existing deployment boots unchanged. Key ones:
`SCHOLARSHIP_CRAWLER_ENABLED=false`, `PLAYWRIGHT_ENABLED=false`,
`AI_EXTRACTION_ENABLED=false`, `AI_PROVIDER=none`,
`UNIVERSITY_DISCOVERY_ENABLED=false`, `SCHOLARSHIP_RESPECT_ROBOTS=true`,
`SCHOLARSHIP_CRAWL_INTERVAL=0 2 * * *` (02:00 UTC, avoiding your existing
04:00/04:20 jobs and tenders runs).

No secrets in source. AI is fully optional — with it disabled the engine still
performs complete rule-based discovery, classification and extraction.

---

## Tests

**230 passing** (64 pre-existing + 166 new) across degree/country/funding/
study-mode/deadline normalization, eligibility and nationality matching,
structured requirements, link and page classification, fingerprinting and dedup,
the status engine, change detection, AI-output validation, the matching engine,
and a full integration suite (crawl → extract → normalize → dedupe → status)
covering complete pages, mirrored sources, sparse pages, PDFs, expired awards and
re-crawl diffs.

### Six real bugs the tests caught

1. **Trailing-slash canonicalization** — `/scholarships/?id=5` kept its slash
   because the strip ran on the href instead of the pathname, forking crawl targets.
2. **Plural/singular title mismatch** — "Scholarships" vs "Scholarship" produced
   different fingerprints, silently duplicating awards.
3. **Disability eligibility pattern too narrow** — matched "students with a
   disability" but not "applicants with a disability".
4. **Generic hub titles scored as awards** — "Scholarships and funding" reached
   the scholarship threshold before the landing-page check ran. Fixed with the
   same ordering your existing `classifyTender` already applies to "Current Tenders".
5. **Entry requirements read as award degree levels** — "Applicants must hold a
   Bachelor degree" tagged a Master's scholarship as `BACHELORS`, which would
   surface postgraduate awards in undergraduate search results. Now classified by
   sentence context, with prerequisite levels reported separately.
6. **Spurious deadline-change events** — two sources for the same award stating
   "23:59 GMT on 15 January" vs "15 January" parse to different times on the same
   day, emitting a MAJOR "deadline changed" alert on every crawl. Deadlines now
   compare at day granularity.

Bugs 5 and 6 were found by *reading the end-to-end diagnostics*, not by a failing
assertion — the assertions were too loose. Both now have tightened assertions and
dedicated unit tests.

### End-to-end verification

`npx tsx src/scripts/verifyEndToEnd.ts` — **39/39**. Boots a real MongoDB and the
real Express app, and crawls fixture pages served over real HTTP, so the genuine
fetcher, robots handling, Cheerio parsing, link extraction and content hashing all
execute. Only the *origin* is local; nothing downstream is mocked. Confirms
extraction fidelity, tri-state funding, dedup collapsing two URLs into one record
with two sources, correct rejection of a fee-payment page, content-hash caching,
change detection, status transitions, all public endpoints, and that `/public` and
`/health` still respond.

---

## Crawler behaviour

HTTP/Cheerio is the default. Playwright runs only when a content-quality gate
detects a JS-rendered shell (SPA root div, `__INITIAL_STATE__`, markup-to-text
ratio below 3%), and the render is discarded unless it produced more text. PDFs
are a first-class channel. Per-domain concurrency, request delay, exponential
backoff on 429/503, robots.txt with longest-match precedence and `Crawl-delay`
support, max page size, max depth, content-type checks, canonical-URL dedup.

`401`/`403` stops the crawl and marks the target `BLOCKED` with a reason. Nothing
attempts to bypass authentication, CAPTCHAs, paywalls or anti-bot protections.

---

## Known limitations — honestly

1. **No live production crawl was performed.** Verification used fixtures served
   over local HTTP. The classifier and extractors are tuned against realistic but
   synthetic pages; real university sites will surface patterns these miss. Run
   `npm run scholarships:extract -- --url=… --dry-run` against real pages before
   enabling the scheduler.

2. **Country table is ~40 countries, not all 195.** Covers the rollout countries
   and those common in eligibility clauses. Unrecognised countries return `null`
   and are preserved in raw text rather than dropped, but won't be filterable.
   A full ISO dataset is a data problem, not a code change.

3. **Playwright and `pdf-parse` are not installed.** Declared as optional deps
   and lazy-required, so HTML crawling works without them. For JS pages and PDFs:
   `npm i playwright pdf-parse && npx playwright install chromium`.

4. **AI extraction is untested against a live provider.** The schema validator,
   prompt, retry logic and merge are unit-tested, and all three provider adapters
   (Anthropic/OpenAI/HuggingFace) are implemented — but no real API call was made.

5. **`LinkDiscoveryProvider` is conservative** and will find few new institutions
   in practice. `UNIVERSITY_DATASET_URL` (a self-hosted public dataset) is the
   realistic path to scale beyond the seed list.

6. **Field-of-study extraction uses a fixed keyword list** (~30 disciplines).
   Niche fields won't be tagged.

7. **Rate limiting is in-process.** Multiple instances won't share per-domain
   budgets. A shared limiter would need Redis or a Mongo-backed token bucket.

8. **No alert delivery.** `ScholarshipChange` records carry a `notified` flag and
   MAJOR/MINOR significance so alerts are straightforward to add, but no channel
   is wired to WhatsApp/Telegram yet.

9. **The matcher scores a pre-filtered 400 candidates in memory.** Fine at
   current scale; beyond ~100k open scholarships this needs to move into an
   aggregation pipeline or a search index.

---

## To run it

```bash
cd backend && npm install
# optional: npm i playwright pdf-parse && npx playwright install chromium

# .env
SCHOLARSHIP_CRAWLER_ENABLED=true
UNIVERSITY_DISCOVERY_ENABLED=true
UNIVERSITY_DISCOVERY_COUNTRIES=KE,GB      # start narrow

npm run scholarships:seed -- --countries=KE,GB
npm run scholarships:discover-universities -- --countries=KE,GB
npm run scholarships:discover -- --limit=3 --dry-run   # inspect first
npm run scholarships:discover -- --limit=3
npm run scholarships:crawl -- --limit=20 --dry-run     # inspect first
npm run scholarships:crawl -- --limit=20
npm run scholarships:status
```

Public site at `/scholarships`, admin at `/scholarships-admin`.
