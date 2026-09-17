# Environment variables to add

Add these to `backend/src/config/env.ts` inside the zod schema (before the
closing `});` of the schema object), and to your `.env` file.

## In env.ts — add to the zod schema

```ts
  // ── Email delivery (Brevo / Resend / any SMTP) ──────────────────────────
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().optional(),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  EMAIL_FROM: z.string().optional(),

  // ── WhatsApp delivery (WAHA) ────────────────────────────────────────────
  WAHA_URL: z.string().optional(),
  WAHA_API_KEY: z.string().optional(),
  WAHA_SESSION: z.string().optional(),
  WAHA_GROUP_ID: z.string().optional(),

  // ── Telegram delivery ───────────────────────────────────────────────────
  SCHOLARSHIP_TELEGRAM_BOT_TOKEN: z.string().optional(),
  SCHOLARSHIP_TELEGRAM_BOT_USERNAME: z.string().optional(),
  SCHOLARSHIP_TELEGRAM_CHANNEL: z.string().optional(),
```

These are all `.optional()` — each channel is simply OFF until configured, so
adding this changes nothing until you fill values in.

## In your .env — fill what you use

```bash
# ── Email (recommended: Brevo free tier, https://www.brevo.com) ──────────────
# Create account → SMTP & API → SMTP → get host/login/key
SMTP_HOST=smtp-relay.brevo.com
SMTP_PORT=587
SMTP_USER=your-brevo-login@example.com
SMTP_PASS=your-brevo-smtp-key
EMAIL_FROM="Wisdom Busara <support@wisdombusara.com>"

# ── WhatsApp (WAHA — already running on your box) ─────────────────────────────
WAHA_URL=http://127.0.0.1:3000
WAHA_API_KEY=f1dfd602e8f758443e25f1985f42badcdf72b184d216bfa7
WAHA_SESSION=default
# Optional: post new scholarships to a WhatsApp GROUP (the "paid members are in
# the group" model). Get the group id from WAHA's GET /api/{session}/groups.
# Format: XXXXXXXXXXXX@g.us
WAHA_GROUP_ID=

# ── Telegram (get token from @BotFather) ─────────────────────────────────────
SCHOLARSHIP_TELEGRAM_BOT_TOKEN=
SCHOLARSHIP_TELEGRAM_BOT_USERNAME=
# Optional: a channel/group the bot administers, to broadcast to
SCHOLARSHIP_TELEGRAM_CHANNEL=
```
