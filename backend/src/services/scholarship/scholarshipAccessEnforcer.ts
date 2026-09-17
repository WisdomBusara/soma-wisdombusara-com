import { logger } from '../../config/logger';
import { env } from '../../config/env';
import { ScholarshipAccessModel } from '../../models/scholarship/access';
import { SubscriberModel } from '../../models/scholarship/subscriber';
import { removeFromTelegramGroup, sendTelegramText } from './delivery/telegram';

/**
 * Enforces the Telegram side of paid access: reminds a subscriber before
 * their plan lapses, and removes them from the group the moment it does.
 *
 * Mirrors SubscriptionEnforcer (the WhatsApp-bot vertical's equivalent) —
 * same short-interval-poll shape — rather than the once-a-day cron the rest
 * of the scholarship pipeline uses, because removal was chosen to be
 * immediate on expiry, and a daily check would leave lapsed members in the
 * group for up to 24 hours.
 */

const REMINDER_WINDOW_MS = 3 * 24 * 60 * 60 * 1000; // 3 days before endsAt

export class ScholarshipAccessEnforcer {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  start(intervalMs = 5 * 60_000): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.enforceAll().catch((err) => logger.error({ err }, 'ScholarshipAccessEnforcer failed'));
    }, intervalMs);
    this.enforceAll().catch((err) => logger.error({ err }, 'ScholarshipAccessEnforcer initial run failed'));
    logger.info({ intervalMs }, 'ScholarshipAccessEnforcer started');
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    logger.info('ScholarshipAccessEnforcer stopped');
  }

  async enforceAll(): Promise<{ reminded: number; removed: number }> {
    if (this.running) return { reminded: 0, removed: 0 };
    this.running = true;
    try {
      const reminded = await this.sendReminders();
      const removed = await this.removeExpired();
      return { reminded, removed };
    } finally {
      this.running = false;
    }
  }

  private async sendReminders(): Promise<number> {
    const now = new Date();
    const windowEnd = new Date(now.getTime() + REMINDER_WINDOW_MS);
    const dueGrants = await ScholarshipAccessModel.find({
      status: 'active',
      endsAt: { $gt: now, $lte: windowEnd }
    }).limit(200).lean();
    if (dueGrants.length === 0) return 0;

    const siteUrl = (env.SCHOLARSHIP_SITE_URL ?? '').replace(/\/$/, '');
    let count = 0;

    for (const grant of dueGrants) {
      const sub = await SubscriberModel.findOne({ accessId: grant._id });
      // A reminder is scoped to THIS period: compare against the grant's own
      // startsAt so a renewal's fresh period is never suppressed by a
      // reminder that was sent for the period before it.
      if (!sub?.telegramChatId) continue;
      if (sub.renewalReminderSentAt && sub.renewalReminderSentAt >= grant.startsAt) continue;

      const text = `Heads up — your Wisdom Busara Scholarships access ends ${new Date(grant.endsAt).toLocaleDateString()}. Top up to keep your spot in the group and unlimited access:\n\n${siteUrl}/upgrade`;
      const result = await sendTelegramText(sub.telegramChatId, text);
      if (result.ok) {
        sub.renewalReminderSentAt = now;
        await sub.save();
        count += 1;
      }
    }
    return count;
  }

  private async removeExpired(): Promise<number> {
    const now = new Date();
    const expired = await ScholarshipAccessModel.find({ status: 'active', endsAt: { $lte: now } }).limit(200).lean();
    if (expired.length === 0) return 0;

    const expiredIds = expired.map((g) => g._id);
    await ScholarshipAccessModel.updateMany({ _id: { $in: expiredIds } }, { $set: { status: 'expired' } });

    const siteUrl = (env.SCHOLARSHIP_SITE_URL ?? '').replace(/\/$/, '');
    let count = 0;

    for (const grant of expired) {
      const sub = await SubscriberModel.findOne({ accessId: grant._id });
      if (!sub?.telegramChatId) continue;

      const result = await removeFromTelegramGroup(sub.telegramChatId);
      if (result.ok) {
        await sendTelegramText(
          sub.telegramChatId,
          `Your access has ended, so you've been removed from the private group. Renew any time to rejoin:\n\n${siteUrl}/upgrade`
        ).catch(() => undefined);
        sub.removedFromGroupAt = now;
        await sub.save();
        count += 1;
        logger.info({ accessId: String(grant._id) }, 'scholarship-access-enforcer: expired, removed from group');
      } else {
        logger.warn({ accessId: String(grant._id), error: result.error }, 'scholarship-access-enforcer: group removal failed');
      }
    }
    return count;
  }
}
