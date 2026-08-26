import { Router } from 'express';
import { BotModel } from '../models/Bot';
import type { BotRunner } from '../services/botRunner';

export function telegramWebhookRouter(botRunner: BotRunner) {
  const router = Router();

  router.post('/webhook/:botId/:secret', async (req, res, next) => {
    try {
      const botId = String(req.params.botId);
      const secret = String(req.params.secret);
      const bot = await BotModel.findById(botId).lean();
      if (!bot || !bot.isActive) return res.status(404).send('not found');
      if (bot.webhookSecret !== secret) return res.status(401).send('unauthorized');
      const handler = botRunner.getWebhookHandler(botId);
      if (!handler) return res.status(409).send('bot not running');
      void handler(req.body).catch((err: any) => {
        console.error('telegram webhook handler error', err?.stack ?? err);
      });
      return res.status(200).json({ ok: true });
    } catch (err) { return next(err); }
  });

  return router;
}
