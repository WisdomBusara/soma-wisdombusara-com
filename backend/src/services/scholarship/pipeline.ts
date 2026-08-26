import { env } from '../../config/env';
import { logger } from '../../config/logger';
import { UniversityModel } from '../../models/scholarship/University';
import { ScholarshipModel } from '../../models/scholarship/Scholarship';
import { CrawlTargetModel, CrawlRunModel } from '../../models/scholarship/operational';
import type { SourceType } from '../../models/scholarship/types';
import { fetchPage, type FetchResult } from './fetcher';
import { classifyScholarshipPage, classifyScholarshipLink } from './scholarshipClassifier';
import { extractScholarship, type ScholarshipDraft } from './extractor';
import { computeFingerprint, findDuplicate, attachSource, classifySourceType } from './dedupe';
import { computeStatus, detectChanges, recordChanges } from './status';
import { canonicalUrl, isSameSite } from './normalize/text';
import { enqueueTarget } from './discovery/scholarshipDiscovery';
import { resetAiBudget, aiCallsUsed } from './extractor/ai';

/**
 * The pipeline (§66).
 *
 * crawl target → fetch → classify → extract → normalize → dedupe → save →
 * status → attach source → enqueue discovered links
 *
 * Two invariants hold throughout:
 *
 *   1. One failure never takes down the run. Every target is wrapped; a DNS
 *      error, a malformed PDF, an AI timeout or a Mongo hiccup marks that one
 *      target FAILED and the loop continues (§37).
 *   2. Dry run does all the reading and none of the writing, so an operator can
 *      see exactly what a run *would* do (§51).
 */

export interface RunMetrics {
  urlsCrawled: number;
  urlsSkippedUnchanged: number;
  urlsDiscovered: number;
  bytesFetched: number;
  browserRenders: number;
  pdfsParsed: number;
  candidates: number;
  scholarshipsCreated: number;
  scholarshipsUpdated: number;
  duplicatesMerged: number;
  changesDetected: number;
  aiCalls: number;
  aiFailures: number;
  validationFailures: number;
  httpFailures: number;
  blocked: number;
}

const emptyMetrics = (): RunMetrics => ({
  urlsCrawled: 0, urlsSkippedUnchanged: 0, urlsDiscovered: 0, bytesFetched: 0,
  browserRenders: 0, pdfsParsed: 0, candidates: 0, scholarshipsCreated: 0,
  scholarshipsUpdated: 0, duplicatesMerged: 0, changesDetected: 0,
  aiCalls: 0, aiFailures: 0, validationFailures: 0, httpFailures: 0, blocked: 0
});

export interface ProcessResult {
  url: string;
  status: 'SAVED' | 'UPDATED' | 'DUPLICATE' | 'NOT_SCHOLARSHIP' | 'LANDING' | 'UNCHANGED' | 'FAILED' | 'BLOCKED';
  scholarshipId?: string;
  title?: string;
  classificationScore?: number;
  confidence?: number;
  reason?: string;
  changes?: number;
  linksEnqueued?: number;
}

/** Turn a draft plus context into the Mongo document shape. */
function toDocument(
  draft: ScholarshipDraft,
  ctx: {
    universityId?: unknown;
    universityName?: string;
    country: string;
    countryCode?: string | null;
    city?: string;
    fingerprint: string;
    confidence: number;
    qualityScore: number;
    classificationScore: number;
    classificationReasons: string[];
    method: string;
    sourceUrl: string;
  }
) {
  const now = new Date();
  const status = computeStatus({
    deadlineKind: draft.deadline.kind,
    deadlineDate: draft.deadline.date,
    confidence: ctx.confidence
  }, now);

  return {
    title: draft.title,
    normalizedTitle: draft.normalizedTitle,
    universityId: ctx.universityId,
    universityName: ctx.universityName,
    provider: draft.provider ?? undefined,
    country: ctx.country,
    countryCode: ctx.countryCode ?? undefined,
    city: ctx.city,
    degreeLevels: draft.degreeLevels,
    degreeLevelSourceText: draft.degreeEvidence,
    fieldsOfStudy: draft.fieldsOfStudy,
    studyMode: draft.studyMode,
    attendance: draft.attendance,
    deliveryMode: draft.deliveryMode,
    funding: draft.funding,
    eligibility: draft.eligibility,
    requirements: draft.requirements,
    deadline: {
      kind: draft.deadline.kind,
      date: draft.deadline.date,
      additionalDates: draft.deadline.additionalDates,
      originalText: draft.deadline.originalText,
      timezoneStated: draft.deadline.timezoneStated,
      confidence: draft.deadline.confidence,
      certainty: draft.deadline.certainty,
      sourceUrl: ctx.sourceUrl
    },
    intake: draft.intake ?? undefined,
    academicYear: draft.academicYear ?? undefined,
    duration: draft.duration ?? undefined,
    applicationUrl: {
      value: draft.applicationUrl.value,
      confidence: draft.applicationUrl.confidence,
      certainty: draft.applicationUrl.value ? 'CONFIRMED' : 'UNKNOWN',
      sourceUrl: ctx.sourceUrl,
      sourceText: draft.applicationUrl.sourceText
    },
    sourceUrl: ctx.sourceUrl,
    description: draft.description ?? undefined,
    status,
    // Anything below the floor goes to a human before it is trusted (§34)
    reviewStatus: ctx.confidence >= 0.75 ? 'AUTO_APPROVED' : 'NEEDS_REVIEW',
    confidence: ctx.confidence,
    qualityScore: ctx.qualityScore,
    classificationScore: ctx.classificationScore,
    classificationReasons: ctx.classificationReasons,
    fingerprint: ctx.fingerprint,
    lastCrawledAt: now,
    extractionMethod: ctx.method
  };
}

