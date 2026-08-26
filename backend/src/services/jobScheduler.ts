import cron, { type ScheduledTask } from 'node-cron';
import { logger } from '../config/logger';
import { env } from '../config/env';
import { JobModel, makeJobHash } from '../models/Job';
import { JobRunStateModel } from '../models/JobRunState';
import { WhatsAppBotModel } from '../models/WhatsAppBot';
import { scrapeAllBanks, type ScrapedJob } from './jobScraper';
import { sendMessage as wahaSend } from './waha';
import { decryptString } from '../utils/encryption';

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export type Vertical = 'jobs' | 'tenders';

// Per-vertical presentation + targeting
const VERTICAL_CFG = {
  jobs: {
    stateId: 'job-report',                   // legacy id kept for jobs
    emoji: '🏦',
    header: 'KENYA JOBS',
    noun: 'listing',
    groupOf: (bot: any) => bot?.jobReportGroupId || bot?.groupId || env.JOB_REPORT_GROUP_JID
  },
  tenders: {
    stateId: 'job-report:tenders',
    emoji: '📋',
    header: 'KENYA TENDERS',
    noun: 'tender',
    groupOf: (bot: any) => bot?.tendersGroupId  // no fallback — never leak into the jobs group
  }
} as const;

// Live status of the current/last report run — stored in Mongo (singleton doc
// per vertical) so it survives restarts and reads consistently across machines.
export interface JobRunStatus {
  state: 'idle' | 'scraping' | 'sending' | 'done' | 'failed';
  startedAt: string | null;
  finishedAt: string | null;
  banksDone: number;
  banksTotal: number;
  currentBank: string | null;
  newJobs: number;
  banksWithNew: number;
  error: string | null;
}

const LOCK_TTL_MS = 45 * 60 * 1000; // auto-expires if a run dies mid-way

async function updateStatus(vertical: Vertical, patch: Partial<JobRunStatus> & { lockedUntil?: Date | null }): Promise<void> {
  await JobRunStateModel.updateOne({ _id: VERTICAL_CFG[vertical].stateId }, { $set: patch }, { upsert: true });
}

export async function getJobRunStatus(vertical: Vertical = 'jobs'): Promise<JobRunStatus> {
  const doc = await JobRunStateModel.findById(VERTICAL_CFG[vertical].stateId).lean();
  return {
    state: (doc?.state as JobRunStatus['state']) ?? 'idle',
    startedAt: doc?.startedAt?.toISOString() ?? null,
    finishedAt: doc?.finishedAt?.toISOString() ?? null,
    banksDone: doc?.banksDone ?? 0,
    banksTotal: doc?.banksTotal ?? 0,
    currentBank: doc?.currentBank ?? null,
    newJobs: doc?.newJobs ?? 0,
    banksWithNew: doc?.banksWithNew ?? 0,
    error: doc?.error ?? null
  };
}

/** Atomically take the run lock. Returns false if another machine holds it. */
async function acquireRunLock(vertical: Vertical): Promise<boolean> {
  const id = VERTICAL_CFG[vertical].stateId;
  const now = new Date();
  const res = await JobRunStateModel.findOneAndUpdate(
    { _id: id, $or: [{ lockedUntil: null }, { lockedUntil: { $lt: now } }] },
    { $set: { lockedUntil: new Date(now.getTime() + LOCK_TTL_MS) } },
    { new: true }
  ).lean();
  if (res) return true;
  // Doc may not exist yet — try to create it holding the lock
  try {
    await JobRunStateModel.create({ _id: id, lockedUntil: new Date(now.getTime() + LOCK_TTL_MS) });
    return true;
  } catch {
    return false;
  }
}

