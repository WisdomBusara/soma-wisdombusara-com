import crypto from 'crypto';
import express, { Router } from 'express';

import { env } from '../config/env';
import { logger } from '../config/logger';
import { BotModel } from '../models/Bot';
import { WhatsAppBotModel } from '../models/WhatsAppBot';
import { PaymentModel } from '../models/Payment';
import { PlanModel } from '../models/Plan';
import { SubscriptionModel } from '../models/Subscription';
import { decryptString } from '../utils/encryption';
import { verifyTransaction } from '../services/paystack';
import { createSingleUseInviteLink, sendMessage, unbanIfBanned } from '../services/telegramApi';
import { sendMessage as wahaSend } from '../services/waha';
import { grantWhatsAppAccess } from '../services/waFulfillment';
import { grantAccessForPayment } from './scholarshipAccessRoutes';

export function paystackWebhookRouter() {
  const router = Router();

  router.post(
    '/',
    express.raw({ type: 'application/json' }),
    async (req, res, next) => {
      try {
        const signature = String(req.header('x-paystack-signature') ?? '').toLowerCase();
        const computed = crypto.createHmac('sha512', env.PAYSTACK_SECRET_KEY).update(req.body).digest('hex');
        const sigBuf = Buffer.from(signature);
        const cmpBuf = Buffer.from(computed);
        if (sigBuf.length !== cmpBuf.length || !crypto.timingSafeEqual(sigBuf, cmpBuf)) {
          return res.status(401).send('invalid signature');
        }

        let event: any;
        try { event = JSON.parse(Buffer.from(req.body).toString('utf8')); }
        catch { return res.status(400).send('invalid json'); }

        if (event?.event !== 'charge.success') return res.status(200).json({ ok: true });

        const reference = String(event?.data?.reference ?? '');
        if (!reference) return res.status(200).json({ ok: true });

        const payment = await PaymentModel.findOne({ reference });
        if (!payment) {
          logger.warn({ reference }, 'Paystack webhook for unknown reference');
          return res.status(200).json({ ok: true });
        }
        if (payment.status === 'paid') return res.status(200).json({ ok: true });

        const verified = await verifyTransaction(reference);
        if (verified.status !== 'success') {
          payment.status = 'failed';
          await payment.save();
          return res.status(200).json({ ok: true });
        }
        if (verified.amountKobo !== payment.amountKobo) {
          logger.warn({ reference, expected: payment.amountKobo, got: verified.amountKobo }, 'Amount mismatch');
          return res.status(200).json({ ok: true });
        }

        payment.status = 'paid';
        await payment.save();

        // Web scholarship purchases fulfil to a browser access grant, not a
        // Telegram invite or a WhatsApp group add. Handled before the bot
        // branches because it shares none of their prerequisites.
        if (payment.vertical === 'scholarships' || payment.platform === 'web') {
          const granted = await grantAccessForPayment(reference);
          if (!granted) logger.error({ reference }, 'scholarship: webhook fulfilment failed');
          return res.status(200).json({ ok: true });
        }

        const plan = await PlanModel.findById(payment.planId).lean();
        if (!plan) {
          logger.error({ reference }, 'Missing plan for paid payment');
          return res.status(200).json({ ok: true });
        }

        const now = new Date();
        const durationMs = plan.durationMinutes * 60_000;

        // ── WhatsApp payment delivery ──
        if ((payment as any).platform === 'whatsapp') {
          const waBot = await WhatsAppBotModel.findById((payment as any).waBotId).lean();
          if (!waBot) { logger.error({ reference }, 'Missing WA bot for paid payment'); return res.status(200).json({ ok: true }); }

          const phone: string = String((payment as any).whatsappPhone ?? '');
          // whatsappChatId stores the full JID (set on new payments); fall back to phone@c.us for old records
          const chatId: string = String((payment as any).whatsappChatId ?? `${phone}@c.us`);
          const apiKey = waBot.wahaApiKeyEnc ? decryptString(waBot.wahaApiKeyEnc) : undefined;

          const { addedDirectly, inviteLink } = await grantWhatsAppAccess({
            waBot, plan, phone, chatId, reference, botId: payment.botId ?? undefined, vertical: ((payment as any).vertical ?? 'jobs')
          });

          try {
            let msg = `✅ *Payment confirmed!* Your *${plan.name}* access is now active.\n\n`;
            if (plan.videoUrl) msg += `🎬 Video link:\n${plan.videoUrl}\n\n`;
            if (addedDirectly) {
              msg += `You've been added to *The Wraith Project* group! 🎉`;
            } else if (inviteLink) {
              msg += `You have "invite-only" settings, so we couldn't add you directly.\n` +
                `👇 Join the group using this link — *it expires in 5 minutes*:\n${inviteLink}`;
            } else {
              msg += `Please ask an admin to add you to the group.`;
            }
            await wahaSend(waBot.wahaUrl, waBot.wahaSessionName, chatId, msg, apiKey);
          } catch (err) {
            logger.error({ err, reference }, 'Failed to send WA confirmation message');
          }

          return res.status(200).json({ ok: true });
        }

        // ── Telegram payment delivery ──
        // Payment.botId / telegramUserId became optional for web checkouts.
        // SubscriptionModel still requires both, so bail before any write
        // rather than letting a validation error surface as a failed webhook.
        const telegramUserId = payment.telegramUserId;
        if (payment.botId == null || telegramUserId == null) {
          logger.error({ reference }, 'Telegram fulfilment reached without bot/user ids');
          return res.status(200).json({ ok: true });
        }

        const bot = await BotModel.findById(payment.botId).lean();
        if (!bot) { logger.error({ reference }, 'Missing Telegram bot for paid payment'); return res.status(200).json({ ok: true }); }

        const existing = await SubscriptionModel.findOne({
          botId: payment.botId, telegramUserId, status: 'active', endsAt: { $gt: now }
        }).sort({ endsAt: -1 });
        if (existing) {
          existing.endsAt = new Date(existing.endsAt.getTime() + durationMs);
          existing.paystackReference = reference;
          await existing.save();
        } else {
          await SubscriptionModel.create({
            botId: payment.botId, planId: payment.planId, telegramUserId,
            startsAt: now, endsAt: new Date(now.getTime() + durationMs),
            status: 'active', paystackReference: reference, platform: 'telegram'
          });
        }

        try {
          const token = decryptString(bot.tokenEnc);
          await unbanIfBanned(token, bot.protectedChatId, telegramUserId);

          let msg = `Payment confirmed! Your *${plan.name}* access is now active.\n\n`;
          if (plan.videoUrl) msg += `Here is your video link:\n${plan.videoUrl}\n\n`;

          const invite = await createSingleUseInviteLink(token, bot.protectedChatId, 30 * 60);
          msg += `Join the channel (one-time link, valid 30 min):\n${invite}\n\n⚠️ This link works for you only — it cannot be shared.`;

          await sendMessage(token, telegramUserId, msg);
        } catch (err) {
          logger.error({ err, reference }, 'Failed to deliver Telegram invite');
        }

        return res.status(200).json({ ok: true });
      } catch (err) { return next(err); }
    }
  );

  return router;
}
