import cron, { type ScheduledTask } from 'node-cron';
import { env } from '../../config/env';
import { logger } from '../../config/logger';
import { ScholarshipModel } from '../../models/scholarship/Scholarship';
import { CrawlTargetModel, CrawlRunModel } from '../../models/scholarship/operational';
import { ScholarshipSourceModel } from '../../models/scholarship/operational';
import { UniversityModel } from '../../models/scholarship/University';
import { runCrawl } from './pipeline';
import { discoverUniversities } from './discovery/universityDiscovery';
import { discoverForDueUniversities } from './discovery/scholarshipDiscovery';
import { refreshStatuses } from './status';
import { closeBrowser } from './fetcher';
import { ensureScholarshipIndexes } from './indexes';

/**
 * Scheduling (§27).
 *
 * Follows the existing JobScheduler shape — node-cron, a class with
 * start()/stop(), a Mongo-backed lock — so operating this feels the same as
 * operating the jobs vertical.
 *
 * The adaptive part is reprioritisation: rather than crawling every university
 * on the same cadence, a nightly pass re-scores the queue so that awards
 * closing soon are refreshed daily and expired ones drift to the back.
 */

const LOCK_ID = 'scholarship-crawl';
const LOCK_TTL_MS = 90 * 60 * 1000;

/** Reuse the CrawlRun collection as the lock holder — no extra model needed. */
async function acquireLock(): Promise<boolean> {
  const now = new Date();
  const stale = new Date(now.getTime() - LOCK_TTL_MS);
  const running = await CrawlRunModel.findOne({
    kind: 'CRAWL',
    state: 'RUNNING',
    startedAt: { $gt: stale }
  }).select('_id').lean();
  return !running;
}

// ── Adaptive priority (§27) ─────────────────────────────────────────────────

/**
 * Recompute crawl priority for scholarship targets.
 *
 * High:   open / closing soon awards, recently changed pages
 * Medium: scholarship landing and funding hubs
 * Low:    closed, expired, discovery pages
 */
export async function reprioritizeTargets(): Promise<{ raised: number; lowered: number }> {
  const now = new Date();
  let raised = 0;
  let lowered = 0;

  // Sources of scholarships that are closing soon → daily refresh
  const urgent = await ScholarshipModel.find({ status: { $in: ['CLOSING_SOON', 'OPEN'] } })
    .select('_id')
    .limit(5000)
    .lean();
  if (urgent.length > 0) {
    const ids = urgent.map((s) => s._id);
    const sources = await ScholarshipSourceModel.find({ scholarshipId: { $in: ids } })
      .select('canonicalUrl')
      .lean();
    const urls = sources.map((s) => s.canonicalUrl);
    if (urls.length > 0) {
      const res = await CrawlTargetModel.updateMany(
        { canonicalUrl: { $in: urls }, status: { $ne: 'BLOCKED' } },
        { $set: { priority: 95, nextCrawlAt: new Date(now.getTime() + 86_400_000) } }
      );
      raised += res.modifiedCount;
    }
  }

  // Sources of dead awards → monthly at most
  const dead = await ScholarshipModel.find({ status: { $in: ['EXPIRED', 'REPLACED'] } })
    .select('_id')
    .limit(5000)
    .lean();
  if (dead.length > 0) {
    const sources = await ScholarshipSourceModel.find({ scholarshipId: { $in: dead.map((s) => s._id) } })
      .select('canonicalUrl')
      .lean();
    const urls = sources.map((s) => s.canonicalUrl);
    if (urls.length > 0) {
      const res = await CrawlTargetModel.updateMany(
        { canonicalUrl: { $in: urls } },
        { $set: { priority: 10, nextCrawlAt: new Date(now.getTime() + 30 * 86_400_000) } }
      );
      lowered += res.modifiedCount;
    }
  }

  return { raised, lowered };
}

// ── Full cycle ──────────────────────────────────────────────────────────────

export interface CycleSummary {
  skipped?: string;
  discovery?: { candidates: number; created: number; verified: number };
  urlDiscovery?: { processed: number; targetsCreated: number };
  crawl?: { processed: number; created: number; updated: number };
  statuses?: { scanned: number; changed: number };
  priorities?: { raised: number; lowered: number };
  durationMs: number;
}

/**
 * One full engine cycle.
 *
 * Ordered so that each stage feeds the next within the same run: discover
 * institutions → discover their funding pages → crawl the queue → recompute
 * statuses → reprioritise for next time.
 */