export interface ProcessOptions {
  universityId?: unknown;
  crawlRunId?: unknown;
  crawlTargetId?: unknown;
  dryRun?: boolean;
  allowAi?: boolean;
  metrics?: RunMetrics;
  /** Enqueue scholarship links found on this page (landing-page expansion) */
  followLinks?: boolean;
  depth?: number;
}

/**
 * Process one URL end to end.
 *
 * This is the function the CLI's `extract one URL` command calls, the crawl
 * loop calls, and the admin "force crawl" calls — one code path, so what an
 * operator sees in a dry run is exactly what production does.
 */
export async function processUrl(url: string, opts: ProcessOptions = {}): Promise<ProcessResult> {
  const metrics = opts.metrics ?? emptyMetrics();
  const dryRun = opts.dryRun ?? false;

  // Resolve institutional context up front — country and domain feed date
  // disambiguation and source-type classification.
  const university = opts.universityId
    ? await UniversityModel.findById(opts.universityId).select('name domain country countryCode city').lean()
    : null;

  // Skip the fetch entirely if content is unchanged (§54)
  const target = opts.crawlTargetId
    ? await CrawlTargetModel.findById(opts.crawlTargetId).select('contentHash').lean()
    : null;

  const page = await fetchPage(url, {
    knownContentHash: target?.contentHash ?? undefined,
    allowBrowser: true
  });

  if (!page.ok) {
    if (page.blocked) {
      metrics.blocked += 1;
      return { url, status: 'BLOCKED', reason: page.blockedReason ?? page.error };
    }
    metrics.httpFailures += 1;
    return { url, status: 'FAILED', reason: page.error };
  }

  metrics.urlsCrawled += 1;
  metrics.bytesFetched += page.bytes;
  if (page.method === 'BROWSER') metrics.browserRenders += 1;
  if (page.method === 'PDF') metrics.pdfsParsed += 1;

  if (page.method === 'CACHED') {
    metrics.urlsSkippedUnchanged += 1;
    if (!dryRun && opts.crawlTargetId) {
      await CrawlTargetModel.updateOne(
        { _id: opts.crawlTargetId },
        { $set: { status: 'COMPLETED', lastCrawledAt: new Date(), httpStatus: page.status, leaseUntil: null } }
      );
    }
    return { url, status: 'UNCHANGED', reason: 'content hash unchanged since last crawl' };
  }

  // ── Classify ──────────────────────────────────────────────────────────────
  const verdict = classifyScholarshipPage({
    url: page.finalUrl,
    title: page.title,
    metaDescription: page.metaDescription,
    headings: page.headings,
    text: page.text,
    structuredDataTypes: page.structuredDataTypes,
    linkTexts: page.links.map((l) => l.text)
  });

  // A landing page is not a result — it is a source of more targets.
  let linksEnqueued = 0;
  if ((verdict.isLandingPage || opts.followLinks) && (opts.depth ?? 0) < env.SCHOLARSHIP_MAX_DEPTH) {
    for (const link of page.links) {
      if (university?.domain && !isSameSite(link.href, university.domain)) continue;
      const lv = classifyScholarshipLink(link);
      if (lv.type !== 'scholarship') continue;
      metrics.urlsDiscovered += 1;
      if (dryRun) { linksEnqueued += 1; continue; }
      const r = await enqueueTarget({
        url: link.href,
        universityId: opts.universityId,
        priority: 75,
        depth: (opts.depth ?? 0) + 1,
        discoveredFrom: page.finalUrl
      });
      if (r === 'created') linksEnqueued += 1;
      if (linksEnqueued > 120) break;
    }
  }

  if (verdict.isLandingPage) {
    return { url: page.finalUrl, status: 'LANDING', classificationScore: verdict.score, linksEnqueued, reason: 'scholarship index page' };
  }
  if (!verdict.isScholarship) {
    return { url: page.finalUrl, status: 'NOT_SCHOLARSHIP', classificationScore: verdict.score, reason: verdict.reasons.join('; '), linksEnqueued };
  }

  metrics.candidates += 1;

  // ── Extract ───────────────────────────────────────────────────────────────
  const sourceType: SourceType = classifySourceType(page.finalUrl, university?.domain, page.contentType);
  const aiBefore = aiCallsUsed();

  const extraction = await extractScholarship(page, {
    sourceType,
    classificationScore: verdict.score,
    universityName: university?.name,
    countryCode: university?.countryCode ?? undefined,
    crawlRunId: opts.crawlRunId,
    crawlTargetId: opts.crawlTargetId,
    allowAi: opts.allowAi,
    dryRun
  });

  metrics.aiCalls += aiCallsUsed() - aiBefore;
  if (extraction.aiState && !['SUCCESS', 'SKIPPED'].includes(extraction.aiState)) {
    metrics.aiFailures += 1;
    if (extraction.aiState === 'VALIDATION_FAILED') metrics.validationFailures += 1;
  }

  const draft = extraction.draft;

  // ── Data-quality gate (§46) ───────────────────────────────────────────────
  // Enough evidence to be a record at all: it must carry at least two of
  // funding / eligibility / deadline / application information.
  const evidenceCount = [
    draft.funding.primaryType !== 'UNKNOWN',
    draft.eligibility.scope !== 'UNKNOWN',
    draft.deadline.kind !== 'UNKNOWN',
    Boolean(draft.applicationUrl.value) || draft.requirements.documents.length > 0
  ].filter(Boolean).length;

  if (evidenceCount < 2) {
    return {
      url: page.finalUrl,
      status: 'NOT_SCHOLARSHIP',
      classificationScore: verdict.score,
      confidence: extraction.confidence,
      reason: `insufficient extracted evidence (${evidenceCount}/4 classes)`,
      linksEnqueued
    };
  }

  // ── Dedupe ────────────────────────────────────────────────────────────────
  const fingerprint = computeFingerprint({
    universityId: opts.universityId,
    normalizedTitle: draft.normalizedTitle,
    academicYear: draft.academicYear,
    degreeLevels: draft.degreeLevels,
    provider: draft.provider
  });
  const canonical = canonicalUrl(page.finalUrl);

  const duplicate = await findDuplicate({
    fingerprint,
    canonicalUrl: canonical,
    contentHash: page.contentHash,
    universityId: opts.universityId,
    normalizedTitle: draft.normalizedTitle,
    academicYear: draft.academicYear
  });

  const doc = toDocument(draft, {
    universityId: opts.universityId,
    universityName: university?.name,
    country: university?.country ?? 'Unknown',
    countryCode: university?.countryCode,
    city: university?.city ?? undefined,
    fingerprint,
    confidence: extraction.confidence,
    qualityScore: extraction.qualityScore,
    classificationScore: verdict.score,
    classificationReasons: verdict.reasons,
    method: extraction.method,
    sourceUrl: page.finalUrl
  });

  if (dryRun) {
    return {
      url: page.finalUrl,
      status: duplicate ? 'DUPLICATE' : 'SAVED',
      title: draft.title,
      classificationScore: verdict.score,
      confidence: extraction.confidence,
      reason: duplicate ? `would attach as ${duplicate.matchType} source to ${duplicate.scholarshipId}` : 'would create',
      linksEnqueued
    };
  }

  // ── Persist ───────────────────────────────────────────────────────────────
  if (duplicate) {
    const existing = await ScholarshipModel.findById(duplicate.scholarshipId).lean();
    let changeCount = 0;

    if (existing) {
      const changes = detectChanges(existing, doc);
      changeCount = await recordChanges(existing._id, changes, { sourceUrl: page.finalUrl, crawlRunId: opts.crawlRunId });
      metrics.changesDetected += changeCount;

      // Only let a better-quality extraction overwrite the stored fields. A
      // faculty page summary must not degrade a rich scholarship-office record.
      const shouldUpdate = extraction.qualityScore >= (existing.qualityScore ?? 0) - 0.05;
      const update: Record<string, unknown> = { lastCrawledAt: new Date() };
      if (shouldUpdate) {
        Object.assign(update, doc);
        // Never regress a human decision
        delete (update as any).reviewStatus;
        delete (update as any).fingerprint;
      }
      await ScholarshipModel.updateOne({ _id: existing._id }, { $set: update });
      metrics.scholarshipsUpdated += 1;
    }

    await attachSource({
      scholarshipId: duplicate.scholarshipId,
      universityId: opts.universityId,
      sourceUrl: page.finalUrl,
      sourceType,
      contentType: page.contentType,
      title: page.title,
      contentHash: page.contentHash,
      httpStatus: page.status
    });
    metrics.duplicatesMerged += 1;

    return {
      url: page.finalUrl,
      status: 'UPDATED',
      scholarshipId: duplicate.scholarshipId,
      title: draft.title,
      classificationScore: verdict.score,
      confidence: extraction.confidence,
      changes: changeCount,
      reason: `matched existing by ${duplicate.matchType}`,
      linksEnqueued
    };
  }

  let created;
  try {
    created = await ScholarshipModel.create({ ...doc, discoveredAt: new Date() });
  } catch (err: any) {
    // Lost a race on the unique fingerprint index — attach instead of failing
    if (err?.code === 11000) {
      const winner = await ScholarshipModel.findOne({ fingerprint }).select('_id').lean();
      if (winner) {
        await attachSource({
          scholarshipId: winner._id, universityId: opts.universityId, sourceUrl: page.finalUrl,
          sourceType, contentType: page.contentType, title: page.title,
          contentHash: page.contentHash, httpStatus: page.status
        });
        metrics.duplicatesMerged += 1;
        return { url: page.finalUrl, status: 'DUPLICATE', scholarshipId: String(winner._id), title: draft.title, reason: 'concurrent insert race resolved' };
      }
    }
    throw err;
  }

  await attachSource({
    scholarshipId: created._id,
    universityId: opts.universityId,
    sourceUrl: page.finalUrl,
    sourceType,
    contentType: page.contentType,
    title: page.title,
    contentHash: page.contentHash,
    httpStatus: page.status
  });

  metrics.scholarshipsCreated += 1;
  if (opts.universityId) {
    await UniversityModel.updateOne({ _id: opts.universityId }, { $inc: { 'stats.scholarshipsFound': 1 } });
  }

  return {
    url: page.finalUrl,
    status: 'SAVED',
    scholarshipId: String(created._id),
    title: draft.title,
    classificationScore: verdict.score,
    confidence: extraction.confidence,
    linksEnqueued
  };
}

