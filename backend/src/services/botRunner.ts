import { Markup, Telegraf, type Context } from 'telegraf';
import { nanoid } from 'nanoid';
import { Types } from 'mongoose';

import { env } from '../config/env';
import { logger } from '../config/logger';
import { BotModel, type Bot } from '../models/Bot';
import { ContentModel } from '../models/Content';
import { PaymentModel } from '../models/Payment';
import { PlanModel } from '../models/Plan';
import { QueryModel } from '../models/Query';
import { SubscriptionModel } from '../models/Subscription';
import { TelegramUserModel } from '../models/TelegramUser';
import { decryptString } from '../utils/encryption';
import { getNgrokPublicBaseUrl } from '../utils/ngrok';
import { initializeTransaction, chargeMpesa } from './paystack';

type PendingState =
  | { kind: 'awaitPaymentMethod'; botId: string; planId: string }
  | { kind: 'awaitPhone'; botId: string; planId: string }
  | { kind: 'awaitSupport'; botId: string };

function formatMoney(amountMinor: number, currency: string): string {
  const code = (currency || '').toUpperCase();
  const symbol = code === 'NGN' ? '₦' : code === 'KES' ? 'KSh ' : code === 'GHS' ? '₵' : code === 'ZAR' ? 'R' : code === 'USD' ? '$' : code === 'EUR' ? '€' : `${code} `;
  return `${symbol}${(amountMinor / 100).toFixed(2)}`;
}

function subscribePromptMarkup() {
  return Markup.inlineKeyboard([Markup.button.callback('View plans & Subscribe', 'subscribe:prompt')]);
}

/** Normalise Kenyan phone to +254XXXXXXXXX */
function normaliseKenyanPhone(raw: string): string | null {
  const digits = raw.replace(/\D/g, '');
  if (digits.startsWith('254') && digits.length === 12) return `+${digits}`;
  if (digits.startsWith('0') && digits.length === 10) return `+254${digits.slice(1)}`;
  if (digits.length === 9) return `+254${digits}`;
  return null;
}

/** Placeholder email for Paystack when we don't collect it from the user */
function placeholderEmail(telegramUserId: number): string {
  return `tg${telegramUserId}@wraith.pay`;
}

export class BotRunner {
  private bots = new Map<string, Telegraf<Context>>();
  private syncTimer: NodeJS.Timeout | null = null;
  private pending = new Map<string, PendingState>();

  async start(): Promise<void> {
    await this.syncBots();
    this.syncTimer = setInterval(() => {
      this.syncBots().catch((err) => logger.error({ err }, 'Bot sync failed'));
    }, 60_000);
  }

  stop(): void {
    if (this.syncTimer) clearInterval(this.syncTimer);
    this.syncTimer = null;
    for (const [botId, bot] of this.bots.entries()) {
      try { bot.stop('shutdown'); } catch { }
      this.bots.delete(botId);
    }
  }

  isRunning(botId: string): boolean { return this.bots.has(botId); }

  async syncBots(): Promise<void> {
    const activeBots = await BotModel.find({ isActive: true }).lean();
    const activeIds = new Set(activeBots.map((b) => String(b._id)));
    for (const botId of Array.from(this.bots.keys())) {
      if (!activeIds.has(botId)) {
        try { this.bots.get(botId)?.stop('disabled'); } catch { }
        this.bots.delete(botId);
        logger.warn({ botId }, 'Bot stopped');
      }
    }
    for (const botDoc of activeBots) {
      const botId = String(botDoc._id);
      if (this.bots.has(botId)) continue;
      try { await this.startBot(botDoc); } catch (err) {
        logger.error({ err, botId, name: botDoc.name }, 'Failed to start bot');
      }
    }
  }

