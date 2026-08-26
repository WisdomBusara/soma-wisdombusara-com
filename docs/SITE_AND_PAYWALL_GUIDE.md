# Scholarship Site — Paywall, Ads & Deployment

Public site, metered paywall and ad system, built on the scholarship engine and
matched to the Wraith design language (warm cream `#faf9f6`, editorial serif,
M‑Pesa first).

**245 tests passing · 51/51 end-to-end checks · both builds clean.**

---

## The paywall model

| | Free | Paid |
|---|---|---|
| Search & listings | ✅ unlimited | ✅ unlimited |
| Full scholarship detail | 5 / month | unlimited |
| Eligibility matcher | ✗ | ✅ |
| Ads | shown | removed |

**Listings are deliberately never gated.** An index search engines can't crawl
has no audience, and a reader who can't see what exists won't pay to see more.
The wall sits at *depth of use*, not the front door — which is also why there's
a `/api/sitemap.xml` and a generated `robots.txt`.

Two smaller decisions that matter in practice:

- **Re-reading the same scholarship is always free.** Only distinct records
  count. Charging twice for a reload punishes normal behaviour and produces
  angry users rather than paying ones.
- **No accounts, no passwords.** Payment issues a signed httpOnly cookie plus a
  6-character restore code (ambiguous glyphs removed, so it can be read over the
  phone). That's the least friction that still works across devices.

Both the access token and the free-view counter are HMAC-signed with a key
derived from `JWT_ACCESS_SECRET` — a reader can't mint themselves access or
reset their quota by editing a cookie. The E2E suite asserts a forged cookie is
rejected.

---

## What it reuses

The paywall is **not** a second billing system. It reuses your `Plan` model,
`Payment` ledger, `paystack.ts` service and the existing signed webhook, so
revenue stays in one place and reconciliation doesn't fork.

One existing-schema change was needed, and it's backwards-compatible:
`Payment.botId` and `Payment.telegramUserId` became optional (a browser checkout
has neither), and `platform`/`vertical` gained `'web'`/`'scholarships'`.
Loosening `required` can't invalidate existing documents, and every existing
writer still supplies both.

**TypeScript immediately caught the real consequence:** the Telegram fulfilment
path assumed those fields always existed. `SubscriptionModel` still requires
them, so I added a guard at the top of that branch — before any write — rather
than after `SubscriptionModel.create`, where it would have thrown first.

---

## Ads

Three supply types, managed from the admin at `/scholarships-admin`:

- **HOUSE** — self-served creative from your DB. Works on day one with no
  network fill, no third-party script, no tracking cookies.
- **NETWORK** — an AdSense-style slot id. Set `ADS_NETWORK_CLIENT_ID`.
- **CUSTOM** — raw admin-authored HTML.

Five placements: `listing_inline` (after the 4th result, deep enough that it
never displaces what the reader came for), `listing_sidebar`, `detail_sidebar`,
`detail_footer`, `landing_banner`.

Weighted rotation, country/degree targeting, impression and click tracking with
CTR in the admin. Clicks route through `/api/ads/:id/click`, which re-reads the
destination from the database — so it can't be turned into an open redirect.

Empty targeting means "everywhere" (an unset filter must never exclude, or a new
ad silently never serves). No fill renders **nothing** — an empty bordered box
looks broken. Every ad is labelled, because an unlabelled ad inside a list of
scholarships reads as an endorsement.

Premium removes ads at the **API boundary**, not in the component, so it can't be
bypassed by calling the endpoint directly.

---

## Deploy to your VPS

```bash
# One-time
sudo cp ops/wraith-api.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now wraith-api

sudo cp ops/nginx/scholarships.conf /etc/nginx/sites-available/scholarships
sudo ln -s /etc/nginx/sites-available/scholarships /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d scholarships.neithlogic.com

# Every deploy
sudo ./ops/deploy.sh
```

`deploy.sh` runs the test suite **before** releasing and rolls the source back if
it fails. The frontend swap is a symlink flip, not a copy into the live
directory — copying leaves a window where `index.html` references bundles that
haven't landed, and anyone loading the site then gets a white screen. It waits
for `/health` before declaring success and keeps the last 5 releases.

Two nginx details worth knowing:
- `try_files … /index.html` — without it, a visitor landing directly on
  `/scholarships/abc123` (exactly what a Google result or shared WhatsApp link
  does) gets a 404.
- `index.html` is **never** cached; hashed assets are cached for a year. Cache
  `index.html` and readers keep loading yesterday's bundle after you ship.

**Auto-deploy:** `deploy.sh` documents both a GitHub Actions SSH step and a
`post-receive` hook. Grant the deploy user exactly
`deploy ALL=(root) NOPASSWD: /srv/wraith/ops/deploy.sh` and nothing more.

---

## Configuration

```bash
SCHOLARSHIP_FREE_VIEWS_PER_MONTH=5
SCHOLARSHIP_SITE_URL=https://scholarships.neithlogic.com
ADS_ENABLED=true
ADS_NETWORK_CLIENT_ID=            # only for NETWORK slots
```

Paystack is already configured — the web vertical reuses `PAYSTACK_SECRET_KEY`
and `PAYSTACK_CALLBACK_BASE_URL`.

**Pricing lives in the database.** Create plans in the admin; the landing page,
upgrade page and checkout all read them live. Running a promotion needs no
redeploy.

---

## Two things to decide before launch

1. **CSP is commented out in the nginx config.** If you enable an ad network,
   its script and frame origins must be allowlisted or ads are silently blocked.
   I left it commented rather than shipping it broken — uncomment and add your
   network's domains.

2. **Restore codes are shown once, on screen, and never again.** There's no
   email or SMS delivery wired up. If a reader loses the code, your only recovery
   path is manual lookup by phone/email in the admin. Wiring the code into your
   existing WAHA WhatsApp sender would close that gap and fits your M-Pesa flow
   naturally — worth doing before you take real money.

---

## Known limitations

- No live payment was tested. The full flow — checkout, webhook, grant, cookie,
  premium unlock — is verified end-to-end against a real MongoDB, but with
  Paystack's API not called. Run one real KSh 20 transaction before launch.
- Free-quota metering is cookie-based, so clearing cookies resets it. That's the
  standard trade-off (the alternative is forced accounts, which kills the funnel)
  and it's fine at a low price point.
- No email/SMS delivery for restore codes (above).
- Ad targeting is country + degree only. No frequency capping or A/B testing.
- The landing page reads live counts from the facets endpoint; with an empty
  database it renders gracefully but shows zeros until you run a crawl.