function formatDate(d: Date): string {
  return `${DAYS[d.getDay()]}, ${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

export async function runJobReport(vertical: Vertical = 'jobs'): Promise<void> {
  if (!(await acquireRunLock(vertical))) {
    logger.warn({ vertical }, 'Report already running (lock held) — skipping duplicate trigger');
    return;
  }
  logger.info({ vertical }, 'Report: scraping started');
  await updateStatus(vertical, {
    state: 'scraping', startedAt: new Date(), finishedAt: null,
    banksDone: 0, banksTotal: 0, currentBank: null, newJobs: 0, banksWithNew: 0, error: null
  } as any);

  try {
    await runJobReportInner(vertical);
    await updateStatus(vertical, { state: 'done', finishedAt: new Date(), currentBank: null, lockedUntil: null } as any);
    if (vertical === 'jobs') {
      // premium: categorize the new jobs in the background (no-op without HF_TOKEN)
      import('./jobCategorizer')
        .then((m) => m.categorizeNewJobs())
        .catch((err) => logger.warn({ err }, 'Post-report categorization failed'));
    }
  } catch (err: any) {
    await updateStatus(vertical, { state: 'failed', finishedAt: new Date(), error: err?.message ?? 'unknown', lockedUntil: null } as any);
    throw err;
  }
}

async function runJobReportInner(vertical: Vertical): Promise<void> {
  const cfg = VERTICAL_CFG[vertical];
  let lastWrite = 0;
  const results = await scrapeAllBanks({
    vertical,
    onProgress: (done, total, bankName) => {
      // Throttle Mongo writes to one per 2s (plus always the final one)
      const t = Date.now();
      if (t - lastWrite > 2000 || done === total) {
        lastWrite = t;
        void updateStatus(vertical, { banksDone: done, banksTotal: total, currentBank: bankName } as any)
          .catch(() => { /* status only */ });
      }
    }
  });
  const now = new Date();

  // Deduplicate: find which entries are brand-new
  const newByBank: Record<string, ScrapedJob[]> = {};
  let totalNew = 0;

  for (const { bankName, jobs, error } of results) {
    if (error && jobs.length === 0) continue;

    const newJobs: ScrapedJob[] = [];
    for (const job of jobs) {
      const hash = makeJobHash(bankName, job.title, job.url);
      const exists = await JobModel.exists({ hash });
      if (exists) {
        // Update lastSeenAt so we know it's still live
        await JobModel.updateOne({ hash }, { $set: { lastSeenAt: now } });
        continue;
      }
      await JobModel.create({ bankName, vertical, title: job.title, url: job.url, location: job.location, deadline: job.deadline, description: job.description, hash, firstSeenAt: now, lastSeenAt: now });
      newJobs.push(job);
    }

    if (newJobs.length > 0) {
      newByBank[bankName] = newJobs;
      totalNew += newJobs.length;
    }
  }

  // Clean up old records (entries not seen in 60 days are likely closed)
  const cutoff = new Date(now.getTime() - 60 * 24 * 60 * 60 * 1000);
  await JobModel.deleteMany({ lastSeenAt: { $lt: cutoff } });

  logger.info({ vertical, totalNew, sources: Object.keys(newByBank).length }, 'Report: deduplication done');
  await updateStatus(vertical, { state: 'sending', newJobs: totalNew, banksWithNew: Object.keys(newByBank).length } as any);

  // Resolve send target from the first active bot
  const waBot = await WhatsAppBotModel.findOne({ isActive: true }).lean();
  const wahaUrl  = waBot?.wahaUrl         ?? env.JOB_REPORT_WAHA_URL;
  const session  = waBot?.wahaSessionName ?? env.JOB_REPORT_WAHA_SESSION ?? 'default';
  const groupJid = cfg.groupOf(waBot as any);
  const apiKey   = waBot?.wahaApiKeyEnc ? decryptString(waBot.wahaApiKeyEnc) : env.WAHA_DEFAULT_API_KEY;
  logger.info({ vertical, botId: waBot ? String(waBot._id) : null, groupJid }, 'Report: resolved target');

  if (!wahaUrl || !groupJid) {
    logger.warn({ vertical }, 'No report group configured for this vertical — set it in the admin panel');
    return;
  }

  const send = (text: string) => wahaSend(wahaUrl!, session, groupJid!, text, apiKey);

  try {
    if (totalNew === 0) {
      await send(`${cfg.emoji} *${cfg.header} — ${formatDate(now)}*\n\n_No new ${cfg.noun}s today. Check back tomorrow!_\n\n_Updated daily at 7 AM · The Wraith Project_`);
    } else {
      // Header message
      await send(`${cfg.emoji} *${cfg.header} — ${formatDate(now)}*\n_${totalNew} new ${cfg.noun}${totalNew !== 1 ? 's' : ''} across ${Object.keys(newByBank).length} source${Object.keys(newByBank).length !== 1 ? 's' : ''}_`);

      // One (or more) messages per source. Every entry is shown — long lists
      // are split across messages so nothing is truncated by WhatsApp's limit.
      const MAX_MSG = 3500; // WhatsApp caps ~4096; leave headroom
      for (const [bankName, jobs] of Object.entries(newByBank)) {
        const header = `${cfg.emoji} *${bankName}* — ${jobs.length} new ${cfg.noun}${jobs.length !== 1 ? 's' : ''}\n`;
        let msg = header;
        let part = 1;
        const flush = () => { if (msg.trim() && msg !== header) return send(msg.trim()); return Promise.resolve(); };
        for (const job of jobs) {
          let entry: string;
          if (vertical === 'tenders') {
            entry = `\n📋 *${job.title}*\n`;
            if (job.deadline) entry += `📅 Closing: ${job.deadline}\n`;
            if (job.description) entry += `📝 ${job.description}\n`;
            entry += `📄 Details & how to apply:\n${job.url}\n`;
          } else {
            const loc = job.location ? ` · ${job.location}` : '';
            entry = `\n• *${job.title}*${loc}\n  ${job.url}\n`;
          }
          if (msg.length + entry.length > MAX_MSG) {
            await flush();
            part += 1;
            msg = `${cfg.emoji} *${bankName}* _(cont. ${part})_\n` + entry;
          } else {
            msg += entry;
          }
        }
        await flush();
      }

      // Footer
      await send(`_Updated daily at 7 AM · The Wraith Project_`);
    }

    logger.info({ vertical, groupJid, totalNew }, 'Report sent to WhatsApp group');
  } catch (err) {
    logger.error({ err, vertical }, 'Failed to send report to WhatsApp');
  }
}

export class JobScheduler {
  private tasks: ScheduledTask[] = [];

  start(): void {
    // Jobs at 07:00 EAT (04:00 UTC), tenders staggered at 07:20 EAT
    this.tasks.push(cron.schedule('0 4 * * *', () => {
      runJobReport('jobs').catch((err) => logger.error({ err }, 'Jobs report cron failed'));
    }, { timezone: 'UTC' }));
    this.tasks.push(cron.schedule('20 4 * * *', () => {
      runJobReport('tenders').catch((err) => logger.error({ err }, 'Tenders report cron failed'));
    }, { timezone: 'UTC' }));

    logger.info('Schedulers started — jobs 07:00 EAT, tenders 07:20 EAT');
  }

  stop(): void {
    for (const t of this.tasks) t.stop();
    this.tasks = [];
  }
}
