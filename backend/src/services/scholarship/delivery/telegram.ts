import { env } from '../../../config/env';
import { logger } from '../../../config/logger';
import type { EmailScholarship } from './email';
import { sendMessage as tgSendMessage, createSingleUseInviteLink, kickChatMember, unbanIfBanned } from '../../telegramApi';

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

export interface ScholarshipBotStatus {
  configured: boolean;
  botUsername?: string;
  botName?: string;
  channelId?: string;
  webhookUrl?: string;
  webhookOk?: boolean;
  pendingUpdateCount?: number;
  lastWebhookError?: string;
  error?: string;
}

/**
 * Live status for the admin panel — confirms the bot is actually reachable
 * (not just that a token is set) and that its webhook is registered where we
 * expect, rather than admins having to SSH in and check env vars + curl
 * getWebhookInfo by hand.
 */
export async function getScholarshipBotStatus(): Promise<ScholarshipBotStatus> {
  if (!configured()) return { configured: false };
  try {
    const [meRes, hookRes] = await Promise.all([
      tgFetch('getMe', {}),
      tgFetch('getWebhookInfo', {})
    ]);
    const me = await meRes.json();
    const hook = await hookRes.json();
    if (!me?.ok) return { configured: true, error: me?.description ?? 'getMe failed' };
    return {
      configured: true,
      botUsername: me.result?.username,
      botName: me.result?.first_name,
      channelId: env.SCHOLARSHIP_TELEGRAM_CHANNEL,
      webhookUrl: hook?.result?.url || undefined,
      webhookOk: Boolean(hook?.result?.url),
      pendingUpdateCount: hook?.result?.pending_update_count,
      lastWebhookError: hook?.result?.last_error_message || undefined
    };
  } catch (err: any) {
    return { configured: true, error: String(err?.message ?? 'status check failed') };
  }
}

/** A plain text message — used for command replies and enforcement notices. */
export async function sendTelegramText(chatId: string, text: string): Promise<{ ok: boolean; error?: string }> {
  if (!configured()) return { ok: false, error: 'telegram_not_configured' };
  try {
    await tgSendMessage(env.SCHOLARSHIP_TELEGRAM_BOT_TOKEN!, chatId, text);
    return { ok: true };
  } catch (err: any) {
    logger.error({ err }, 'scholarship-telegram: text send error');
    return { ok: false, error: String(err?.message ?? 'send_failed') };
  }
}

// ── Group membership (the private, paid group) ─────────────────────────────
//
// Telegram bots cannot silently add a specific person to a group — that is a
// platform-level anti-spam restriction, not a gap in this code. The only
// compliant path is a personal, single-use invite link the person clicks
// themselves, which is what sendPersonalGroupInvite hands out. Removal, on
// the other hand, a bot genuinely can do unattended: removeFromTelegramGroup
// bans then immediately unbans, which kicks them without a permanent ban, so
// a later renewal can invite them straight back in.

/**
 * Create and send a one-time invite link to the private group, valid until
 * the reader's access ends. Requires the bot to already have a private chat
 * with this user (they must have pressed /start or /connect first) — Telegram
 * does not let a bot message someone who has never opened a chat with it.
 */
export async function sendPersonalGroupInvite(chatId: string, expiresAt: Date): Promise<{ ok: boolean; error?: string }> {
  if (!configured() || !env.SCHOLARSHIP_TELEGRAM_CHANNEL) return { ok: false, error: 'group_not_configured' };
  const token = env.SCHOLARSHIP_TELEGRAM_BOT_TOKEN!;
  try {
    const expireSeconds = Math.max(60, Math.floor((expiresAt.getTime() - Date.now()) / 1000));
    const link = await createSingleUseInviteLink(token, env.SCHOLARSHIP_TELEGRAM_CHANNEL, expireSeconds);
    await tgSendMessage(
      token,
      chatId,
      `You're in! Here is your one-time link to the private scholarships group — it works once, for you only, and expires when your access does:\n\n${link}`
    );
    return { ok: true };
  } catch (err: any) {
    logger.error({ err }, 'scholarship-telegram: personal invite failed');
    return { ok: false, error: String(err?.message ?? 'invite_failed') };
  }
}

/** Remove a lapsed member from the group. Kicks (not a permanent ban). */
export async function removeFromTelegramGroup(chatId: string): Promise<{ ok: boolean; error?: string }> {
  if (!configured() || !env.SCHOLARSHIP_TELEGRAM_CHANNEL) return { ok: false, error: 'group_not_configured' };
  const token = env.SCHOLARSHIP_TELEGRAM_BOT_TOKEN!;
  const userId = Number(chatId);
  if (!Number.isFinite(userId)) return { ok: false, error: 'invalid_chat_id' };
  try {
    await kickChatMember(token, env.SCHOLARSHIP_TELEGRAM_CHANNEL, userId);
    await unbanIfBanned(token, env.SCHOLARSHIP_TELEGRAM_CHANNEL, userId);
    return { ok: true };
  } catch (err: any) {
    logger.error({ err }, 'scholarship-telegram: remove from group failed');
    return { ok: false, error: String(err?.message ?? 'remove_failed') };
  }
}