  async startBot(botDoc: Bot): Promise<void> {
    const botId = String((botDoc as any)._id);
    const token = decryptString(botDoc.tokenEnc);
    const bot = new Telegraf(token);
    this.registerHandlers(bot, botId, botDoc.protectedChatId);

    if (env.TELEGRAM_MODE === 'polling') {
      await bot.launch({ dropPendingUpdates: true });
      logger.info({ botId, name: botDoc.name }, 'Telegram bot launched (polling)');
    } else {
      let baseUrl = env.TELEGRAM_WEBHOOK_BASE_URL;
      if (!baseUrl) baseUrl = await getNgrokPublicBaseUrl();
      if (!baseUrl) throw Object.assign(new Error('TELEGRAM_WEBHOOK_BASE_URL required'), { status: 500 });
      baseUrl = baseUrl.replace(/\/$/, '');
      const hookPath = `/telegram/webhook/${botId}/${botDoc.webhookSecret}`;
      const url = `${baseUrl}${hookPath}`;
      for (let attempt = 1; attempt <= 5; attempt++) {
        try {
          await bot.telegram.setWebhook(url);
          logger.info({ botId, url }, 'Telegram webhook set');
          break;
        } catch (err: any) {
          const retryAfter = Number(err?.response?.parameters?.retry_after ?? 0);
          const isRateLimit = String(err?.message ?? '').includes('429') || err?.response?.error_code === 429;
          if (isRateLimit && attempt < 5) {
            const waitSec = Math.max(1, Math.min(30, retryAfter || attempt));
            await new Promise((r) => setTimeout(r, waitSec * 1000));
            continue;
          }
          throw err;
        }
      }
    }
    this.bots.set(botId, bot);
  }

  getWebhookHandler(botId: string): ((update: any) => Promise<void>) | null {
    const bot = this.bots.get(botId);
    if (!bot) return null;
    return async (update: any) => { await bot.handleUpdate(update); };
  }

