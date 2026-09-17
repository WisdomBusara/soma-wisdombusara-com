import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';

import { env } from '../config/env';
import { logger } from '../config/logger';
import { ScholarshipAccessModel } from '../models/scholarship/access';
import { SubscriberModel, DELIVERY_CHANNELS } from '../models/scholarship/subscriber';
import { sendWelcomeEmail } from '../services/scholarship/delivery/email';
import { sendTelegramWelcome } from '../services/scholarship/delivery/telegram';

/**
 * Delivery subscription + Telegram webhook.
 *
 * Two responsibilities:
 *   1. /subscribe — after a reader pays (they hold a valid access token), they
 *      pick channels (email / telegram / whatsapp) and give addresses. We store
 *      a Subscriber row linked to their access grant.
 *   2. /scholarship-telegram/webhook — Telegram calls this when a user messages
 *      the bot; we learn their chat id and link it to their subscription by a
 *      connect code.
 *
 * Mounted under the public /api router (inherits its CORS + cookies).
 */

const KENYAN_PHONE = /^(?:\+?254|0)?(7\d{8}|1\d{8})$/;
function normalizePhone(raw: string): string | null {
  const m = KENYAN_PHONE.exec(String(raw ?? '').replace(/[^\d+]/g, ''));
  return m ? `254${m[1]}` : null;
}

export function scholarshipDeliveryRouter() {
  const router = Router();
  const limiter = rateLimit({ windowMs: 60_000, limit: 10, standardHeaders: 'draft-7', legacyHeaders: false });

  // ── Subscribe to delivery ───────────────────────────────────────────────────
  const subscribeSchema = z.object({
    channels: z.array(z.enum(DELIVERY_CHANNELS)).min(1),
    email: z.string().email().max(160).optional(),
    telegramHandle: z.string().max(64).optional(),
    whatsappPhone: z.string().max(20).optional(),
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
      let whatsappPhone: string | undefined;
      if (body.channels.includes('email') && !body.email) {
        return res.status(400).json({ error: 'email_required', message: 'An email address is needed for email delivery.' });
      }
      if (body.channels.includes('whatsapp')) {
        const n = body.whatsappPhone ? normalizePhone(body.whatsappPhone) : null;
        if (!n) return res.status(400).json({ error: 'invalid_phone', message: 'Enter a valid Kenyan WhatsApp number.' });
        whatsappPhone = n;
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
            whatsappPhone,
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
  // Telegram POSTs updates here. We handle /start and /connect CODE to link a
  // chat id to a subscription.
  router.post('/scholarship-telegram/webhook', async (req, res) => {
    // Always 200 quickly — Telegram retries on non-200 and we never want a loop.
    res.status(200).json({ ok: true });
    try {
      const msg = req.body?.message;
      if (!msg?.chat?.id || !msg.text) return;
      const chatId = String(msg.chat.id);
      const text = String(msg.text).trim();

      if (text === '/start') {
        await sendTelegramWelcome(chatId);
        return;
      }

      const m = /^\/connect\s+([A-Z0-9]{4,8})$/i.exec(text);
      if (m) {
        const code = m[1].toUpperCase();
        // The subscribe route stored the connect code in telegramHandle.
        const sub = await SubscriberModel.findOne({ telegramHandle: code, channels: 'telegram' });
        if (sub) {
          sub.telegramChatId = chatId;
          await sub.save();
          await sendTelegramWelcome(chatId);
          logger.info({ chatId }, 'scholarship-telegram: chat linked');
        }
      }
    } catch (err) {
      logger.error({ err }, 'scholarship-telegram: webhook handling failed');
    }
  });

  return router;
}