// ── Queue draining ──────────────────────────────────────────────────────────

/**
 * Claim a batch of due targets.
 *
 * findOneAndUpdate with a lease is what makes this safe to run on more than one
 * machine — the same pattern the existing JobScheduler uses for its run lock.
 */
async function claimTargets(limit: number): Promise<any[]> {
  const now = new Date();
  const leaseUntil = new Date(now.getTime() + 15 * 60_000);
  const claimed: any[] = [];

  for (let i = 0; i < limit; i += 1) {
    const doc = await CrawlTargetModel.findOneAndUpdate(
      {
        status: { $in: ['PENDING', 'FAILED'] },
        nextCrawlAt: { $lte: now },
        attempts: { $lt: env.SCHOLARSHIP_RETRY_LIMIT },
        $or: [{ leaseUntil: null }, { leaseUntil: { $lt: now } }]
      },
      { $set: { status: 'PROCESSING', leaseUntil }, $inc: { attempts: 1 } },
      { new: true, sort: { priority: -1, nextCrawlAt: 1 } }
    ).lean();
    if (!doc) break;
    claimed.push(doc);
  }
  return claimed;
}

/** Exponential backoff between retries, capped so a target is not lost forever. */
function backoffFor(attempts: number): Date {
  const minutes = Math.min(60 * 24, 15 * 2 ** Math.max(0, attempts - 1));
  return new Date(Date.now() + minutes * 60_000);
}

