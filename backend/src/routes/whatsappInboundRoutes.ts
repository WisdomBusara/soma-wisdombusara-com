import { Router } from 'express';
import { logger } from '../config/logger';
import { WhatsAppBotModel } from '../models/WhatsAppBot';
import type { WhatsAppBotRunner } from '../services/whatsappBotRunner';

function extractMessage(body: any): { session: string; from: string; text: string } | null {
  const event = body?.event;
  if (event !== 'message' && event !== 'message.any') return null;
  const payload = body?.payload;
  if (!payload || payload.fromMe === true) return null;
  const from = String(payload.from ?? '');
  const text = String(payload.body ?? '');
  if (!from || !text) return null;
  return { session: String(body?.session ?? ''), from, text };
}

/** Global WAHA webhook receiver — set WHATSAPP_HOOK_URL to https://wraith-backend.fly.dev/whatsapp/hub */
export function whatsappHubRouter(runner: WhatsAppBotRunner) {
  const router = Router();

  router.post('/', async (req, res) => {
    const body = req.body;
    logger.info({ event: body?.event, session: body?.session, fromMe: body?.payload?.fromMe, from: body?.payload?.from, hasBody: !!body?.payload?.body, bodyPreview: String(body?.payload?.body ?? '').slice(0, 40) }, 'WA hub webhook');
    const msg = extractMessage(body);
    if (!msg) {
      logger.info({ event: body?.event, fromMe: body?.payload?.fromMe, from: body?.payload?.from, hasPayload: !!body?.payload }, 'WA hub: message filtered/skipped');
      return res.status(200).json({ ok: true });
    }
    runner.handleMessageBySession(msg.session, msg.from, msg.text).catch((err) =>
      logger.error({ err, session: msg.session, from: msg.from }, 'WA hub handler failed')
    );
    return res.status(200).json({ ok: true });
  });

  return router;
}

/** Per-bot webhook (legacy / manual config) */
export function whatsappInboundRouter(runner: WhatsAppBotRunner) {
  const router = Router();

  router.post('/:botId/:secret', async (req, res, next) => {
    try {
      const { botId, secret } = req.params;
      const bot = await WhatsAppBotModel.findById(botId).lean();
      if (!bot || bot.webhookSecret !== secret) return res.status(401).end();

      const msg = extractMessage(req.body);
      if (!msg) return res.status(200).json({ ok: true });

      runner.handleMessage(botId, msg.from, msg.text).catch((err) =>
        logger.error({ err, botId, from: msg.from }, 'WA inbound handler failed')
      );

      return res.status(200).json({ ok: true });
    } catch (err) {
      return next(err);
    }
  });

  return router;
}
