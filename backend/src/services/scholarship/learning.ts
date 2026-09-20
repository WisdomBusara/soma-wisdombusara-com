import { logger } from '../../config/logger';
import { ReviewFeedbackModel } from '../../models/scholarship/ReviewFeedback';
import { ClassifierWeightModel } from '../../models/scholarship/ClassifierWeight';
import { CrawlTargetModel } from '../../models/scholarship/operational';
import { setClassifierWeights, getClassifierWeights } from './scholarshipClassifier';

/**
 * Self-improvement loop: turns admin APPROVE/REJECT decisions into two kinds
 * of adjustment, both bounded and reversible so a bad batch of feedback can
 * never run away with the pipeline:
 *
 *   1. Classifier weight nudges — reasons that consistently precede an
 *      APPROVE get scored up (within +/-50%), reasons that consistently
 *      precede a REJECT get scored down. See scholarshipClassifier.ts's `w()`.
 *   2. Crawl-target priority — domains whose pages are almost always rejected
 *      get deprioritised; domains that are almost always approved get
 *      boosted. Reuses the same CrawlTarget.priority field reprioritizeTargets()
 *      already drives from scholarship lifecycle status.
 *
 * Deliberately NOT a trained model: every number here is a single auditable
 * multiplier or priority value an operator can inspect (GET /learning) or
 * reset by hand.
 */

const MIN_SAMPLES = 8;
const NUDGE_STEP = 0.04;
const HIGH_APPROVE_RATE = 0.8;
const LOW_APPROVE_RATE = 0.4;
const DOMAIN_HIGH_APPROVE_RATE = 0.85;
const DOMAIN_LOW_APPROVE_RATE = 0.2;
const BATCH_LIMIT = 2000;
const WEIGHT_MIN = 0.5;
const WEIGHT_MAX = 1.5;

export interface RecordFeedbackArgs {
  scholarshipId: unknown;
  decision: 'APPROVED' | 'REJECTED';
  sourceUrl?: string;
  confidence?: number;
  classificationScore?: number;
  classificationReasons?: string[];
  extractionMethod?: string;
  reviewedBy?: unknown;
}

/** Called from the admin review routes on every APPROVE/REJECT. */
export async function recordReviewFeedback(args: RecordFeedbackArgs): Promise<void> {
  let domain: string | undefined;
  try {
    if (args.sourceUrl) domain = new URL(args.sourceUrl).hostname.toLowerCase();
  } catch {
    // malformed/relative sourceUrl — feedback still recorded, just undomained
  }

  await ReviewFeedbackModel.create({
    scholarshipId: args.scholarshipId,
    decision: args.decision,
    domain,
    confidence: args.confidence ?? 0,
    classificationScore: args.classificationScore ?? 0,
    classificationReasons: args.classificationReasons ?? [],
    extractionMethod: args.extractionMethod ?? 'RULES',
    reviewedBy: args.reviewedBy
  });
}

/** Load persisted weights into the classifier's in-memory cache. Call at startup. */
export async function loadClassifierWeights(): Promise<void> {
  try {
    const doc = await ClassifierWeightModel.findById('default').lean();
    const raw = doc?.weights as unknown;
    if (raw) {
      const obj = raw instanceof Map ? Object.fromEntries(raw) : (raw as Record<string, number>);
      setClassifierWeights(obj);
    }
  } catch (err) {
    logger.error({ err }, 'scholarship: failed to load classifier weights at startup');
  }
}

type Tally = Map<string, { approved: number; rejected: number }>;

function bump(tally: Tally, key: string, decision: 'APPROVED' | 'REJECTED'): void {
  const t = tally.get(key) ?? { approved: 0, rejected: 0 };
  if (decision === 'APPROVED') t.approved += 1; else t.rejected += 1;
  tally.set(key, t);
}

export interface LearningSummary {
  processed: number;
  weightsAdjusted: number;
  domainsAdjusted: number;
}

