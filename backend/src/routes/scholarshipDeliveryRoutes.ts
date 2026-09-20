import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';

import { env } from '../config/env';
import { logger } from '../config/logger';
import { ScholarshipModel } from '../models/scholarship/Scholarship';
import { ScholarshipAccessModel } from '../models/scholarship/access';
import { SubscriberModel, DELIVERY_CHANNELS } from '../models/scholarship/subscriber';
import { sendWelcomeEmail } from '../services/scholarship/delivery/email';
import {
  sendTelegramWelcome, sendTelegramText, sendTelegram,
  sendPersonalGroupInvite
} from '../services/scholarship/delivery/telegram';
import { toEmailShape } from '../services/scholarship/delivery/dispatcher';

/**
 * Delivery subscription + Telegram webhook.
 *
 * Three responsibilities:
 *   1. /subscribe — after a reader pays (they hold a valid access token), they
 *      pick channels (email / telegram / whatsapp) and give addresses. We store
 *      a Subscriber row linked to their access grant.
 *   2. /scholarship-telegram/webhook — Telegram calls this when a user messages
 *      the bot; we learn their chat id and link it to their subscription by a
 *      connect code, and hand them a personal group invite once linked.
 *   3. The same webhook also answers slash commands (/help, /latest, /status),
 *      both in a private chat with the bot and inside the group itself —
 *      Telegram always forwards commands to a bot regardless of the group's
 *      privacy-mode setting, so no extra bot configuration is needed for this.
 *
 * Mounted under the public /api router (inherits its CORS + cookies).
 */

