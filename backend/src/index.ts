import 'dotenv/config';
import { env } from './config/env';
import { logger } from './config/logger';
import { connectMongo } from './db/mongo';
import { createApp } from './app';
import { bootstrap } from './services/bootstrap';
import { BotRunner } from './services/botRunner';
import { WhatsAppBotRunner } from './services/whatsappBotRunner';
import { SubscriptionEnforcer } from './services/subscriptionEnforcer';
import { JobScheduler } from './services/jobScheduler';
import { ScholarshipScheduler } from './services/scholarship/scholarshipScheduler';
import { ScholarshipAccessEnforcer } from './services/scholarship/scholarshipAccessEnforcer';

async function main() {
  await connectMongo();
  await bootstrap();

  const botRunner = new BotRunner();
  await botRunner.start();

  const waBotRunner = new WhatsAppBotRunner();
  await waBotRunner.start();

  const enforcer = new SubscriptionEnforcer();
  enforcer.start(60_000); // check every 60 seconds

  const jobScheduler = new JobScheduler();
  jobScheduler.start();

  // No-ops unless SCHOLARSHIP_CRAWLER_ENABLED=true, so existing deployments
  // are unaffected until the operator opts in.
  const scholarshipScheduler = new ScholarshipScheduler();
  scholarshipScheduler.start();

  // Independent of the crawler flag — the paywall grants access whether or
  // not the crawler is enabled, so its Telegram group must be enforced either
  // way. No-ops per tick if SCHOLARSHIP_TELEGRAM_CHANNEL is not configured.
  const scholarshipAccessEnforcer = new ScholarshipAccessEnforcer();
  scholarshipAccessEnforcer.start(5 * 60_000); // check every 5 minutes

  const app = createApp({ botRunner, waBotRunner });

  const server = app.listen(env.PORT, '0.0.0.0', () => {
    logger.info({ port: env.PORT, env: env.NODE_ENV }, 'Server listening');
  });

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutting down...');
    botRunner.stop();
    waBotRunner.stop();
    enforcer.stop();
    jobScheduler.stop();
    scholarshipScheduler.stop();
    scholarshipAccessEnforcer.stop();
    server.close(() => {
      logger.info('HTTP server closed');
      process.exit(0);
    });
    setTimeout(() => {
      logger.warn('Forced exit after timeout');
      process.exit(1);
    }, 10_000);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  console.error('Fatal startup error', err);
  process.exit(1);
});