/** Run one learning pass over feedback collected since the last pass. */
export async function learnFromFeedback(): Promise<LearningSummary> {
  const rows = await ReviewFeedbackModel.find({ consumedAt: null })
    .select('decision domain classificationReasons')
    .limit(BATCH_LIMIT)
    .lean();

  if (rows.length === 0) return { processed: 0, weightsAdjusted: 0, domainsAdjusted: 0 };

  const reasonTally: Tally = new Map();
  const domainTally: Tally = new Map();
  for (const r of rows) {
    for (const reason of r.classificationReasons ?? []) bump(reasonTally, reason, r.decision as any);
    if (r.domain) bump(domainTally, r.domain, r.decision as any);
  }

  // ── 1. Classifier weight nudges ──
  const weights = getClassifierWeights();
  let weightsAdjusted = 0;
  for (const [reason, { approved, rejected }] of reasonTally) {
    const total = approved + rejected;
    if (total < MIN_SAMPLES) continue;
    const approveRate = approved / total;
    const prev = weights[reason] ?? 1;
    let next = prev;
    if (approveRate >= HIGH_APPROVE_RATE) next = prev * (1 + NUDGE_STEP);
    else if (approveRate <= LOW_APPROVE_RATE) next = prev * (1 - NUDGE_STEP);
    next = Math.min(WEIGHT_MAX, Math.max(WEIGHT_MIN, next));
    if (next !== prev) { weights[reason] = next; weightsAdjusted += 1; }
  }
  if (weightsAdjusted > 0) {
    setClassifierWeights(weights);
    await ClassifierWeightModel.findByIdAndUpdate(
      'default',
      { $set: { weights, updatedAt: new Date() } },
      { upsert: true }
    );
  }

  // ── 2. Crawl-target priority nudges, per source domain ──
  let domainsAdjusted = 0;
  for (const [domain, { approved, rejected }] of domainTally) {
    const total = approved + rejected;
    if (total < MIN_SAMPLES) continue;
    const approveRate = approved / total;
    if (approveRate <= DOMAIN_LOW_APPROVE_RATE) {
      const res = await CrawlTargetModel.updateMany(
        { domain, status: { $ne: 'BLOCKED' }, priority: { $gt: 5 } },
        { $set: { priority: 5 } }
      );
      if (res.modifiedCount > 0) domainsAdjusted += 1;
    } else if (approveRate >= DOMAIN_HIGH_APPROVE_RATE) {
      const res = await CrawlTargetModel.updateMany(
        { domain, priority: { $lt: 80 } },
        { $set: { priority: 80 } }
      );
      if (res.modifiedCount > 0) domainsAdjusted += 1;
    }
  }

  await ReviewFeedbackModel.updateMany(
    { _id: { $in: rows.map((r) => r._id) } },
    { $set: { consumedAt: new Date() } }
  );

  logger.info({ processed: rows.length, weightsAdjusted, domainsAdjusted }, 'scholarship: learning pass complete');
  return { processed: rows.length, weightsAdjusted, domainsAdjusted };
}

export interface LearningSnapshot {
  weights: Array<{ reason: string; weight: number; approved: number; rejected: number; approveRate: number }>;
  domains: Array<{ domain: string; approved: number; rejected: number; approveRate: number }>;
  pendingFeedback: number;
}

/** Read-only view for the admin panel — last 90 days, not just the unconsumed batch. */
export async function getLearningSnapshot(): Promise<LearningSnapshot> {
  const since = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
  const [rows, pendingFeedback] = await Promise.all([
    ReviewFeedbackModel.find({ createdAt: { $gte: since } })
      .select('decision domain classificationReasons')
      .limit(5000)
      .lean(),
    ReviewFeedbackModel.countDocuments({ consumedAt: null })
  ]);

  const reasonTally: Tally = new Map();
  const domainTally: Tally = new Map();
  for (const r of rows) {
    for (const reason of r.classificationReasons ?? []) bump(reasonTally, reason, r.decision as any);
    if (r.domain) bump(domainTally, r.domain, r.decision as any);
  }

  const currentWeights = getClassifierWeights();
  const rate = (a: number, b: number) => (a + b > 0 ? a / (a + b) : 0);

  const weights = [...reasonTally.entries()]
    .map(([reason, { approved, rejected }]) => ({
      reason, weight: currentWeights[reason] ?? 1, approved, rejected, approveRate: rate(approved, rejected)
    }))
    .sort((a, b) => (b.approved + b.rejected) - (a.approved + a.rejected));

  const domains = [...domainTally.entries()]
    .map(([domain, { approved, rejected }]) => ({
      domain, approved, rejected, approveRate: rate(approved, rejected)
    }))
    .sort((a, b) => (b.approved + b.rejected) - (a.approved + a.rejected));

  return { weights, domains, pendingFeedback };
}
