import { logger } from '../config/logger';
import { BotModel } from '../models/Bot';
import { WhatsAppBotModel } from '../models/WhatsAppBot';
import { SubscriptionModel } from '../models/Subscription';
import { decryptString } from '../utils/encryption';
import { kickChatMember } from './telegramApi';
import { removeFromGroup } from './waha';

export class SubscriptionEnforcer {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  start(intervalMs = 60_000): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.enforceAll().catch((err) => logger.error({ err }, 'SubscriptionEnforcer failed'));
    }, intervalMs);
    this.enforceAll().catch((err) => logger.error({ err }, 'SubscriptionEnforcer initial run failed'));
    logger.info({ intervalMs }, 'SubscriptionEnforcer started');
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    logger.info('SubscriptionEnforcer stopped');
  }

  async enforceAll(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const now = new Date();
      const expired = await SubscriptionModel.find({ status: 'active', endsAt: { $lte: now } }).limit(200).lean();
      if (expired.length === 0) return;

      logger.info({ count: expired.length }, 'Processing expired subscriptions');
      const expiredIds = expired.map((s) => s._id);
      await SubscriptionModel.updateMany({ _id: { $in: expiredIds } }, { $set: { status: 'expired' } });

      for (const sub of expired) {
        try {
          const platform: string = (sub as any).platform ?? 'telegram';

          if (platform === 'whatsapp') {
            await this.revokeWhatsApp(sub, now);
          } else {
            await this.revokeTelegram(sub, now);
          }
        } catch (err: any) {
          const errMsg = String(err?.message ?? err);
          await SubscriptionModel.updateOne(
            { _id: sub._id },
            { $inc: { revokeAttempts: 1 }, $set: { lastRevokeError: errMsg } }
          );
          logger.warn({ err, sub: sub._id }, 'Failed to revoke expired subscription');
        }
      }
    } finally {
      this.running = false;
    }
  }

  private async revokeTelegram(sub: any, now: Date): Promise<void> {
    const bot = await BotModel.findById(sub.botId).lean();
    if (!bot || !bot.isActive) return;

    const stillActive = await SubscriptionModel.exists({
      platform: { $ne: 'whatsapp' }, botId: sub.botId,
      telegramUserId: sub.telegramUserId, status: 'active', endsAt: { $gt: now }
    });
    if (stillActive) return;

    const token = decryptString(bot.tokenEnc);
    await kickChatMember(token, bot.protectedChatId, sub.telegramUserId);
    logger.info({ botId: String(sub.botId), telegramUserId: sub.telegramUserId }, 'Kicked expired Telegram subscriber');
  }

  private async revokeWhatsApp(sub: any, now: Date): Promise<void> {
    const waBot = await WhatsAppBotModel.findById(sub.waBotId).lean();
    if (!waBot || !waBot.isActive) return;

    // whatsappChatId is the full JID (set on new subscriptions); older records only have whatsappPhone
    const chatId: string = String(sub.whatsappChatId ?? '');
    const phone: string = String(sub.whatsappPhone ?? '');
    const participantJid = chatId || (phone ? `${phone}@c.us` : '');
    if (!participantJid) return;

    // Don't kick if they have another active subscription for this bot
    const stillActive = await SubscriptionModel.exists({
      platform: 'whatsapp', waBotId: sub.waBotId,
      $or: [{ whatsappChatId: chatId || undefined }, { whatsappPhone: phone || undefined }],
      status: 'active', endsAt: { $gt: now }
    });
    if (stillActive) return;

    const apiKey = waBot.wahaApiKeyEnc ? decryptString(waBot.wahaApiKeyEnc) : undefined;
    await removeFromGroup(waBot.wahaUrl, waBot.wahaSessionName, ((sub as any).vertical === 'tenders' && (waBot as any).tendersGroupId) ? (waBot as any).tendersGroupId : waBot.groupId, participantJid, apiKey);
    logger.info({ waBotId: String(sub.waBotId), participantJid }, 'Removed expired WhatsApp subscriber from group');
  }
}