export async function runScholarshipCycle(
  opts: { trigger?: 'CRON' | 'ADMIN' | 'CLI'; dryRun?: boolean; crawlLimit?: number } = {}
): Promise<CycleSummary> {
  const started = Date.now();

  if (!env.SCHOLARSHIP_CRAWLER_ENABLED) {
    return { skipped: 'SCHOLARSHIP_CRAWLER_ENABLED is false', durationMs: 0 };
  }
  if (!(await acquireLock())) {
    logger.warn('scholarship: a crawl run is already in progress — skipping this trigger');
    return { skipped: 'run already in progress', durationMs: Date.now() - started };
  }

  const summary: CycleSummary = { durationMs: 0 };

  // Stage 1 — universities
  if (env.UNIVERSITY_DISCOVERY_ENABLED) {
    try {
      const d = await discoverUniversities({ dryRun: opts.dryRun, limit: 100 });
      summary.discovery = { candidates: d.candidates, created: d.created, verified: d.verified };
    } catch (err) {
      logger.error({ err }, 'scholarship: university discovery stage failed');
    }
  }

  // Stage 2 — scholarship URLs
  try {
    const r = await discoverForDueUniversities({ limit: 10, dryRun: opts.dryRun });
    summary.urlDiscovery = {
      processed: r.processed,
      targetsCreated: r.results.reduce((s, x) => s + x.targetsCreated, 0)
    };
  } catch (err) {
    logger.error({ err }, 'scholarship: URL discovery stage failed');
  }

  // Stage 3 — crawl
  try {
    const c = await runCrawl({ limit: opts.crawlLimit ?? 100, dryRun: opts.dryRun, trigger: opts.trigger ?? 'CRON' });
    summary.crawl = {
      processed: c.processed,
      created: c.metrics.scholarshipsCreated,
      updated: c.metrics.scholarshipsUpdated
    };
  } catch (err) {
    logger.error({ err }, 'scholarship: crawl stage failed');
  }

  // Stage 4 — statuses
  try {
    const s = await refreshStatuses({ dryRun: opts.dryRun });
    summary.statuses = { scanned: s.scanned, changed: s.changed };
  } catch (err) {
    logger.error({ err }, 'scholarship: status refresh stage failed');
  }

  // Stage 5 — adaptive priorities
  if (!opts.dryRun) {
    try {
      summary.priorities = await reprioritizeTargets();
    } catch (err) {
      logger.error({ err }, 'scholarship: reprioritisation stage failed');
    }
  }

  await closeBrowser();
  summary.durationMs = Date.now() - started;
  logger.info({ summary }, 'scholarship: cycle complete');
  return summary;
}

export class ScholarshipScheduler {
  private tasks: ScheduledTask[] = [];

  start(): void {
    if (!env.SCHOLARSHIP_CRAWLER_ENABLED) {
      logger.info('scholarship: crawler disabled (SCHOLARSHIP_CRAWLER_ENABLED=false)');
      return;
    }

    // db/mongo.ts sets autoIndex:false in production, so the unique indexes
    // that dedup depends on must be created explicitly. Fire-and-forget: a
    // failure here is logged loudly but must not block server startup.
    void ensureScholarshipIndexes().catch((err) =>
      logger.error({ err }, 'scholarship: index provisioning failed at startup')
    );

    // Main cycle — configurable, defaults to 02:00 UTC so it never overlaps the
    // 04:00/04:20 jobs and tenders reports.
    this.tasks.push(
      cron.schedule(
        env.SCHOLARSHIP_CRAWL_INTERVAL,
        () => {
          runScholarshipCycle({ trigger: 'CRON' }).catch((err) =>
            logger.error({ err }, 'scholarship: cycle cron failed')
          );
        },
        { timezone: 'UTC' }
      )
    );

    // Status sweep runs hourly and independently — deadlines pass on wall-clock
    // time, not on crawl cadence, so an award must flip to CLOSING_SOON even on
    // a day when no crawl happens.
    this.tasks.push(
      cron.schedule(
        '15 * * * *',
        () => {
          refreshStatuses().catch((err) => logger.error({ err }, 'scholarship: status sweep failed'));
        },
        { timezone: 'UTC' }
      )
    );

    logger.info({ schedule: env.SCHOLARSHIP_CRAWL_INTERVAL }, 'scholarship: scheduler started');
  }

  stop(): void {
    for (const t of this.tasks) t.stop();
    this.tasks = [];
    void closeBrowser();
  }
}

// ── Dashboard metrics (§61) ─────────────────────────────────────────────────

export async function engineMetrics(): Promise<Record<string, unknown>> {
  const [
    universitiesTotal, universitiesActive, universitiesUnverified,
    targetsTotal, targetsPending, targetsBlocked, targetsFailed,
    scholarshipsTotal, open, closingSoon, expired, needsReview,
    lastRun
  ] = await Promise.all([
    UniversityModel.estimatedDocumentCount(),
    UniversityModel.countDocuments({ status: 'ACTIVE' }),
    UniversityModel.countDocuments({ status: 'UNVERIFIED' }),
    CrawlTargetModel.estimatedDocumentCount(),
    CrawlTargetModel.countDocuments({ status: 'PENDING' }),
    CrawlTargetModel.countDocuments({ status: 'BLOCKED' }),
    CrawlTargetModel.countDocuments({ status: 'FAILED' }),
    ScholarshipModel.estimatedDocumentCount(),
    ScholarshipModel.countDocuments({ status: 'OPEN' }),
    ScholarshipModel.countDocuments({ status: 'CLOSING_SOON' }),
    ScholarshipModel.countDocuments({ status: 'EXPIRED' }),
    ScholarshipModel.countDocuments({ reviewStatus: 'NEEDS_REVIEW' }),
    CrawlRunModel.findOne({ kind: 'CRAWL' }).sort({ startedAt: -1 }).lean()
  ]);

  return {
    universities: { total: universitiesTotal, active: universitiesActive, unverified: universitiesUnverified },
    crawlTargets: { total: targetsTotal, pending: targetsPending, blocked: targetsBlocked, failed: targetsFailed },
    scholarships: { total: scholarshipsTotal, open, closingSoon, expired, needsReview },
    lastRun: lastRun
      ? {
          id: String(lastRun._id),
          state: lastRun.state,
          startedAt: lastRun.startedAt,
          finishedAt: lastRun.finishedAt,
          durationMs: lastRun.durationMs,
          metrics: lastRun.metrics
        }
      : null,
    config: {
      crawlerEnabled: env.SCHOLARSHIP_CRAWLER_ENABLED,
      discoveryEnabled: env.UNIVERSITY_DISCOVERY_ENABLED,
      playwrightEnabled: env.PLAYWRIGHT_ENABLED,
      aiEnabled: env.AI_EXTRACTION_ENABLED,
      aiProvider: env.AI_PROVIDER,
      respectRobots: env.SCHOLARSHIP_RESPECT_ROBOTS
    }
  };
}
