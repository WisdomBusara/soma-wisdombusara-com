import { env } from '../../../config/env';
import { logger } from '../../../config/logger';
import { WhatsAppBotModel } from '../../../models/WhatsAppBot';
import { decryptString } from '../../../utils/encryption';
import type { EmailScholarship } from './email';

/**
 * WhatsApp delivery channel for the scholarships vertical, via WAHA.
 *
 * Reuses the SAME connected WAHA session as the Jobs/Tenders bot managed in
 * the admin panel — one phone number, one QR-scan flow — rather than a
 * second, separately-configured session. `scholarshipGroupId` on the active
 * WhatsAppBot record is the destination group for scholarship broadcasts and
 * paid-member adds; `groupId`/`tendersGroupId` on that same record drive
 * Jobs/Tenders (see jobScheduler.ts, waFulfillment.ts). Previously this
 * module pointed at its own WAHA_URL/WAHA_API_KEY/WAHA_SESSION/WAHA_GROUP_ID
 * env vars — an entirely separate, admin-panel-invisible WAHA session that
 * had to be reconnected and configured by hand.
 *
 * IMPORTANT OPERATIONAL NOTE: WAHA uses the unofficial WhatsApp Web protocol.
 * WhatsApp may ban numbers used for automation. This channel only works while
 * the linked number's WAHA session is WORKING. If it is not, sends fail
 * gracefully and are logged — they do not crash delivery to other channels.
 */

interface ActiveBot {
  wahaUrl: string;
  wahaSessionName: string;
  apiKey?: string;
  scholarshipGroupId?: string;
}

async function getActiveBot(): Promise<ActiveBot | null> {
  const bot = await WhatsAppBotModel.findOne({ isActive: true }).lean();
  if (!bot) return null;
  return {
    wahaUrl: bot.wahaUrl,
    wahaSessionName: bot.wahaSessionName,
    apiKey: bot.wahaApiKeyEnc ? decryptString(bot.wahaApiKeyEnc) : undefined,
    scholarshipGroupId: bot.scholarshipGroupId || undefined
  };
}

export async function whatsappConfigured(): Promise<boolean> {
  return (await getActiveBot()) !== null;
}

