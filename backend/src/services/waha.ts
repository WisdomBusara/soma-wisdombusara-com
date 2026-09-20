import axios, { type AxiosInstance } from 'axios';
import { env } from '../config/env';

function client(wahaUrl: string, apiKey?: string): AxiosInstance {
  const key = apiKey ?? env.WAHA_DEFAULT_API_KEY;
  return axios.create({
    baseURL: wahaUrl.replace(/\/$/, ''),
    timeout: 15_000,
    headers: key ? { 'X-Api-Key': key } : {}
  });
}

export function phoneToJid(phone: string): string {
  return `${phone.replace(/\D/g, '')}@c.us`;
}

export async function sendMessage(
  wahaUrl: string,
  session: string,
  chatId: string,
  text: string,
  apiKey?: string
): Promise<void> {
  await client(wahaUrl, apiKey).post('/api/sendText', { session, chatId, text });
}

/**
 * Resolve a GOWS LID to the contact's real phone number (digits only), or
 * null if the engine can't map it. Used so premium membership can be managed
 * by actual phone numbers in the portal.
 */
export async function lidToPhone(
  wahaUrl: string,
  session: string,
  lid: string,
  apiKey?: string
): Promise<string | null> {
  try {
    const resp = await client(wahaUrl, apiKey).get(
      `/api/${encodeURIComponent(session)}/lids/${encodeURIComponent(lid)}`
    );
    const pn = resp.data?.pn ?? resp.data?.phoneNumber ?? '';
    const digits = String(pn).replace(/\D/g, '');
    return digits.length >= 9 ? digits : null;
  } catch {
    return null;
  }
}

/** Send a message that @-mentions users. Text must contain `@<digits>` for each mentioned JID. */
export async function sendMessageWithMentions(
  wahaUrl: string,
  session: string,
  chatId: string,
  text: string,
  mentions: string[],
  apiKey?: string
): Promise<void> {
  await client(wahaUrl, apiKey).post('/api/sendText', { session, chatId, text, mentions });
}

/** Returns the raw participant result array so callers can inspect per-user error codes (e.g. 403 = invite-only). */
export async function addToGroup(
  wahaUrl: string,
  session: string,
  groupId: string,
  participantJid: string,
  apiKey?: string
): Promise<Array<{ id?: string; JID?: string; Error?: number; [k: string]: any }>> {
  try {
    const resp = await client(wahaUrl, apiKey).post(
      `/api/${encodeURIComponent(session)}/groups/${encodeURIComponent(groupId)}/participants/add`,
      { participants: [{ id: participantJid }] }
    );
    return Array.isArray(resp.data) ? resp.data : [];
  } catch (err: any) {
    if (err?.response?.status === 404) {
      // WEBJS fallback — doesn't return per-user errors, treat as success
      await client(wahaUrl, apiKey).put(
        `/api/${encodeURIComponent(session)}/groups/${encodeURIComponent(groupId)}/participants`,
        { action: 'add', participants: [participantJid] }
      );
      return [];
    }
    throw err;
  }
}

/** Returns the current group invite link (e.g. https://chat.whatsapp.com/XXX). */
export async function getGroupInviteLink(
  wahaUrl: string,
  session: string,
  groupId: string,
  apiKey?: string
): Promise<string> {
  const resp = await client(wahaUrl, apiKey).get(
    `/api/${encodeURIComponent(session)}/groups/${encodeURIComponent(groupId)}/invite-code`
  );
  const raw = resp.data;
  if (typeof raw === 'string') return raw;
  return String(raw?.inviteCode ?? raw?.code ?? raw ?? '');
}

/** Revokes the current invite link and returns the new one. */
export async function revokeGroupInviteLink(
  wahaUrl: string,
  session: string,
  groupId: string,
  apiKey?: string
): Promise<string> {
  const resp = await client(wahaUrl, apiKey).post(
    `/api/${encodeURIComponent(session)}/groups/${encodeURIComponent(groupId)}/invite-code/revoke`,
    {}
  );
  const raw = resp.data;
  if (typeof raw === 'string') return raw;
  return String(raw?.inviteCode ?? raw?.code ?? raw ?? '');
}

export async function removeFromGroup(
  wahaUrl: string,
  session: string,
  groupId: string,
  participantJid: string,
  apiKey?: string
): Promise<void> {
  try {
    await client(wahaUrl, apiKey).post(
      `/api/${encodeURIComponent(session)}/groups/${encodeURIComponent(groupId)}/participants/remove`,
      { participants: [{ id: participantJid }] }
    );
  } catch (err: any) {
    if (err?.response?.status === 404) {
      await client(wahaUrl, apiKey).put(
        `/api/${encodeURIComponent(session)}/groups/${encodeURIComponent(groupId)}/participants`,
        { action: 'remove', participants: [participantJid] }
      );
    } else {
      throw err;
    }
  }
}

export async function getSessionStatus(
  wahaUrl: string,
  session: string,
  apiKey?: string
): Promise<{ status: string }> {
  try {
    const resp = await client(wahaUrl, apiKey).get(`/api/sessions/${encodeURIComponent(session)}`);
    return { status: String(resp.data?.status ?? 'STOPPED') };
  } catch {
    return { status: 'STOPPED' };
  }
}

export async function startSession(
  wahaUrl: string,
  session: string,
  apiKey?: string,
  webhookUrl?: string
): Promise<void> {
  const c = client(wahaUrl, apiKey);
  // Delete any existing session (handles FAILED/STOPPED state cleanly)
  try { await c.delete(`/api/sessions/${encodeURIComponent(session)}`); } catch { /* ok if not found */ }
  // Create fresh session with start:true — GOWS/WEBJS will generate a new QR.
  // A DELETE+recreate wipes any previously configured webhook, so it's
  // re-supplied inline here — recreating a session must never leave it
  // webhook-less, or the bot silently stops responding until someone
  // remembers to click "Configure Webhook" by hand.
  const body: Record<string, unknown> = { name: session, start: true };
  if (webhookUrl) body.config = { webhooks: [{ url: webhookUrl, events: ['message', 'message.any'] }] };
  await c.post('/api/sessions', body);
}

export async function configureWebhook(
  wahaUrl: string,
  session: string,
  webhookUrl: string,
  apiKey?: string
): Promise<void> {
  const c = client(wahaUrl, apiKey);
  // Try the sessions config endpoint (WAHA v2+)
  try {
    await c.put(`/api/sessions/${encodeURIComponent(session)}/config`, {
      webhooks: [{ url: webhookUrl, events: ['message', 'message.any'] }]
    });
    return;
  } catch { /* fall through to legacy endpoint */ }
  // Fallback for older WAHA builds
  await c.put(`/api/${encodeURIComponent(session)}/config/webhooks`, {
    url: webhookUrl,
    events: ['message', 'message.any']
  });
}

export async function getQR(
  wahaUrl: string,
  session: string,
  apiKey?: string
): Promise<string> {
  // GOWS engine returns PNG directly; WEBJS accepts format=image. Try both.
  const resp = await client(wahaUrl, apiKey).get(
    `/api/${encodeURIComponent(session)}/auth/qr`,
    { responseType: 'arraybuffer' }
  );
  return `data:image/png;base64,${Buffer.from(resp.data as ArrayBuffer).toString('base64')}`;
}
