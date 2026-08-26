import cookieParser from 'cookie-parser';
import cors from 'cors';
import express from 'express';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import pinoHttp from 'pino-http';

import { env } from './config/env';
import { logger } from './config/logger';
import { errorHandler } from './middleware/errorHandler';
import { authRouter } from './routes/authRoutes';
import { adminRouter } from './routes/adminRoutes';
import { publicRouter } from './routes/publicRoutes';
import { paystackWebhookRouter } from './routes/paystackWebhookRoutes';
import { scholarshipPublicRouter } from './routes/scholarshipRoutes';
import { telegramWebhookRouter } from './routes/telegramWebhookRoutes';
import { whatsappHubRouter, whatsappInboundRouter } from './routes/whatsappInboundRoutes';
import type { BotRunner } from './services/botRunner';
import type { WhatsAppBotRunner } from './services/whatsappBotRunner';

export function createApp(deps: { botRunner: BotRunner; waBotRunner: WhatsAppBotRunner }) {
  const app = express();
  app.set('trust proxy', 1);

  app.use(pinoHttp({ logger, customLogLevel: (req, res, err) => { if (res.statusCode >= 500 || err) return 'error'; if (res.statusCode >= 400) return 'warn'; return 'info'; } }));
  app.use(helmet({
    crossOriginResourcePolicy: { policy: 'same-site' },
    hsts: { maxAge: 31536000, includeSubDomains: true }
  }));
  // /public has its own permissive GET-only CORS (see publicRoutes); everything
  // else stays locked to the admin origin with credentials.
  app.use('/public', publicRouter());
  // /api is the public scholarship search surface. Same rationale as /public:
  // it carries its own permissive CORS and rate limit, so it must be mounted
  // before the admin-origin CORS below. It is read-only apart from the
  // stateless /scholarships/match scoring endpoint.
  // cookieParser must run BEFORE this router: the paywall reads its access and
  // quota cookies here. It is mounted again further down for the admin/auth
  // stack; express middleware is idempotent, and this ordering keeps the public
  // API self-contained rather than depending on where the admin stack sits.
  app.use('/api', cookieParser(), express.json({ limit: '32kb' }), scholarshipPublicRouter());
  app.use(cors({ origin: env.CORS_ORIGIN, credentials: true, methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'], allowedHeaders: ['Content-Type', 'X-CSRF-Token'] }));
  app.use(rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: 'draft-7', legacyHeaders: false }));

  app.get('/health', (_req, res) => res.status(200).json({ ok: true }));

  // Paystack payment callback page
  app.get('/paystack/callback', (_req, res) => {
    res.status(200).send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Payment Complete</title>
<style>
* { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0d0d0d; color: #fff; display: flex; align-items: center; justify-content: center; min-height: 100vh; padding: 24px; }
.card { background: #1a1a1a; border: 1px solid #2a2a2a; border-radius: 16px; padding: 40px 32px; max-width: 400px; width: 100%; text-align: center; }
.icon { font-size: 48px; margin-bottom: 16px; }
h1 { font-size: 24px; font-weight: 700; margin-bottom: 8px; }
p { color: #888; line-height: 1.6; }
.accent { color: #22c55e; }
</style>
</head>
<body>
<div class="card">
<div class="icon">&#x2705;</div>
<h1>Payment <span class="accent">Received!</span></h1>
<p>Go back to your chat &mdash; your access will be confirmed in a few seconds.</p>
</div>
</body>
</html>`);
  });

  app.use(cookieParser());
  app.use('/webhooks/paystack', paystackWebhookRouter());
  app.use(express.json({ limit: '200kb' }));
  app.use('/auth', authRouter());
  app.use('/admin', adminRouter({ botRunner: deps.botRunner }));
  app.use('/telegram', telegramWebhookRouter(deps.botRunner));
  app.use('/whatsapp/hub', whatsappHubRouter(deps.waBotRunner));
  app.use('/whatsapp/inbound', whatsappInboundRouter(deps.waBotRunner));
  app.use(errorHandler());

  return app;
}