async function wahaFetch(bot: ActiveBot, path: string, init: RequestInit = {}): Promise<Response> {
  const url = `${bot.wahaUrl.replace(/\/$/, '')}${path}`;
  const headers = new Headers(init.headers ?? {});
  if (bot.apiKey) headers.set('X-Api-Key', bot.apiKey);
  if (init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  return fetch(url, { ...init, headers });
}

/** Is the WhatsApp session actually linked and working? */
export async function whatsappSessionWorking(): Promise<boolean> {
  const bot = await getActiveBot();
  if (!bot) return false;
  try {
    const res = await wahaFetch(bot, `/api/sessions/${bot.wahaSessionName}`);
    if (!res.ok) return false;
    const data = (await res.json()) as { status?: string };
    return data.status === 'WORKING';
  } catch {
    return false;
  }
}

/**
 * Format one batch of scholarships as a single WhatsApp message.
 * WhatsApp uses *bold*, _italic_. Keep it compact — long messages get truncated.
 */
function renderMessage(scholarships: EmailScholarship[], siteUrl: string): string {
  const lines = scholarships.slice(0, 10).map((s) => {
    const parts = [`*${s.title}*`];
    if (s.university || s.country) parts.push(s.university ?? s.country ?? '');
    if (s.deadline) parts.push(`📅 Closes ${new Date(s.deadline).toLocaleDateString()}`);
    parts.push(`${siteUrl}/scholarships/${s.id}`);
    return parts.join('\n');
  });
  const header = `🎓 *${scholarships.length} new scholarship${scholarships.length === 1 ? '' : 's'}*\n\n`;
  const footer = scholarships.length > 10 ? `\n\n_+ ${scholarships.length - 10} more on the site_` : '';
  return header + lines.join('\n\n') + footer;
}

/**
 * Send a scholarship batch to a chat id — the group JID normally, since
 * per-subscriber individual WhatsApp DMs are intentionally not a delivery
 * path (see subscriber.ts). Kept general (not group-only) in case a future
 * caller needs it, but nothing currently sends to an individual phone here.
 */
export async function sendWhatsAppToChat(
  chatId: string,
  scholarships: EmailScholarship[],
  preloadedBot?: ActiveBot
): Promise<{ ok: boolean; error?: string }> {
  const bot = preloadedBot ?? (await getActiveBot());
  if (!bot) return { ok: false, error: 'whatsapp_not_configured' };
  if (scholarships.length === 0) return { ok: true };

  const siteUrl = (env.SCHOLARSHIP_SITE_URL ?? '').replace(/\/$/, '');
  const text = renderMessage(scholarships, siteUrl);

  try {
    const res = await wahaFetch(bot, '/api/sendText', {
      method: 'POST',
      body: JSON.stringify({ session: bot.wahaSessionName, chatId, text })
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      logger.warn({ status: res.status, body: body.slice(0, 200) }, 'scholarship-whatsapp: send failed');
      return { ok: false, error: `waha_${res.status}` };
    }
    return { ok: true };
  } catch (err: any) {
    logger.error({ err }, 'scholarship-whatsapp: send error');
    return { ok: false, error: String(err?.message ?? 'send_failed') };
  }
}

/**
 * Broadcast one batch to the configured scholarships WhatsApp GROUP, if one
 * is set. This is the "paid members get added to the group" delivery path —
 * you add paying members to the group, and new scholarships post there.
 */
export async function broadcastToGroup(scholarships: EmailScholarship[]): Promise<{ ok: boolean; error?: string }> {
  const bot = await getActiveBot();
  if (!bot) return { ok: false, error: 'whatsapp_not_configured' };
  if (!bot.scholarshipGroupId) return { ok: false, error: 'no_group_configured' };
  return sendWhatsAppToChat(bot.scholarshipGroupId, scholarships, bot);
}

/**
 * Add a paying member directly into the configured scholarships WhatsApp group.
 *
 * Best-effort: WhatsApp lets a person restrict who can add them to groups, in
 * which case this fails even with a correctly configured session, so callers
 * must fall back to messaging the invite link rather than treating this as
 * the only path to "joined the group".
 */
export async function addToGroup(phone: string): Promise<{ ok: boolean; error?: string }> {
  const bot = await getActiveBot();
  if (!bot) return { ok: false, error: 'whatsapp_not_configured' };
  if (!bot.scholarshipGroupId) return { ok: false, error: 'no_group_configured' };

  const participantId = phone.includes('@') ? phone : `${phone.replace(/\D/g, '')}@c.us`;

  try {
    const res = await wahaFetch(bot, `/api/${bot.wahaSessionName}/groups/${encodeURIComponent(bot.scholarshipGroupId)}/participants/add`, {
      method: 'POST',
      body: JSON.stringify({ participants: [participantId] })
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      logger.warn({ status: res.status, body: body.slice(0, 200) }, 'scholarship-whatsapp: add to group failed');
      return { ok: false, error: `waha_${res.status}` };
    }
    return { ok: true };
  } catch (err: any) {
    logger.error({ err }, 'scholarship-whatsapp: add to group error');
    return { ok: false, error: String(err?.message ?? 'add_failed') };
  }
}

/** A plain text message to one number — used for the post-payment welcome. */
export async function sendWhatsAppText(phone: string, text: string): Promise<{ ok: boolean; error?: string }> {
  const bot = await getActiveBot();
  if (!bot) return { ok: false, error: 'whatsapp_not_configured' };
  const chatId = phone.includes('@') ? phone : `${phone.replace(/\D/g, '')}@c.us`;
  try {
    const res = await wahaFetch(bot, '/api/sendText', {
      method: 'POST',
      body: JSON.stringify({ session: bot.wahaSessionName, chatId, text })
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      logger.warn({ status: res.status, body: body.slice(0, 200) }, 'scholarship-whatsapp: text send failed');
      return { ok: false, error: `waha_${res.status}` };
    }
    return { ok: true };
  } catch (err: any) {
    logger.error({ err }, 'scholarship-whatsapp: text send error');
    return { ok: false, error: String(err?.message ?? 'send_failed') };
  }
}