  private registerHandlers(bot: Telegraf<Context>, botId: string, protectedChatId: string) {
    bot.use(async (ctx, next) => {
      const from = ctx.from;
      if (from) {
        await TelegramUserModel.updateOne(
          { telegramUserId: from.id },
          { $set: { telegramUserId: from.id, username: from.username, firstName: from.first_name, lastName: from.last_name, lastSeenAt: new Date() } },
          { upsert: true }
        );
      }
      return next();
    });

    bot.start(async (ctx) => {
      const name = ctx.from?.first_name ?? 'there';
      await ctx.reply(
        `Hey ${name}! Welcome.\n\nI sell exclusive video content. Choose a plan and get instant access.`,
        subscribePromptMarkup()
      );
    });

    bot.command('help', async (ctx) => {
      await ctx.reply('Commands:\n/subscribe — view plans\n/status — check your subscription\n/content — latest content\n/support — contact support');
    });

    bot.command('subscribe', async (ctx) => { return this.sendPlans(ctx); });

    bot.action('subscribe:prompt', async (ctx) => {
      await ctx.answerCbQuery();
      return this.sendPlans(ctx);
    });

    // Plan selected → ask payment method
    bot.action(/^plan:(.+)$/, async (ctx) => {
      try {
        const planId = String((ctx.match as any)[1] ?? '');
        if (!Types.ObjectId.isValid(planId)) { await ctx.answerCbQuery('Invalid plan'); return; }
        const plan = await PlanModel.findById(planId).lean();
        if (!plan || !plan.isActive) { await ctx.answerCbQuery('Plan not available'); return; }
        try { await ctx.answerCbQuery('Selected'); } catch (err) {
          logger.warn({ err, botId, planId }, 'Failed to ack plan callback');
        }
        const userId = ctx.from?.id;
        if (!userId) return;

        this.pending.set(`${botId}:${userId}`, { kind: 'awaitPaymentMethod', botId, planId });

        return ctx.reply(
          `You selected *${plan.name}* — ${formatMoney(plan.amountKobo, plan.currency)}.\n\nHow would you like to pay?`,
          {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([
              [Markup.button.callback('📱 M-Pesa', `pay:mpesa:${planId}`)],
              [Markup.button.callback('💳 Card / Bank', `pay:card:${planId}`)]
            ])
          }
        );
      } catch (err) {
        logger.error({ err }, 'plan action failed');
      }
    });

    // Card payment
    bot.action(/^pay:card:(.+)$/, async (ctx) => {
      try {
        await ctx.answerCbQuery('Opening checkout…');
        const planId = String((ctx.match as any)[1] ?? '');
        const userId = ctx.from?.id;
        if (!userId || !Types.ObjectId.isValid(planId)) return;
        const key = `${botId}:${userId}`;
        this.pending.delete(key);
        return this.startCardFlow({ ctx, botId, planId, userId });
      } catch (err) {
        logger.error({ err }, 'pay:card action failed');
      }
    });

    // M-Pesa payment — ask for phone
    bot.action(/^pay:mpesa:(.+)$/, async (ctx) => {
      try {
        await ctx.answerCbQuery('M-Pesa selected');
        const planId = String((ctx.match as any)[1] ?? '');
        const userId = ctx.from?.id;
        if (!userId || !Types.ObjectId.isValid(planId)) return;
        this.pending.set(`${botId}:${userId}`, { kind: 'awaitPhone', botId, planId });
        return ctx.reply('Enter your Kenyan mobile number (e.g. 0712345678 or +254712345678):');
      } catch (err) {
        logger.error({ err }, 'pay:mpesa action failed');
      }
    });

    bot.command('status', async (ctx) => {
      const userId = ctx.from?.id;
      if (!userId) return;
      const now = new Date();
      const sub = await SubscriptionModel.findOne({ botId, telegramUserId: userId, endsAt: { $gt: now }, status: 'active' }).sort({ endsAt: -1 }).lean();
      if (!sub) return ctx.reply('No active subscription. Use /subscribe to get access.');
      const remaining = Math.ceil((new Date(sub.endsAt).getTime() - now.getTime()) / 60_000);
      const hours = Math.floor(remaining / 60);
      const mins = remaining % 60;
      const label = hours > 0 ? `${hours}h ${mins}m` : `${mins}m`;
      return ctx.reply(`Active subscription — ${label} remaining.\nExpires: ${new Date(sub.endsAt).toUTCString()}`);
    });

    bot.command('content', async (ctx) => {
      const latest = await ContentModel.findOne({ botId, isActive: true }).sort({ createdAt: -1 }).lean();
      if (!latest) return ctx.reply('No content yet. Subscribe to get access!');
      return ctx.reply(`*${latest.title}*\n\n${latest.body}`, { parse_mode: 'Markdown' });
    });

    bot.command('support', async (ctx) => {
      const userId = ctx.from?.id;
      if (!userId) return;
      const text = ctx.message && 'text' in ctx.message ? String(ctx.message.text ?? '') : '';
      const parts = text.split(' ').slice(1).join(' ').trim();
      if (parts.length >= 5) {
        await QueryModel.create({ botId, telegramUserId: userId, text: parts, status: 'open' });
        return ctx.reply('Got it! We\'ll get back to you soon.');
      }
      this.pending.set(`${botId}:${userId}`, { kind: 'awaitSupport', botId });
      return ctx.reply('What do you need help with? Type your message:');
    });

    bot.on('text', async (ctx) => {
      const userId = ctx.from?.id;
      if (!userId) return;
      const key = `${botId}:${userId}`;
      const pending = this.pending.get(key);
      if (!pending) {
        return ctx.reply('Hey! Ready to subscribe?', subscribePromptMarkup());
      }
      const msgText = String(ctx.message.text ?? '').trim();

      if (pending.kind === 'awaitPhone') {
        const phone = normaliseKenyanPhone(msgText);
        if (!phone) {
          return ctx.reply('That doesn\'t look like a valid Kenyan number. Try again (e.g. 0712345678):');
        }
        this.pending.delete(key);
        return this.startMpesaFlow({ ctx, botId, planId: pending.planId, userId, phone });
      }

      if (pending.kind === 'awaitSupport') {
        if (msgText.length < 5) return ctx.reply('Please add more detail to your message.');
        await QueryModel.create({ botId, telegramUserId: userId, text: msgText, status: 'open' });
        this.pending.delete(key);
        return ctx.reply('Thanks! Support will reach out soon.');
      }

      // awaitPaymentMethod state — user typed instead of tapping a button
      return ctx.reply('Please tap one of the payment buttons above to continue.');
    });

    bot.on('chat_join_request', async (ctx: any) => {
      try {
        const req = ctx.update?.chat_join_request;
        const requesterId = Number(req?.from?.id ?? 0);
        const chatId = String(req?.chat?.id ?? '');
        if (!requesterId || !chatId) return;
        if (chatId !== String(protectedChatId)) return;
        const now = new Date();
        const activeSub = await SubscriptionModel.findOne({ botId, telegramUserId: requesterId, status: 'active', endsAt: { $gt: now } }).sort({ endsAt: -1 }).lean();
        if (!activeSub) {
          await (ctx.telegram as any).callApi('declineChatJoinRequest', { chat_id: chatId, user_id: requesterId });
          try {
            await ctx.telegram.sendMessage(requesterId, 'Join request declined — paid access required. Use /subscribe to activate.');
          } catch { }
          return;
        }
        await (ctx.telegram as any).callApi('approveChatJoinRequest', { chat_id: chatId, user_id: requesterId });
      } catch (err) {
        logger.error({ err, botId }, 'Failed to handle chat join request');
      }
    });

    bot.catch((err, ctx) => {
      logger.error({ err, botId, updateType: ctx.updateType }, 'Telegram bot error');
    });

    void protectedChatId;
  }

