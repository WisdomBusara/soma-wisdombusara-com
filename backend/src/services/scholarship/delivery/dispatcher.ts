import { env } from '../../../config/env';
import { logger } from '../../../config/logger';
import { ScholarshipModel } from '../../../models/scholarship/Scholarship';
import { ScholarshipAccessModel } from '../../../models/scholarship/access';
import { SubscriberModel, DeliveryLogModel } from '../../../models/scholarship/subscriber';
import { sendScholarshipEmail, emailConfigured, type EmailScholarship } from './email';
import { sendWhatsAppToPhone, broadcastToGroup, whatsappConfigured } from './whatsapp';
import { sendTelegram, broadcastToChannel, telegramConfigured } from './telegram';

/**
 * Delivery dispatcher.
 *
 * Runs after each crawl cycle. For every active subscriber, it finds
 * scholarships they have not yet received (matching their filters), and sends
 * them on each channel they chose. A per-(subscriber, scholarship, channel)
 * unique log row guarantees nothing is ever sent twice.
 *
 * Also supports GROUP broadcast: if a WhatsApp group or Telegram channel is
 * configured, new scholarships post there once per batch — this is the "paid
 * members are in the group, new scholarships appear" model.
 *
 * Delivery is best-effort and isolated: one subscriber's failure, or one
 * channel being down, never stops the others.
 */

export function toEmailShape(s: any): EmailScholarship {
  return {
    id: String(s._id),
    title: s.title,
    university: s.universityName ?? null,
    country: s.country ?? null,
    deadline: s.deadline?.date ? new Date(s.deadline.date).toISOString() : null,
    fundingType: s.funding?.primaryType ?? 'UNKNOWN',
    url: `${(env.SCHOLARSHIP_SITE_URL ?? '').replace(/\/$/, '')}/scholarships/${String(s._id)}`
  };
}

/** Build a Mongo filter for a subscriber's preferences. */
function subscriberFilter(sub: any): Record<string, unknown> {
  const filter: Record<string, unknown> = { status: { $in: ['OPEN', 'CLOSING_SOON'] } };
  if (sub.countries?.length) filter.countryCode = { $in: sub.countries };
  if (sub.degreeLevels?.length) filter.degreeLevels = { $in: sub.degreeLevels };
  if (sub.fundingOnly) filter['funding.primaryType'] = 'FULLY_FUNDED';
  return filter;
}

export interface DispatchSummary {
  subscribers: number;
  emailsSent: number;
  whatsappSent: number;
  telegramSent: number;
  groupBroadcast: boolean;
  telegramBroadcast: boolean;
  failures: number;
}

/**
 * Deliver eligible scholarships to all active subscribers, plus the group/
 * channel broadcast.
 *
 * Eligibility is "never delivered on this channel before", not "created
 * recently" — a scholarship discovered weeks ago that only just cleared
 * review (or crossed the confidence bar) still needs to reach everyone
 * exactly once. Per-subscriber sends dedup via DeliveryLog; the group/channel
 * broadcast dedups via Scholarship.groupBroadcastAt / telegramBroadcastAt.
 *
 * @param maxPerSubscriber cap how many scholarships one subscriber gets per run,
 *                     so a big backlog does not spam anyone
 */
