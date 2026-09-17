import "dotenv/config";
import { z } from 'zod';

function parseBool(value: string | undefined, defaultValue: boolean): boolean {
  if (value === undefined) return defaultValue;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'true' || normalized === '1' || normalized === 'yes') return true;
  if (normalized === 'false' || normalized === '0' || normalized === 'no') return false;
  return defaultValue;
}

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(8080),

  MONGO_URI: z.string().min(1),

  CORS_ORIGIN: z.string().min(1),
  COOKIE_SECURE: z.string().optional(),
  COOKIE_SAMESITE: z.enum(['LAX', 'STRICT', 'NONE']).default('LAX'),

  JWT_ACCESS_SECRET: z.string().min(32),
  JWT_REFRESH_SECRET: z.string().min(32),
  JWT_ISSUER: z.string().default('wraith-backend'),

  ENCRYPTION_KEY_BASE64: z.string().min(8),

  INITIAL_ADMIN_EMAIL: z.string().email(),
  INITIAL_ADMIN_PASSWORD: z.string().min(12),

  PAYSTACK_SECRET_KEY: z.string().min(1),
  PAYSTACK_CALLBACK_BASE_URL: z.string().url().optional(),

  TELEGRAM_MODE: z.enum(['polling', 'webhook']).default('polling'),
  TELEGRAM_WEBHOOK_BASE_URL: z.string().url().optional(),
  NGROK_API_URL: z.string().url().optional(),
  NGROK_TUNNEL_NAME: z.string().min(1).optional(),

  WAHA_DEFAULT_API_KEY: z.string().optional(),

  // Hugging Face — job categorization (premium). Unset = feature disabled.
  HF_TOKEN: z.string().optional(),
  HF_MODEL: z.string().optional(),
  // Preferred: your Space running the summarize+classify pipeline
  HF_SPACE_URL: z.string().url().optional(),

  // Daily job report — scheduler disabled if JOB_REPORT_GROUP_JID is unset
  JOB_REPORT_GROUP_JID:    z.string().optional(),
  JOB_REPORT_WAHA_URL:     z.string().url().optional(),
  JOB_REPORT_WAHA_SESSION: z.string().optional(),

  // ── Scholarship Intelligence Engine (§40) ────────────────────────────────
  // Every value has a default, so an existing deployment keeps booting with an
  // unchanged .env. The engine stays OFF until explicitly enabled.
  SCHOLARSHIP_CRAWLER_ENABLED:    z.string().optional(),
  SCHOLARSHIP_CRAWL_CONCURRENCY:  z.coerce.number().int().positive().max(32).default(4),
  SCHOLARSHIP_DOMAIN_CONCURRENCY: z.coerce.number().int().positive().max(8).default(2),
  SCHOLARSHIP_REQUEST_DELAY_MS:   z.coerce.number().int().nonnegative().default(1200),
  SCHOLARSHIP_MAX_DEPTH:          z.coerce.number().int().nonnegative().max(6).default(2),
  SCHOLARSHIP_REQUEST_TIMEOUT:    z.coerce.number().int().positive().default(20_000),
  SCHOLARSHIP_RETRY_LIMIT:        z.coerce.number().int().nonnegative().max(10).default(3),
  SCHOLARSHIP_CRAWL_INTERVAL:     z.string().default('0 2 * * *'),
  SCHOLARSHIP_CLOSING_SOON_DAYS:  z.coerce.number().int().positive().default(14),
  SCHOLARSHIP_MAX_PAGE_BYTES:     z.coerce.number().int().positive().default(5_000_000),
  SCHOLARSHIP_MAX_TARGETS_PER_RUN: z.coerce.number().int().positive().default(500),
  SCHOLARSHIP_USER_AGENT: z
    .string()
    .default('WraithScholarshipBot/1.0 (+https://example.org/bot; respects robots.txt)'),
  SCHOLARSHIP_RESPECT_ROBOTS:     z.string().optional(),
  SCHOLARSHIP_MIN_CONFIDENCE:     z.coerce.number().min(0).max(1).default(0.45),

  PLAYWRIGHT_ENABLED: z.string().optional(),
  PLAYWRIGHT_TIMEOUT: z.coerce.number().int().positive().default(30_000),

  AI_EXTRACTION_ENABLED: z.string().optional(),
  AI_PROVIDER: z.enum(['anthropic', 'openai', 'huggingface', 'none']).default('none'),
  AI_MODEL: z.string().default('claude-sonnet-4-6'),
  AI_API_KEY: z.string().optional(),
  AI_BASE_URL: z.string().url().optional(),
  AI_TIMEOUT: z.coerce.number().int().positive().default(60_000),
  AI_MAX_CALLS_PER_RUN: z.coerce.number().int().nonnegative().default(200),

  UNIVERSITY_DISCOVERY_ENABLED: z.string().optional(),
  UNIVERSITY_DISCOVERY_COUNTRIES: z.string().optional(),
  UNIVERSITY_DATASET_URL: z.string().url().optional(),

  // ── Scholarship site: paywall + advertising ──────────────────────────────
  SCHOLARSHIP_FREE_VIEWS_PER_MONTH: z.coerce.number().int().min(0).max(1000).default(5),
  SCHOLARSHIP_SITE_URL: z.string().url().optional(),
  ADS_ENABLED: z.string().optional(),
  ADS_NETWORK_CLIENT_ID: z.string().optional(),
  // ── Delivery: email (SMTP), WhatsApp (WAHA), Telegram ────────────────────
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
  // The private members-only group: broadcasts land here (existing behaviour)
  // AND the bot manages membership here (new) — same chat, one id. The bot
  // must be an admin with "invite users" and "ban users" rights. Numeric chat
  // id (looks like -1001234567890) — get it by adding the bot, posting once,
  // then checking the bot's getUpdates or forwarding a group message to
  // @userinfobot.
  SCHOLARSHIP_TELEGRAM_CHANNEL: z.string().optional(),
  // Human-clickable WhatsApp invite link kept only as an admin fallback — the
  // payment flow's primary path for Telegram is a per-user single-use link
  // generated against SCHOLARSHIP_TELEGRAM_CHANNEL, never a shared static one,
  // since a shared link would bypass the paywall entirely.
  SCHOLARSHIP_WHATSAPP_GROUP_INVITE_LINK: z.string().optional(),
});

const parsed = envSchema.parse(process.env);

export const env = {
  ...parsed,
  COOKIE_SECURE: parseBool(parsed.COOKIE_SECURE, parsed.NODE_ENV === 'production'),
  NGROK_API_URL: parsed.NGROK_API_URL ?? 'http://127.0.0.1:4040',

  // Scholarship engine booleans — all default OFF except robots compliance,
  // which defaults ON and should only be disabled for your own domains.
  SCHOLARSHIP_CRAWLER_ENABLED: parseBool(parsed.SCHOLARSHIP_CRAWLER_ENABLED, false),
  SCHOLARSHIP_RESPECT_ROBOTS: parseBool(parsed.SCHOLARSHIP_RESPECT_ROBOTS, true),
  PLAYWRIGHT_ENABLED: parseBool(parsed.PLAYWRIGHT_ENABLED, false),
  AI_EXTRACTION_ENABLED: parseBool(parsed.AI_EXTRACTION_ENABLED, false),
  UNIVERSITY_DISCOVERY_ENABLED: parseBool(parsed.UNIVERSITY_DISCOVERY_ENABLED, false),
  ADS_ENABLED: parseBool(parsed.ADS_ENABLED, true)
} as const;
