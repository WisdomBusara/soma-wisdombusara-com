import { env } from '../../../config/env';
import { logger } from '../../../config/logger';
import type { EmailScholarship } from './email';

/**
 * WhatsApp delivery channel via WAHA (WhatsApp HTTP API).
 *
 * Sends to individual numbers OR a group, through a self-hosted WAHA instance.
 * Configured via env: WAHA_URL, WAHA_API_KEY, WAHA_SESSION (default 'default').
 *
 * IMPORTANT OPERATIONAL NOTE: WAHA uses the unofficial WhatsApp Web protocol.
 * WhatsApp may ban numbers used for automation. This channel only works while a
 * WhatsApp number is successfully linked to the WAHA session. If the session is
 * not WORKING, sends fail gracefully and are logged — they do not crash
 * delivery to other channels.
 */

function configured(): boolean {
  return Boolean(env.WAHA_URL && env.WAHA_API_KEY);
}

export function whatsappConfigured(): boolean {
  return configured();
}

async function wahaFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const url = `${env.WAHA_URL!.replace(/\/$/, '')}${path}`;
  const headers = new Headers(init.headers ?? {});
  headers.set('X-Api-Key', env.WAHA_API_KEY!);
  if (init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  return fetch(url, { ...init, headers });
}

/** Is the WhatsApp session actually linked and working? */
export async function whatsappSessionWorking(): Promise<boolean> {
  if (!configured()) return false;
  const session = env.WAHA_SESSION ?? 'default';
  try {
    const res = await wahaFetch(`/api/sessions/${session}`);
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
 * Send to a chat id. For an individual: '2547XXXXXXXX@c.us'. For a group:
 * 'XXXXXXXXXXXX@g.us'. This helper builds the individual form from a phone.
 */
export async function sendWhatsAppToPhone(
  phone: string,
  scholarships: EmailScholarship[]
): Promise<{ ok: boolean; error?: string }> {
  if (!configured()) return { ok: false, error: 'whatsapp_not_configured' };
  if (scholarships.length === 0) return { ok: true };
  const chatId = phone.includes('@') ? phone : `${phone.replace(/\D/g, '')}@c.us`;
  return sendWhatsAppToChat(chatId, scholarships);
}

export async function sendWhatsAppToChat(
  chatId: string,
  scholarships: EmailScholarship[]
): Promise<{ ok: boolean; error?: string }> {
  if (!configured()) return { ok: false, error: 'whatsapp_not_configured' };
  if (scholarships.length === 0) return { ok: true };

  const session = env.WAHA_SESSION ?? 'default';
  const siteUrl = (env.SCHOLARSHIP_SITE_URL ?? '').replace(/\/$/, '');
  const text = renderMessage(scholarships, siteUrl);

  try {
    const res = await wahaFetch('/api/sendText', {
      method: 'POST',
      body: JSON.stringify({ session, chatId, text })
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
 * Broadcast one batch to the configured WhatsApp GROUP, if one is set via
 * WAHA_GROUP_ID. This is the "paid members get added to the group" delivery
 * path — you add paying members to the group, and new scholarships post there.
 */
export async function broadcastToGroup(scholarships: EmailScholarship[]): Promise<{ ok: boolean; error?: string }> {
  if (!env.WAHA_GROUP_ID) return { ok: false, error: 'no_group_configured' };
  return sendWhatsAppToChat(env.WAHA_GROUP_ID, scholarships);
}