export interface CrawlRunOptions {
  limit?: number;
  dryRun?: boolean;
  trigger?: 'CRON' | 'ADMIN' | 'CLI';
  universityId?: string;
  allowAi?: boolean;
  onProgress?: (done: number, total: number, url: string) => void;
}

export interface CrawlRunSummary {
  runId: string | null;
  processed: number;
  metrics: RunMetrics;
  results: ProcessResult[];
}

/**
 * Drain the crawl queue.
 *
 * Concurrency is bounded here AND per-domain in politeness.ts — the two limits
 * compose so a run can be wide across many institutions while staying gentle
 * on each one.
 */
export async function runCrawl(opts: CrawlRunOptions = {}): Promise<CrawlRunSummary> {
  const limit = Math.min(opts.limit ?? 50, env.SCHOLARSHIP_MAX_TARGETS_PER_RUN);
  const dryRun = opts.dryRun ?? false;
  const metrics = emptyMetrics();
  resetAiBudget();

  const run = dryRun
    ? null
    : await CrawlRunModel.create({
        kind: 'CRAWL',
        trigger: opts.trigger ?? 'CRON',
        dryRun,
        state: 'RUNNING',
        startedAt: new Date(),
        scope: opts.universityId ? { universityId: opts.universityId } : {}
      });

  const targets = opts.universityId
    ? await CrawlTargetModel.find({ universityId: opts.universityId, status: { $ne: 'BLOCKED' } })
        .sort({ priority: -1 })
        .limit(limit)
        .lean()
    : await claimTargets(limit);

  const results: ProcessResult[] = [];
  let done = 0;

  const worker = async (queue: any[]) => {
    while (queue.length > 0) {
      const target = queue.shift();
      if (!target) break;
      try {
        const result = await processUrl(target.url, {
          universityId: target.universityId,
          crawlRunId: run?._id,
          crawlTargetId: target._id,
          dryRun,
          allowAi: opts.allowAi,
          metrics,
          depth: target.depth ?? 0
        });
        results.push(result);

        if (!dryRun) {
          const status =
            result.status === 'BLOCKED' ? 'BLOCKED'
            : result.status === 'FAILED' ? 'FAILED'
            : 'COMPLETED';
          await CrawlTargetModel.updateOne(
            { _id: target._id },
            {
              $set: {
                status,
                lastCrawledAt: new Date(),
                leaseUntil: null,
                candidateScore: result.classificationScore ?? 0,
                scholarshipsFound: result.status === 'SAVED' || result.status === 'UPDATED' ? 1 : 0,
                lastError: result.status === 'FAILED' || result.status === 'BLOCKED' ? result.reason : undefined,
                // Successful pages are revisited on the standard cadence;
                // failures back off.
                nextCrawlAt: status === 'COMPLETED'
                  ? new Date(Date.now() + 7 * 86_400_000)
                  : backoffFor((target.attempts ?? 0) + 1)
              }
            }
          );
        }
      } catch (err: any) {
        // §37 — isolate. One target's failure is one target's failure.
        logger.error({ err, url: target.url }, 'scholarship: target processing failed');
        results.push({ url: target.url, status: 'FAILED', reason: err?.message ?? 'unknown error' });
        metrics.httpFailures += 1;
        if (!dryRun) {
          await CrawlTargetModel.updateOne(
            { _id: target._id },
            { $set: { status: 'FAILED', lastError: String(err?.message ?? err).slice(0, 500), leaseUntil: null, nextCrawlAt: backoffFor((target.attempts ?? 0) + 1) } }
          ).catch(() => undefined);
        }
      }
      done += 1;
      opts.onProgress?.(done, targets.length, target.url);
    }
  };

  const queue = [...targets];
  await Promise.all(
    Array.from({ length: Math.min(env.SCHOLARSHIP_CRAWL_CONCURRENCY, queue.length || 1) }, () => worker(queue))
  );

  if (run) {
    await CrawlRunModel.updateOne(
      { _id: run._id },
      {
        $set: {
          state: 'COMPLETED',
          finishedAt: new Date(),
          durationMs: Date.now() - run.startedAt.getTime(),
          metrics,
          log: results.slice(0, 200).map((r) => `${r.status} ${r.url}${r.reason ? ` — ${r.reason}` : ''}`)
        }
      }
    );
  }

  logger.info({ processed: done, ...metrics }, 'scholarship: crawl run complete');
  return { runId: run ? String(run._id) : null, processed: done, metrics, results };
}