export function scholarshipDeliveryRouter() {
  const router = Router();
  const limiter = rateLimit({ windowMs: 60_000, limit: 10, standardHeaders: 'draft-7', legacyHeaders: false });

  // ── Subscribe to delivery ───────────────────────────────────────────────────
  // WhatsApp is deliberately not a selectable channel here — see subscriber.ts.
  // A WhatsApp payer is added to the shared group at payment time instead.
  const subscribeSchema = z.object({
    channels: z.array(z.enum(DELIVERY_CHANNELS)).min(1),
    email: z.string().email().max(160).optional(),
    telegramHandle: z.string().max(64).optional(),
    countries: z.array(z.string().length(2)).max(20).optional(),
    degreeLevels: z.array(z.string().max(30)).max(10).optional(),
    fundingOnly: z.boolean().optional()
  });

  router.post('/subscribe', limiter, async (req, res, next) => {
    try {
      // Must have a live access grant (they paid). req.access is set by
      // resolveAccess middleware on the parent router.
      if (req.access?.tier !== 'premium' || !req.access.accessId) {
        return res.status(402).json({ error: 'payment_required', message: 'Subscribe is available after payment.', upgradeUrl: '/upgrade' });
      }

      const body = subscribeSchema.parse(req.body ?? {});

      // Validate addresses for the chosen channels.
      if (body.channels.includes('email') && !body.email) {
        return res.status(400).json({ error: 'email_required', message: 'An email address is needed for email delivery.' });
      }

      // A short code the user sends to the Telegram bot to link their chat.
      const connectCode = body.channels.includes('telegram')
        ? Math.random().toString(36).slice(2, 8).toUpperCase()
        : undefined;

      const grant = await ScholarshipAccessModel.findById(req.access.accessId).lean();

      const sub = await SubscriberModel.findOneAndUpdate(
        { accessId: req.access.accessId },
        {
          $set: {
            accessId: req.access.accessId,
            channels: body.channels,
            email: body.email?.toLowerCase(),
            telegramHandle: connectCode ? connectCode : body.telegramHandle, // store code as the pending link key
            countries: body.countries ?? [],
            degreeLevels: body.degreeLevels ?? [],
            fundingOnly: body.fundingOnly ?? false,
            status: 'active'
          }
        },
        { upsert: true, new: true }
      );

      // Fire welcome messages (best-effort, never block the response).
      if (body.channels.includes('email') && body.email) {
        void sendWelcomeEmail(body.email, undefined).catch(() => undefined);
      }

      return res.json({
        ok: true,
        subscriberId: String(sub._id),
        channels: body.channels,
        telegram: connectCode
          ? {
              connectCode,
              instructions: `Open Telegram, search for ${env.SCHOLARSHIP_TELEGRAM_BOT_USERNAME ?? 'our bot'}, and send: /connect ${connectCode}`,
              botUsername: env.SCHOLARSHIP_TELEGRAM_BOT_USERNAME ?? null
            }
          : null
      });
    } catch (err) {
      return next(err);
    }
  });

  // ── Subscriber's current delivery settings ──────────────────────────────────
  router.get('/subscribe/me', async (req, res, next) => {
    try {
      if (req.access?.tier !== 'premium' || !req.access.accessId) {
        return res.json({ subscribed: false });
      }
      const sub = await SubscriberModel.findOne({ accessId: req.access.accessId }).lean();
      if (!sub) return res.json({ subscribed: false });
      return res.json({
        subscribed: true,
        channels: sub.channels,
        email: sub.email ?? null,
        whatsappPhone: sub.whatsappPhone ?? null,
        telegramLinked: Boolean(sub.telegramChatId),
        countries: sub.countries,
        degreeLevels: sub.degreeLevels,
        fundingOnly: sub.fundingOnly
      });
    } catch (err) { return next(err); }
  });

  // ── Telegram webhook ────────────────────────────────────────────────────────
  // Telegram POSTs updates here. Handles /start, /connect CODE (link a chat to
  // a subscription and hand over the group invite), and a small set of
  // commands usable in the group or in a DM with the bot.
  router.post('/scholarship-telegram/webhook', async (req, res) => {
    // Always 200 quickly — Telegram retries on non-200 and we never want a loop.
    res.status(200).json({ ok: true });
    try {
      const msg = req.body?.message;
      if (!msg?.chat?.id || !msg.text) return;
      const chatId = String(msg.chat.id);
      const isGroup = msg.chat.type === 'group' || msg.chat.type === 'supergroup';
      // In a group, Telegram appends "@BotUsername" to the command token only
      // (e.g. "/connect@SomaScholarships_bot ABC123") — strip it from there,
      // not from the whole message, so arguments after it survive intact.
      const rawParts = String(msg.text).trim().split(/\s+/);
      const command = rawParts[0].replace(/@\w+$/, '').toLowerCase();
      const text = [command, ...rawParts.slice(1)].join(' ');

      if (command === '/start') {
        await sendTelegramWelcome(chatId);
        return;
      }

      if (command === '/help') {
        const lines = [
          '🎓 *Wisdom Busara Scholarships*',
          '',
          '/latest — the 5 newest open scholarships',
          '/status — your access & renewal date (DM only)',
          '/connect CODE — link this chat after paying'
        ];
        await sendTelegramText(chatId, lines.join('\n'));
        return;
      }

      if (command === '/latest') {
        const recent = await ScholarshipModel.find({ status: { $in: ['OPEN', 'CLOSING_SOON'] } })
          .sort({ createdAt: -1 })
          .limit(5)
          .lean();
        if (recent.length === 0) {
          await sendTelegramText(chatId, 'No open scholarships right now — check back soon.');
        } else {
          await sendTelegram(chatId, recent.map(toEmailShape));
        }
        return;
      }

      if (command === '/status') {
        // Personal data — only answer in a private chat, never into the group.
        if (isGroup) {
          await sendTelegramText(chatId, 'Message me privately for your access status.');
          return;
        }
        const sub = await SubscriberModel.findOne({ telegramChatId: chatId }).lean();
        if (!sub?.accessId) {
          await sendTelegramText(chatId, 'No linked subscription found. Pay for access, then use /connect CODE from your confirmation.');
          return;
        }
        const grant = await ScholarshipAccessModel.findById(sub.accessId).select('status endsAt planName').lean();
        if (!grant || grant.status !== 'active' || new Date(grant.endsAt) < new Date()) {
          await sendTelegramText(chatId, 'Your access has ended. Renew to keep your spot in the group.');
        } else {
          await sendTelegramText(chatId, `${grant.planName ?? 'Full access'} — active until ${new Date(grant.endsAt).toLocaleDateString()}.`);
        }
        return;
      }

      const m = /^\/connect\s+([A-Z0-9]{4,8})$/i.exec(text);
      if (m) {
        const code = m[1].toUpperCase();
        // The subscribe route (and the post-payment flow) store the connect
        // code in telegramHandle until it is redeemed here.
        const sub = await SubscriberModel.findOne({ telegramHandle: code, channels: 'telegram' });
        if (sub) {
          sub.telegramChatId = chatId;
          await sub.save();
          await sendTelegramWelcome(chatId);
          logger.info({ chatId }, 'scholarship-telegram: chat linked');

          // If this code came from an active paid grant, the invite is the
          // whole point of connecting — send it immediately.
          if (sub.accessId) {
            const grant = await ScholarshipAccessModel.findById(sub.accessId).select('status endsAt').lean();
            if (grant?.status === 'active' && new Date(grant.endsAt) > new Date()) {
              await sendPersonalGroupInvite(chatId, new Date(grant.endsAt));
            }
          }
        }
      }
    } catch (err) {
      logger.error({ err }, 'scholarship-telegram: webhook handling failed');
    }
  });

  return router;
}
