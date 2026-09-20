import { Types } from 'mongoose';
import { logger } from '../config/logger';
import { JobModel } from '../models/Job';
import { SubscriptionModel } from '../models/Subscription';
import { decryptString } from '../utils/encryption';
import {
  addToGroup, revokeGroupInviteLink,
  sendMessage as wahaSend, sendMessageWithMentions
} from './waha';

// Shared WhatsApp access fulfillment — used by the Paystack webhook (paid plans)
// and the bot runner (free trials). Grants the subscription, adds the member to
// the group, @-welcomes them, and replays the last digest so late joiners
// aren't a day behind.

export interface GrantAccessArgs {
  waBot: any;                 // WhatsAppBot lean doc
  plan: any;                  // Plan lean doc
  phone: string;
  chatId: string;             // full JID (…@c.us or …@lid)
  reference: string;
  botId?: Types.ObjectId;     // placeholder ObjectId for WA-platform payments
  vertical?: 'jobs' | 'tenders' | 'scholarships';  // which group the plan grants (default jobs)
}

/** The group JID a vertical grants access to. */
export function groupForVertical(waBot: any, vertical?: 'jobs' | 'tenders' | 'scholarships'): string {
  if (vertical === 'tenders') return waBot.tendersGroupId || waBot.groupId;
  if (vertical === 'scholarships') return waBot.scholarshipGroupId || waBot.groupId;
  return waBot.groupId;
}

/**
 * Digest of jobs first seen in the last 24h — what the 07:00 report covered.
 * Scholarships have no JobModel entries, so this is a graceful no-op (null)
 * for that vertical — the group broadcast/dispatch cycle is scholarships'
 * equivalent catch-up mechanism, not this post-join digest.
 */
export async function buildRecentDigest(vertical: 'jobs' | 'tenders' | 'scholarships' = 'jobs'): Promise<string | null> {
  if (vertical === 'scholarships') return null;
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const jobs = await JobModel.find({ firstSeenAt: { $gte: since }, ...(vertical === 'jobs' ? { $or: [{ vertical: 'jobs' }, { vertical: { $exists: false } }] } : { vertical }) })
    .sort({ bankName: 1 })
    .limit(60)
    .lean();
  if (jobs.length === 0) return null;

  const byCompany: Record<string, typeof jobs> = {};
  for (const j of jobs) (byCompany[j.bankName] ??= []).push(j);

  let msg = `🗞️ *Catch-up — what Wisdom Busara found in the last 24 hours:*\n\n`;
  for (const [company, list] of Object.entries(byCompany)) {
    msg += `*${company}*\n`;
    for (const j of list.slice(0, 5)) msg += `• ${j.title}\n  ${j.url}\n`;
    if (list.length > 5) msg += `_…and ${list.length - 5} more_\n`;
    msg += '\n';
  }
  msg += `_Your daily digest lands at 07:00 EAT._`;
  return msg.trim();
}

/** @-mention the new member in the group. */
export async function welcomeToGroup(waBot: any, chatId: string, apiKey?: string, groupJid?: string): Promise<void> {
  const handle = chatId.split('@')[0];
  try {
    await sendMessageWithMentions(
      waBot.wahaUrl, waBot.wahaSessionName, groupJid || waBot.groupId,
      `👋 @${handle} — welcome to *Wisdom Busara*.`,
      [chatId],
      apiKey
    );
  } catch (err) {
    logger.warn({ err, chatId }, 'Failed to send group welcome mention');
  }
}

export interface GrantResult {
  addedDirectly: boolean;
  inviteLink?: string;
}

/**
 * Upsert the subscription and add the member to the group.
 * Returns how they got in; caller composes the confirmation DM.
 */
export async function grantWhatsAppAccess(args: GrantAccessArgs): Promise<GrantResult> {
  const { waBot, plan, phone, chatId, reference, vertical = 'jobs' } = args;
  const groupJid = groupForVertical(waBot, vertical);
  const now = new Date();
  const durationMs = plan.durationMinutes * 60_000;
  const apiKey = waBot.wahaApiKeyEnc ? decryptString(waBot.wahaApiKeyEnc) : undefined;

  const existing = await SubscriptionModel.findOne({
    platform: 'whatsapp', waBotId: waBot._id, whatsappPhone: phone, status: 'active', endsAt: { $gt: now },
    $or: [{ vertical }, ...(vertical === 'jobs' ? [{ vertical: { $exists: false } }] : [])]
  }).sort({ endsAt: -1 });
  if (existing) {
    existing.endsAt = new Date(existing.endsAt.getTime() + durationMs);
    existing.paystackReference = reference;
    (existing as any).whatsappChatId = chatId;
    await existing.save();
  } else {
    await SubscriptionModel.create({
      botId: args.botId ?? new Types.ObjectId('000000000000000000000000'),
      planId: plan._id, telegramUserId: 0,
      startsAt: now, endsAt: new Date(now.getTime() + durationMs),
      status: 'active', paystackReference: reference,
      platform: 'whatsapp', waBotId: waBot._id, whatsappPhone: phone, whatsappChatId: chatId, vertical
    });
  }

  // Add to group — invite-link fallback when the user blocks direct adds (403)
  let addedDirectly = false;
  let inviteLink: string | undefined;
  try {
    const results = await addToGroup(waBot.wahaUrl, waBot.wahaSessionName, groupJid, chatId, apiKey);
    const restricted = results.some((r) => r.Error === 403);
    if (restricted) {
      inviteLink = await revokeGroupInviteLink(waBot.wahaUrl, waBot.wahaSessionName, groupJid, apiKey);
      setTimeout(async () => {
        try { await revokeGroupInviteLink(waBot.wahaUrl, waBot.wahaSessionName, groupJid, apiKey); }
        catch (e) { logger.warn({ e }, 'Failed to revoke WA invite link'); }
      }, 5 * 60 * 1000);
    } else {
      addedDirectly = true;
    }
  } catch (err) {
    logger.error({ err, chatId }, 'Failed to add WA user to group');
  }

  // Welcome them in the group, then DM the catch-up digest.
  // Both are best-effort — access is already granted.
  if (addedDirectly) await welcomeToGroup(waBot, chatId, apiKey, groupJid);

  try {
    const digest = await buildRecentDigest(vertical);
    if (digest) await wahaSend(waBot.wahaUrl, waBot.wahaSessionName, chatId, digest, apiKey);
  } catch (err) {
    logger.warn({ err, chatId }, 'Failed to send catch-up digest');
  }

  return { addedDirectly, inviteLink };
}
