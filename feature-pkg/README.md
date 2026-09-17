# Scholarship Delivery + Teaser Paywall — Feature Package

Adds multi-channel delivery (email, WhatsApp, Telegram) and refines the teaser
paywall for your Wisdom Busara scholarship engine.

## What this adds

**Teaser paywall (refined):**
- Detail views metered at your `SCHOLARSHIP_FREE_VIEWS_PER_MONTH` (you set it to 2)
- **IP-based rate limit** on the detail endpoint (40/day/IP) so clearing cookies
  or incognito still hits a ceiling — the anti-abuse you asked for
- A richer locked-preview payload that tells the reader they can *subscribe to
  get scholarships delivered*

**Delivery — new:**
- Readers who have paid can subscribe on `/subscribe` and pick channels
- **Email** (via SMTP — Brevo/Resend), **WhatsApp** (via your WAHA), **Telegram**
  (via a bot) delivery of new scholarships
- A **group/channel broadcast** path: post new scholarships to a WhatsApp group
  or Telegram channel once per batch — the "paid members are in the group" model
- Runs automatically after each nightly crawl cycle (new Stage 6 in the scheduler)
- A `scholarships:deliver` CLI for manual/dry-run sends
- Idempotent: a per-(subscriber, scholarship, channel) unique log guarantees
  nothing is ever sent twice

## How to apply

This is delivered as source you apply with an idempotent script, review, then
commit — not blind remote edits. On your server:

```bash
cd /srv/wisdombusara

# 1. Copy this package onto the server (scp the zip, unzip it here), so you have
#    ./feature-pkg/ alongside backend/ and frontend/. Then:
sudo -u wisdombusara bash feature-pkg/apply.sh
```

`apply.sh` will:
- install `nodemailer`
- patch `config/env.ts` (adds optional delivery vars — nothing turns on until set)
- patch `routes/scholarshipRoutes.ts` (teaser preview + IP rate limit + mount)
- hook delivery into `scholarshipScheduler.ts` (Stage 6)
- copy in the new files
- add the `scholarships:deliver` npm script

It does **not** build, restart, or commit — you do that after reviewing.

## Then — configure the channels you want

Edit `backend/.env` (see `ENV_ADDITIONS.md` for the full list). Minimum for each:

- **Email:** `SMTP_HOST/PORT/USER/PASS` + `EMAIL_FROM`. Brevo free tier is easiest
  (300 emails/day): sign up → SMTP & API → SMTP → copy host/login/key.
- **WhatsApp:** `WAHA_URL=http://127.0.0.1:3000`, `WAHA_API_KEY=<your key>`,
  optionally `WAHA_GROUP_ID` to broadcast to a group. Works only while a number
  is linked to the WAHA session.
- **Telegram:** `SCHOLARSHIP_TELEGRAM_BOT_TOKEN` from @BotFather,
  `SCHOLARSHIP_TELEGRAM_BOT_USERNAME`, optionally `SCHOLARSHIP_TELEGRAM_CHANNEL`.

Each channel is independent — configure only the ones you want. Unconfigured
channels are silently skipped.

## Frontend

The `/subscribe` page needs three small manual edits (see
`frontend/SUBSCRIBE_CSS.md`):
1. Copy `frontend/src/site/Subscribe.tsx` into your `frontend/src/site/`
2. Append the CSS block to `styles/global.css`
3. Add the `/subscribe` route to `App.tsx`

Then rebuild the frontend and republish (your usual release step).

## Verify

```bash
cd backend
npx tsc -p tsconfig.json --noEmit     # must be clean
sudo systemctl restart wraith-api

# Dry-run delivery: shows what WOULD be sent, sends nothing
sudo -u wisdombusara npm --prefix /srv/wisdombusara/backend run scholarships:deliver -- --dry-run
```

## Commit

```bash
cd /srv/wisdombusara
git add -A
git commit -m "Add multi-channel scholarship delivery + teaser paywall refinements"
git push origin main
```

## The WhatsApp caveat (unchanged)

WhatsApp delivery via WAHA only works while a number is linked to the WAHA
session. WhatsApp bans numbers used for automation — use a dedicated line. If the
session is not linked, WhatsApp sends fail gracefully and email/Telegram continue
unaffected.

## Files in this package

```
apply.sh                          idempotent patch+install script
ENV_ADDITIONS.md                  env vars to add
README.md                         this file
backend/src/models/scholarship/subscriber.ts        Subscriber + DeliveryLog models
backend/src/services/scholarship/delivery/
    email.ts                      SMTP sender + templates
    whatsapp.ts                   WAHA sender + group broadcast
    telegram.ts                   Bot API sender + webhook helpers
    dispatcher.ts                 finds new scholarships, sends per subscriber
backend/src/routes/scholarshipDeliveryRoutes.ts      /subscribe + telegram webhook
frontend/src/site/Subscribe.tsx   channel-picker page
frontend/SUBSCRIBE_CSS.md          CSS + route wiring instructions
```