  private async sendPlans(ctx: any) {
    const plans = await PlanModel.find({ isActive: true }).sort({ amountKobo: 1 }).lean();
    if (plans.length === 0) return ctx.reply('No plans available right now. Check back soon!');
    const buttons = plans.map((p) => {
      const desc = p.description ? ` — ${p.description}` : '';
      return Markup.button.callback(`${p.name} (${formatMoney(p.amountKobo, p.currency)})${desc}`, `plan:${String(p._id)}`);
    });
    return ctx.reply('Choose a plan to get access:', Markup.inlineKeyboard(buttons, { columns: 1 }));
  }

  private async startCardFlow(opts: { ctx: any; botId: string; planId: string; userId: number }) {
    const plan = await PlanModel.findById(opts.planId).lean();
    if (!plan || !plan.isActive) return opts.ctx.reply('That plan is no longer available.');

    const email = placeholderEmail(opts.userId);
    const reference = `wraith_${opts.botId}_${opts.userId}_${nanoid(10)}`;
    const callbackUrl = env.PAYSTACK_CALLBACK_BASE_URL
      ? `${env.PAYSTACK_CALLBACK_BASE_URL.replace(/\/$/, '')}/paystack/callback`
      : undefined;

    const { authorizationUrl } = await initializeTransaction({
      amountKobo: plan.amountKobo,
      email,
      reference,
      currency: plan.currency,
      callbackUrl,
      metadata: { botId: opts.botId, planId: opts.planId, telegramUserId: opts.userId }
    });

    await PaymentModel.create({
      reference,
      botId: opts.botId,
      planId: opts.planId,
      telegramUserId: opts.userId,
      email,
      amountKobo: plan.amountKobo,
      currency: plan.currency,
      authorizationUrl,
      status: 'initialized'
    });

    await opts.ctx.reply(
      `Click the link below to pay for *${plan.name}* (${formatMoney(plan.amountKobo, plan.currency)}) with your card:\n\n${authorizationUrl}\n\nYour channel link will be sent here automatically after payment.`,
      { parse_mode: 'Markdown', disable_web_page_preview: true }
    );
  }

  private async startMpesaFlow(opts: { ctx: any; botId: string; planId: string; userId: number; phone: string }) {
    const plan = await PlanModel.findById(opts.planId).lean();
    if (!plan || !plan.isActive) return opts.ctx.reply('That plan is no longer available.');

    const email = placeholderEmail(opts.userId);
    const reference = `wraith_${opts.botId}_${opts.userId}_${nanoid(10)}`;

    await opts.ctx.reply(`Sending M-Pesa prompt to ${opts.phone}…`);

    try {
      await chargeMpesa({
        amountKobo: plan.amountKobo,
        email,
        phone: opts.phone,
        reference,
        metadata: { botId: opts.botId, planId: opts.planId, telegramUserId: opts.userId }
      });
    } catch (err: any) {
      logger.error({ err, phone: opts.phone }, 'M-Pesa charge failed');
      return opts.ctx.reply('Could not send M-Pesa prompt. Please check your number and try again.');
    }

    await PaymentModel.create({
      reference,
      botId: opts.botId,
      planId: opts.planId,
      telegramUserId: opts.userId,
      email,
      amountKobo: plan.amountKobo,
      currency: 'KES',
      status: 'initialized'
    });

    await opts.ctx.reply(
      `Check your phone! Enter your M-Pesa PIN to pay *${formatMoney(plan.amountKobo, 'KES')}* for *${plan.name}*.\n\nYour channel link will arrive here once payment is confirmed.`,
      { parse_mode: 'Markdown' }
    );
  }
}