export async function dispatchDeliveries(
  opts: { maxPerSubscriber?: number; dryRun?: boolean } = {}
): Promise<DispatchSummary> {
  const maxPer = opts.maxPerSubscriber ?? 15;

  const summary: DispatchSummary = {
    subscribers: 0,
    emailsSent: 0,
    whatsappSent: 0,
    telegramSent: 0,
    groupBroadcast: false,
    telegramBroadcast: false,
    failures: 0
  };

  // ── Group broadcast (WhatsApp) — anything OPEN/CLOSING_SOON not yet posted ──
  const groupPending = await ScholarshipModel.find({
    status: { $in: ['OPEN', 'CLOSING_SOON'] },
    groupBroadcastAt: null
  })
    .sort({ createdAt: -1 })
    .limit(15)
    .lean();

  if (groupPending.length > 0 && !opts.dryRun && (await whatsappConfigured())) {
    const r = await broadcastToGroup(groupPending.map(toEmailShape)).catch(() => ({ ok: false }));
    if (r.ok) {
      summary.groupBroadcast = true;
      await ScholarshipModel.updateMany(
        { _id: { $in: groupPending.map((s: any) => s._id) } },
        { $set: { groupBroadcastAt: new Date() } }
      );
    }
  }

  // ── Channel broadcast (Telegram) — same pattern, independent dedup field ──
  const telegramPending = await ScholarshipModel.find({
    status: { $in: ['OPEN', 'CLOSING_SOON'] },
    telegramBroadcastAt: null
  })
    .sort({ createdAt: -1 })
    .limit(15)
    .lean();

  if (telegramPending.length > 0 && !opts.dryRun && env.SCHOLARSHIP_TELEGRAM_CHANNEL && telegramConfigured()) {
    const r = await broadcastToChannel(telegramPending.map(toEmailShape)).catch(() => ({ ok: false }));
    if (r.ok) {
      summary.telegramBroadcast = true;
      await ScholarshipModel.updateMany(
        { _id: { $in: telegramPending.map((s: any) => s._id) } },
        { $set: { telegramBroadcastAt: new Date() } }
      );
    }
  }

  // ── Per-subscriber personalised delivery ────────────────────────────────────
  const subs = await SubscriberModel.find({ status: 'active', channels: { $ne: [] } }).lean();
  summary.subscribers = subs.length;

  for (const sub of subs) {
    try {
      // Access lapsed? pause delivery.
      if (sub.accessId) {
        const grant = await ScholarshipAccessModel.findById(sub.accessId).select('status endsAt').lean();
        if (!grant || grant.status !== 'active' || new Date(grant.endsAt).getTime() < Date.now()) {
          await SubscriberModel.updateOne({ _id: sub._id }, { $set: { status: 'expired' } });
          continue;
        }
      }

      // Candidate scholarships for this subscriber, newest first. Not
      // time-windowed — DeliveryLog below is the dedup, so a scholarship
      // that only just became eligible still reaches them regardless of
      // when it was originally discovered.
      const candidates = await ScholarshipModel.find(subscriberFilter(sub))
        .sort({ createdAt: -1 })
        .limit(maxPer * 2)
        .lean();

      if (candidates.length === 0) continue;

      // Filter out anything already delivered to this subscriber (any channel).
      const already = await DeliveryLogModel.find({
        subscriberId: sub._id,
        scholarshipId: { $in: candidates.map((c: any) => c._id) }
      })
        .select('scholarshipId')
        .lean();
      const sentIds = new Set(already.map((a: any) => String(a.scholarshipId)));
      const fresh = candidates.filter((c: any) => !sentIds.has(String(c._id))).slice(0, maxPer);
      if (fresh.length === 0) continue;

      const shaped = fresh.map(toEmailShape);
      if (opts.dryRun) continue;

      // Deliver on each chosen channel.
      const channels: string[] = sub.channels ?? [];

      if (channels.includes('email') && sub.email && emailConfigured()) {
        const r = await sendScholarshipEmail(sub.email, shaped);
        await logDeliveries(sub._id, fresh, 'email', r);
        if (r.ok) summary.emailsSent += 1; else summary.failures += 1;
      }

      if (channels.includes('whatsapp') && sub.whatsappPhone && (await whatsappConfigured())) {
        const r = await sendWhatsAppToPhone(sub.whatsappPhone, shaped);
        await logDeliveries(sub._id, fresh, 'whatsapp', r);
        if (r.ok) summary.whatsappSent += 1; else summary.failures += 1;
      }

      if (channels.includes('telegram') && sub.telegramChatId && telegramConfigured()) {
        const r = await sendTelegram(sub.telegramChatId, shaped);
        await logDeliveries(sub._id, fresh, 'telegram', r);
        if (r.ok) summary.telegramSent += 1; else summary.failures += 1;
      }

      await SubscriberModel.updateOne(
        { _id: sub._id },
        { $set: { lastDeliveredAt: new Date() }, $inc: { deliveredCount: fresh.length } }
      );
    } catch (err) {
      summary.failures += 1;
      logger.error({ err, subscriber: String(sub._id) }, 'scholarship-delivery: subscriber failed');
    }
  }

  logger.info({ summary }, 'scholarship-delivery: dispatch complete');
  return summary;
}

/** Write per-scholarship delivery log rows (idempotent via unique index). */
async function logDeliveries(
  subscriberId: any,
  scholarships: any[],
  channel: 'email' | 'whatsapp' | 'telegram',
  result: { ok: boolean; error?: string }
): Promise<void> {
  const rows = scholarships.map((s) => ({
    subscriberId,
    scholarshipId: s._id,
    channel,
    status: result.ok ? 'sent' : 'failed',
    error: result.error,
    sentAt: new Date()
  }));
  // insertMany with ordered:false so a duplicate (already-sent) does not abort
  // the rest; duplicates are silently skipped by the unique index.
  await DeliveryLogModel.insertMany(rows, { ordered: false }).catch(() => undefined);
}
