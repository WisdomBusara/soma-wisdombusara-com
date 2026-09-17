import { env } from '../../../config/env';
import { logger } from '../../../config/logger';
import type { EmailScholarship } from './email';

/**
 * Telegram delivery channel via the Bot API.
 *
 * Configured via SCHOLARSHIP_TELEGRAM_BOT_TOKEN (get one from @BotFather).
 * Telegram welcomes bots — no phone number, no ban risk, no linking dance. A
 * subscriber messages the bot once (so we learn their chat id), or you post to
 * a channel/group the bot administers via SCHOLARSHIP_TELEGRAM_CHANNEL.
 *
 * This is a self-contained sender; it does not run a polling loop. Chat ids are
 * captured via the webhook route (telegramInbound) and stored on the subscriber.
 */

function configured(): boolean {
  return Boolean(env.SCHOLARSHIP_TELEGRAM_BOT_TOKEN);
}

export function telegramConfigured(): boolean {
  return configured();
}

async function tgFetch(method: string, body: Record<string, unknown>): Promise<Response> {
  const token = env.SCHOLARSHIP_TELEGRAM_BOT_TOKEN!;
  return fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
}

/** Telegram MarkdownV2 requires escaping these characters. */
function esc(s: string): string {
  return s.replace(/[_*[\]()~`>#+\-=|{}.!]/g, (c) => `\\${c}`);
}

function renderMessage(scholarships: EmailScholarship[], siteUrl: string): string {
  const lines = scholarships.slice(0, 10).map((s) => {
    const title = `*${esc(s.title)}*`;
    const meta = esc(s.university ?? s.country ?? '');
    const deadline = s.deadline ? `\n📅 Closes ${esc(new Date(s.deadline).toLocaleDateString())}` : '';
    const link = `\n[View details](${siteUrl}/scholarships/${s.id})`;
    return `${title}\n${meta}${deadline}${link}`;
  });
  const header = `🎓 *${scholarships.length} new scholarship${scholarships.length === 1 ? '' : 's'}*\n\n`;
  return header + lines.join('\n\n');
}

export async function sendTelegram(
  chatId: string,
  scholarships: EmailScholarship[]
): Promise<{ ok: boolean; error?: string }> {
  if (!configured()) return { ok: false, error: 'telegram_not_configured' };
  if (scholarships.length === 0) return { ok: true };

  const siteUrl = (env.SCHOLARSHIP_SITE_URL ?? '').replace(/\/$/, '');
  try {
    const res = await tgFetch('sendMessage', {
      chat_id: chatId,
      text: renderMessage(scholarships, siteUrl),
      parse_mode: 'MarkdownV2',
      disable_web_page_preview: true
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      logger.warn({ status: res.status, body: body.slice(0, 200) }, 'scholarship-telegram: send failed');
      return { ok: false, error: `tg_${res.status}` };
    }
    return { ok: true };
  } catch (err: any) {
    logger.error({ err }, 'scholarship-telegram: send error');
    return { ok: false, error: String(err?.message ?? 'send_failed') };
  }
}

/** Post one batch to a configured channel/group the bot administers. */
export async function broadcastToChannel(scholarships: EmailScholarship[]): Promise<{ ok: boolean; error?: string }> {
  if (!env.SCHOLARSHIP_TELEGRAM_CHANNEL) return { ok: false, error: 'no_channel_configured' };
  return sendTelegram(env.SCHOLARSHIP_TELEGRAM_CHANNEL, scholarships);
}

/** Send a plain welcome message when someone first connects to the bot. */
export async function sendTelegramWelcome(chatId: string): Promise<void> {
  if (!configured()) return;
  const siteUrl = (env.SCHOLARSHIP_SITE_URL ?? '').replace(/\/$/, '');
  try {
    await tgFetch('sendMessage', {
      chat_id: chatId,
      text: `🎓 *Wisdom Busara Scholarships*\n\nYou are connected\\. You will receive new scholarships here as they are found\\.\n\n[Browse the site](${siteUrl}/scholarships)`,
      parse_mode: 'MarkdownV2',
      disable_web_page_preview: true
    });
  } catch (err) {
    logger.debug({ err }, 'scholarship-telegram: welcome failed');
  }
}

/**
 * Set the Telegram webhook so incoming messages hit our route. Call this once
 * at startup (idempotent on Telegram's side).
 */
export async function ensureTelegramWebhook(): Promise<void> {
  if (!configured() || !env.SCHOLARSHIP_SITE_URL) return;
  const url = `${env.SCHOLARSHIP_SITE_URL.replace(/\/$/, '')}/api/scholarship-telegram/webhook`;
  try {
    await tgFetch('setWebhook', { url, allowed_updates: ['message'] });
    logger.info({ url }, 'scholarship-telegram: webhook set');
  } catch (err) {
    logger.warn({ err }, 'scholarship-telegram: failed to set webhook');
  }
}
