import { Router } from 'express';
import { isValidObjectId } from 'mongoose';
import { z } from 'zod';

import { logger } from '../config/logger';
import { ScholarshipModel } from '../models/scholarship/Scholarship';
import { UniversityModel } from '../models/scholarship/University';
import {
  CrawlTargetModel,
  CrawlRunModel,
  ExtractionRunModel,
  ScholarshipChangeModel,
  ScholarshipSourceModel
} from '../models/scholarship/operational';
import { runCrawl, processUrl } from '../services/scholarship/pipeline';
import { runScholarshipCycle, engineMetrics, reprioritizeTargets } from '../services/scholarship/scholarshipScheduler';
import { discoverUniversities } from '../services/scholarship/discovery/universityDiscovery';
import { discoverScholarshipUrls } from '../services/scholarship/discovery/scholarshipDiscovery';
import { refreshStatuses } from '../services/scholarship/status';
import { domainStats } from '../services/scholarship/politeness';
import { AdSlotModel, AD_PLACEMENTS, ScholarshipAccessModel } from '../models/scholarship/access';
import { getScholarshipBotStatus } from '../services/scholarship/delivery/telegram';

/**
 * Scholarship admin surface (§32, §33, §34, §61).
 *
 * Mounted under the existing adminRouter, so it inherits requireAuth() and
 * requireCsrf() — no new auth path, no new attack surface.
 *
 * Long-running actions (crawl, discovery, full cycle) return immediately and
 * run detached. The admin polls /scholarship/metrics or /scholarship/runs for
 * progress, which is the same pattern the jobs vertical uses for its report.
 */

const objectId = (v: string) => isValidObjectId(v);

export function scholarshipAdminRouter() {
  const router = Router();

  // ── Dashboard ─────────────────────────────────────────────────────────────

  router.get('/metrics', async (_req, res, next) => {
    try {
      return res.json(await engineMetrics());
    } catch (err) { return next(err); }
  });

  router.get('/domains', (_req, res) => {
    // Live politeness state — which domains are in backoff right now
    return res.json({ domains: domainStats() });
  });

  router.get('/bot-status', async (_req, res, next) => {
    try {
      return res.json(await getScholarshipBotStatus());
    } catch (err) { return next(err); }
  });

  // ── Scholarships ──────────────────────────────────────────────────────────

  router.get('/scholarships', async (req, res, next) => {
    try {
      const q = z.object({
        status: z.string().optional(),
        reviewStatus: z.string().optional(),
        country: z.string().optional(),
        university: z.string().optional(),
        degree: z.string().optional(),
        minConfidence: z.coerce.number().min(0).max(1).optional(),
        maxConfidence: z.coerce.number().min(0).max(1).optional(),
        q: z.string().max(200).optional(),
        page: z.coerce.number().int().min(1).default(1),
        limit: z.coerce.number().int().min(1).max(100).default(25)
      }).parse(req.query);

      const filter: Record<string, any> = {};
      if (q.status) filter.status = { $in: q.status.split(',') };
      if (q.reviewStatus) filter.reviewStatus = { $in: q.reviewStatus.split(',') };
      if (q.country) filter.countryCode = { $in: q.country.split(',').map((c) => c.toUpperCase()) };
      if (q.university && objectId(q.university)) filter.universityId = q.university;
      if (q.degree) filter.degreeLevels = { $in: q.degree.split(',').map((d) => d.toUpperCase()) };
      if (q.minConfidence !== undefined || q.maxConfidence !== undefined) {
        filter.confidence = {};
        if (q.minConfidence !== undefined) filter.confidence.$gte = q.minConfidence;
        if (q.maxConfidence !== undefined) filter.confidence.$lte = q.maxConfidence;
      }
      if (q.q) filter.$text = { $search: q.q };

      const [rows, total] = await Promise.all([
        ScholarshipModel.find(filter)
          .select('title universityName country countryCode degreeLevels funding.primaryType studyMode attendance deadline status reviewStatus confidence qualityScore lastVerifiedAt lastCrawledAt sourceCount hasOfficialSource extractionMethod')
          .sort({ confidence: 1, createdAt: -1 })
          .skip((q.page - 1) * q.limit)
          .limit(q.limit)
          .lean(),
        ScholarshipModel.countDocuments(filter).limit(10_000)
      ]);

      return res.json({
        items: rows.map((s) => ({
          id: String(s._id),
          title: s.title,
          university: s.universityName ?? null,
          country: s.country,
          degreeLevels: s.degreeLevels,
          funding: s.funding?.primaryType ?? 'UNKNOWN',
          studyMode: s.studyMode,
          attendance: s.attendance,
          deadline: s.deadline?.date ?? null,
          deadlineKind: s.deadline?.kind ?? 'UNKNOWN',
          status: s.status,
          reviewStatus: s.reviewStatus,
          confidence: s.confidence,
          qualityScore: s.qualityScore,
          sourceCount: s.sourceCount,
          hasOfficialSource: s.hasOfficialSource,
          extractionMethod: s.extractionMethod,
          lastVerifiedAt: s.lastVerifiedAt ?? null,
          lastCrawledAt: s.lastCrawledAt
        })),
        pagination: { page: q.page, limit: q.limit, total, totalPages: Math.ceil(total / q.limit) }
      });
    } catch (err) { return next(err); }
  });

  /**
   * Full review payload (§34): raw extraction, evidence snippets, AI output and
   * normalized values side by side so a human can adjudicate without leaving
   * the admin.
   */
  router.get('/scholarships/:id', async (req, res, next) => {
    try {
      const id = String(req.params.id);
      if (!objectId(id)) return res.status(400).json({ error: 'Invalid id' });

      const s = await ScholarshipModel.findById(id).lean();
      if (!s) return res.status(404).json({ error: 'Not found' });

      const [sources, changes, extractions] = await Promise.all([
        ScholarshipSourceModel.find({ scholarshipId: s._id }).sort({ isPrimary: -1 }).lean(),
        ScholarshipChangeModel.find({ scholarshipId: s._id }).sort({ detectedAt: -1 }).limit(50).lean(),
        ExtractionRunModel.find({ scholarshipId: s._id }).sort({ createdAt: -1 }).limit(10).lean()
      ]);

      return res.json({
        scholarship: { ...s, id: String(s._id) },
        sources: sources.map((x) => ({ ...x, id: String(x._id) })),
        changes: changes.map((c) => ({ ...c, id: String(c._id) })),
        extractions: extractions.map((e) => ({
          id: String(e._id),
          method: e.method,
          provider: e.provider,
          model: e.model,
          state: e.state,
          durationMs: e.durationMs,
          validationErrors: e.validationErrors,
          rawOutput: e.rawOutput?.slice(0, 8000),
          createdAt: e.createdAt
        }))
      });
    } catch (err) { return next(err); }
  });

  /** APPROVE / REJECT / EDIT (§34) */
  router.patch('/scholarships/:id', async (req, res, next) => {
    try {
      const id = String(req.params.id);
      if (!objectId(id)) return res.status(400).json({ error: 'Invalid id' });

      const body = z.object({
        action: z.enum(['APPROVE', 'REJECT', 'EDIT']),
        note: z.string().max(1000).optional(),
        patch: z.record(z.unknown()).optional()
      }).parse(req.body);

      const update: Record<string, unknown> = {
        reviewedBy: (req as any).auth?.userId,
        reviewedAt: new Date(),
        reviewNote: body.note
      };

      if (body.action === 'APPROVE') {
        update.reviewStatus = 'APPROVED';
        update.lastVerifiedAt = new Date();
      } else if (body.action === 'REJECT') {
        update.reviewStatus = 'REJECTED';
        // Not deleted — kept so the crawler does not re-create it next cycle
        update.status = 'CLOSED';
      } else if (body.patch) {
        // Manual edits are authoritative and marked as such
        const allowed = [
          'title', 'provider', 'degreeLevels', 'fieldsOfStudy', 'studyMode',
          'attendance', 'deliveryMode', 'academicYear', 'intake', 'duration',
          'description', 'city'
        ];
        for (const [k, v] of Object.entries(body.patch)) {
          if (allowed.includes(k)) update[k] = v;
        }
        update.extractionMethod = 'MANUAL';
        update.reviewStatus = 'APPROVED';
      }

      const updated = await ScholarshipModel.findByIdAndUpdate(id, { $set: update }, { new: true }).lean();
      if (!updated) return res.status(404).json({ error: 'Not found' });

      await ScholarshipChangeModel.create({
        scholarshipId: id,
        field: 'reviewStatus',
        oldValue: null,
        newValue: update.reviewStatus,
        changeType: 'UPDATED',
        significance: 'MINOR',
        detectedAt: new Date()
      }).catch(() => undefined);

      return res.json({ id, reviewStatus: updated.reviewStatus, status: updated.status });
    } catch (err) { return next(err); }
  });

  /** RECRAWL a single scholarship's primary source */
  router.post('/scholarships/:id/recrawl', async (req, res, next) => {
    try {
      const id = String(req.params.id);
      if (!objectId(id)) return res.status(400).json({ error: 'Invalid id' });
      const s = await ScholarshipModel.findById(id).select('sourceUrl universityId').lean();
      if (!s) return res.status(404).json({ error: 'Not found' });

      const result = await processUrl(s.sourceUrl, { universityId: s.universityId, allowAi: true });
      return res.json({ result });
    } catch (err) { return next(err); }
  });

  // ── Universities ──────────────────────────────────────────────────────────

  router.get('/universities', async (req, res, next) => {
    try {
      const q = z.object({
        status: z.string().optional(),
        country: z.string().optional(),
        q: z.string().max(120).optional(),
        page: z.coerce.number().int().min(1).default(1),
        limit: z.coerce.number().int().min(1).max(100).default(25)
      }).parse(req.query);

      const filter: Record<string, any> = {};
      if (q.status) filter.status = { $in: q.status.split(',') };
      if (q.country) filter.countryCode = { $in: q.country.split(',').map((c) => c.toUpperCase()) };
      if (q.q) filter.$text = { $search: q.q };

      const [rows, total] = await Promise.all([
        UniversityModel.find(filter)
          .sort({ 'stats.scholarshipsFound': -1, name: 1 })
          .skip((q.page - 1) * q.limit)
          .limit(q.limit)
          .lean(),
        UniversityModel.countDocuments(filter).limit(10_000)
      ]);

      return res.json({
        items: rows.map((u) => ({
          id: String(u._id),
          name: u.name,
          domain: u.domain,
          website: u.website,
          country: u.country,
          countryCode: u.countryCode ?? null,
          city: u.city ?? null,
          type: u.type,
          status: u.status,
          crawlEnabled: u.crawlEnabled,
          discoverySource: u.discoverySource ?? null,
          verificationReason: u.verification?.reason ?? null,
          scholarshipUrlsFound: u.stats?.scholarshipUrlsFound ?? 0,
          scholarshipsFound: u.stats?.scholarshipsFound ?? 0,
          consecutiveFailures: u.consecutiveFailures ?? 0,
          lastCrawledAt: u.lastCrawledAt ?? null,
          lastVerifiedAt: u.lastVerifiedAt ?? null
        })),
        pagination: { page: q.page, limit: q.limit, total, totalPages: Math.ceil(total / q.limit) }
      });
    } catch (err) { return next(err); }
  });

  router.get('/universities/:id', async (req, res, next) => {
    try {
      const id = String(req.params.id);
      if (!objectId(id)) return res.status(400).json({ error: 'Invalid id' });
      const u = await UniversityModel.findById(id).lean();
      if (!u) return res.status(404).json({ error: 'Not found' });

      const [targets, scholarships] = await Promise.all([
        CrawlTargetModel.find({ universityId: u._id }).sort({ priority: -1 }).limit(100).lean(),
        ScholarshipModel.find({ universityId: u._id }).select('title status confidence deadline').limit(100).lean()
      ]);

      return res.json({
        university: { ...u, id: String(u._id) },
        crawlTargets: targets.map((t) => ({
          id: String(t._id),
          url: t.url,
          targetType: t.targetType,
          status: t.status,
          priority: t.priority,
          attempts: t.attempts,
          httpStatus: t.httpStatus ?? null,
          lastError: t.lastError ?? null,
          lastCrawledAt: t.lastCrawledAt ?? null,
          nextCrawlAt: t.nextCrawlAt ?? null,
          scholarshipsFound: t.scholarshipsFound
        })),
        scholarships: scholarships.map((s) => ({
          id: String(s._id), title: s.title, status: s.status,
          confidence: s.confidence, deadline: s.deadline?.date ?? null
        }))
      });
    } catch (err) { return next(err); }
  });

  router.patch('/universities/:id', async (req, res, next) => {
    try {
      const id = String(req.params.id);
      if (!objectId(id)) return res.status(400).json({ error: 'Invalid id' });
      const patch = z.object({
        crawlEnabled: z.boolean().optional(),
        status: z.enum(['ACTIVE', 'INACTIVE', 'UNVERIFIED']).optional(),
        crawlIntervalHours: z.number().int().min(1).max(24 * 90).optional(),
        scholarshipUrls: z.array(z.string().url()).max(100).optional()
      }).parse(req.body);

      const u = await UniversityModel.findByIdAndUpdate(id, { $set: patch }, { new: true }).lean();
      if (!u) return res.status(404).json({ error: 'Not found' });
      return res.json({ id, crawlEnabled: u.crawlEnabled, status: u.status });
    } catch (err) { return next(err); }
  });

  /** Force discovery + crawl for one institution */
  router.post('/universities/:id/crawl', async (req, res, next) => {
    try {
      const id = String(req.params.id);
      if (!objectId(id)) return res.status(400).json({ error: 'Invalid id' });
      const dryRun = ['true', '1'].includes(String(req.query.dryRun ?? ''));

      const discovery = await discoverScholarshipUrls(id, { dryRun });
      // Detached — a full institution crawl can outlive the request
      if (!dryRun) {
        void runCrawl({ universityId: id, limit: 50, trigger: 'ADMIN' }).catch((err) =>
          logger.error({ err, universityId: id }, 'scholarship: admin-triggered crawl failed')
        );
      }
      return res.json({ discovery, crawlStarted: !dryRun });
    } catch (err) { return next(err); }
  });

  // ── Crawl targets ─────────────────────────────────────────────────────────

  router.get('/targets', async (req, res, next) => {
    try {
      const q = z.object({
        status: z.string().optional(),
        domain: z.string().optional(),
        page: z.coerce.number().int().min(1).default(1),
        limit: z.coerce.number().int().min(1).max(100).default(50)
      }).parse(req.query);

      const filter: Record<string, any> = {};
      if (q.status) filter.status = { $in: q.status.split(',') };
      if (q.domain) filter.domain = q.domain.toLowerCase();

      const [rows, total] = await Promise.all([
        CrawlTargetModel.find(filter).sort({ priority: -1, updatedAt: -1 })
          .skip((q.page - 1) * q.limit).limit(q.limit).lean(),
        CrawlTargetModel.countDocuments(filter).limit(10_000)
      ]);

      return res.json({
        items: rows.map((t) => ({
          id: String(t._id), url: t.url, domain: t.domain, targetType: t.targetType,
          status: t.status, priority: t.priority, attempts: t.attempts,
          httpStatus: t.httpStatus ?? null, lastError: t.lastError ?? null,
          renderedWithBrowser: t.renderedWithBrowser,
          candidateScore: t.candidateScore, scholarshipsFound: t.scholarshipsFound,
          lastCrawledAt: t.lastCrawledAt ?? null, nextCrawlAt: t.nextCrawlAt ?? null
        })),
        pagination: { page: q.page, limit: q.limit, total, totalPages: Math.ceil(total / q.limit) }
      });
    } catch (err) { return next(err); }
  });

  router.post('/targets/:id/retry', async (req, res, next) => {
    try {
      const id = String(req.params.id);
      if (!objectId(id)) return res.status(400).json({ error: 'Invalid id' });
      await CrawlTargetModel.updateOne(
        { _id: id },
        { $set: { status: 'PENDING', attempts: 0, nextCrawlAt: new Date(), leaseUntil: null, lastError: null } }
      );
      return res.json({ ok: true });
    } catch (err) { return next(err); }
  });

  /** Ad-hoc: crawl one arbitrary URL and report what would happen */
  router.post('/crawl-url', async (req, res, next) => {
    try {
      const body = z.object({
        url: z.string().url(),
        universityId: z.string().optional(),
        dryRun: z.boolean().optional(),
        allowAi: z.boolean().optional()
      }).parse(req.body);

      const result = await processUrl(body.url, {
        universityId: body.universityId && objectId(body.universityId) ? body.universityId : undefined,
        dryRun: body.dryRun ?? false,
        allowAi: body.allowAi
      });
      return res.json({ result });
    } catch (err) { return next(err); }
  });

  // ── Runs & failures ───────────────────────────────────────────────────────

  router.get('/runs', async (req, res, next) => {
    try {
      const limit = Math.min(Number(req.query.limit ?? 25), 100);
      const runs = await CrawlRunModel.find({}).sort({ startedAt: -1 }).limit(limit).lean();
      return res.json({
        items: runs.map((r) => ({
          id: String(r._id), kind: r.kind, trigger: r.trigger, dryRun: r.dryRun,
          state: r.state, startedAt: r.startedAt, finishedAt: r.finishedAt ?? null,
          durationMs: r.durationMs ?? null, metrics: r.metrics, error: r.error ?? null
        }))
      });
    } catch (err) { return next(err); }
  });

  router.get('/runs/:id', async (req, res, next) => {
    try {
      const id = String(req.params.id);
      if (!objectId(id)) return res.status(400).json({ error: 'Invalid id' });
      const run = await CrawlRunModel.findById(id).lean();
      if (!run) return res.status(404).json({ error: 'Not found' });
      return res.json({ ...run, id: String(run._id) });
    } catch (err) { return next(err); }
  });

  router.get('/extractions', async (req, res, next) => {
    try {
      const q = z.object({
        state: z.string().optional(),
        limit: z.coerce.number().int().min(1).max(100).default(50)
      }).parse(req.query);
      const filter: Record<string, any> = {};
      if (q.state) filter.state = { $in: q.state.split(',') };
      const rows = await ExtractionRunModel.find(filter).sort({ createdAt: -1 }).limit(q.limit).lean();
      return res.json({
        items: rows.map((e) => ({
          id: String(e._id), sourceUrl: e.sourceUrl, method: e.method,
          provider: e.provider ?? null, model: e.model ?? null, state: e.state,
          durationMs: e.durationMs ?? null, validationErrors: e.validationErrors,
          error: e.error ?? null, createdAt: e.createdAt
        }))
      });
    } catch (err) { return next(err); }
  });

  router.get('/changes', async (req, res, next) => {
    try {
      const q = z.object({
        significance: z.enum(['MAJOR', 'MINOR']).optional(),
        limit: z.coerce.number().int().min(1).max(100).default(50)
      }).parse(req.query);
      const filter: Record<string, any> = {};
      if (q.significance) filter.significance = q.significance;
      const rows = await ScholarshipChangeModel.find(filter).sort({ detectedAt: -1 }).limit(q.limit).lean();

      // Attach titles without an $lookup — one extra indexed query beats an
      // aggregation pipeline for a page of 50.
      const ids = [...new Set(rows.map((r) => String(r.scholarshipId)))];
      const titles = await ScholarshipModel.find({ _id: { $in: ids } }).select('title').lean();
      const titleMap = new Map(titles.map((t) => [String(t._id), t.title]));

      return res.json({
        items: rows.map((c) => ({
          id: String(c._id),
          scholarshipId: String(c.scholarshipId),
          scholarshipTitle: titleMap.get(String(c.scholarshipId)) ?? null,
          field: c.field, oldValue: c.oldValue, newValue: c.newValue,
          changeType: c.changeType, significance: c.significance,
          detectedAt: c.detectedAt, sourceUrl: c.sourceUrl ?? null
        }))
      });
    } catch (err) { return next(err); }
  });

  router.get('/blocked', async (_req, res, next) => {
    try {
      const rows = await CrawlTargetModel.aggregate([
        { $match: { status: 'BLOCKED' } },
        { $group: { _id: '$domain', count: { $sum: 1 }, sample: { $first: '$lastError' } } },
        { $sort: { count: -1 } },
        { $limit: 100 }
      ]);
      return res.json({ items: rows.map((r) => ({ domain: r._id, count: r.count, reason: r.sample ?? null })) });
    } catch (err) { return next(err); }
  });

  // ── Operations ────────────────────────────────────────────────────────────

  router.post('/discover-universities', async (req, res, next) => {
    try {
      const body = z.object({
        countries: z.array(z.string()).max(50).optional(),
        limit: z.number().int().min(1).max(500).optional(),
        dryRun: z.boolean().optional()
      }).parse(req.body ?? {});
      const outcome = await discoverUniversities({
        countryCodes: body.countries, limit: body.limit, dryRun: body.dryRun
      });
      return res.json({ outcome });
    } catch (err) { return next(err); }
  });

  router.post('/run', async (req, res, next) => {
    try {
      const body = z.object({
        dryRun: z.boolean().optional(),
        crawlLimit: z.number().int().min(1).max(500).optional()
      }).parse(req.body ?? {});

      if (body.dryRun) {
        // Dry runs are bounded and safe to await
        const summary = await runScholarshipCycle({ trigger: 'ADMIN', dryRun: true, crawlLimit: body.crawlLimit ?? 20 });
        return res.json({ summary });
      }
      void runScholarshipCycle({ trigger: 'ADMIN', crawlLimit: body.crawlLimit }).catch((err) =>
        logger.error({ err }, 'scholarship: admin-triggered cycle failed')
      );
      return res.status(202).json({ started: true });
    } catch (err) { return next(err); }
  });

  router.post('/refresh-statuses', async (_req, res, next) => {
    try {
      return res.json(await refreshStatuses());
    } catch (err) { return next(err); }
  });

  router.post('/reprioritize', async (_req, res, next) => {
    try {
      return res.json(await reprioritizeTargets());
    } catch (err) { return next(err); }
  });

  // ── Ads (§ advertising) ───────────────────────────────────────────────────

  router.get('/ads', async (_req, res, next) => {
    try {
      const rows = await AdSlotModel.find({}).sort({ placement: 1, weight: -1 }).lean();
      return res.json({
        placements: AD_PLACEMENTS,
        items: rows.map((a) => ({
          ...a,
          id: String(a._id),
          // Click-through rate is the number that actually tells an operator
          // whether a placement is worth keeping.
          ctr: a.impressions > 0 ? Number(((a.clicks / a.impressions) * 100).toFixed(2)) : 0
        }))
      });
    } catch (err) { return next(err); }
  });

  const adSchema = z.object({
    name: z.string().min(1).max(120),
    placement: z.enum(AD_PLACEMENTS),
    type: z.enum(['HOUSE', 'NETWORK', 'CUSTOM']),
    headline: z.string().max(120).optional(),
    body: z.string().max(300).optional(),
    ctaLabel: z.string().max(40).optional(),
    imageUrl: z.string().url().max(600).optional().or(z.literal('')),
    targetUrl: z.string().url().max(600).optional().or(z.literal('')),
    advertiser: z.string().max(120).optional(),
    networkSlotId: z.string().max(60).optional(),
    html: z.string().max(8000).optional(),
    countries: z.array(z.string().length(2)).max(60).optional(),
    degreeLevels: z.array(z.string().max(30)).max(10).optional(),
    weight: z.number().int().min(0).max(100).optional(),
    isActive: z.boolean().optional(),
    startsAt: z.string().datetime().optional().or(z.literal('')),
    endsAt: z.string().datetime().optional().or(z.literal(''))
  });

  router.post('/ads', async (req, res, next) => {
    try {
      const body = adSchema.parse(req.body ?? {});
      const ad = await AdSlotModel.create({
        ...body,
        imageUrl: body.imageUrl || undefined,
        targetUrl: body.targetUrl || undefined,
        startsAt: body.startsAt || undefined,
        endsAt: body.endsAt || undefined
      });
      return res.status(201).json({ id: String(ad._id) });
    } catch (err) { return next(err); }
  });

  router.patch('/ads/:id', async (req, res, next) => {
    try {
      const id = String(req.params.id);
      if (!objectId(id)) return res.status(400).json({ error: 'Invalid id' });
      const patch = adSchema.partial().parse(req.body ?? {});
      const ad = await AdSlotModel.findByIdAndUpdate(id, { $set: patch }, { new: true }).lean();
      if (!ad) return res.status(404).json({ error: 'Not found' });
      return res.json({ id, isActive: ad.isActive });
    } catch (err) { return next(err); }
  });

  router.delete('/ads/:id', async (req, res, next) => {
    try {
      const id = String(req.params.id);
      if (!objectId(id)) return res.status(400).json({ error: 'Invalid id' });
      await AdSlotModel.deleteOne({ _id: id });
      return res.json({ ok: true });
    } catch (err) { return next(err); }
  });

  // ── Subscribers ───────────────────────────────────────────────────────────

  router.get('/subscribers', async (req, res, next) => {
    try {
      const q = z.object({
        status: z.string().optional(),
        page: z.coerce.number().int().min(1).default(1),
        limit: z.coerce.number().int().min(1).max(100).default(25)
      }).parse(req.query);

      const filter: Record<string, any> = {};
      if (q.status) filter.status = { $in: q.status.split(',') };

      const [rows, total, revenue] = await Promise.all([
        ScholarshipAccessModel.find(filter).sort({ createdAt: -1 })
          .skip((q.page - 1) * q.limit).limit(q.limit).lean(),
        ScholarshipAccessModel.countDocuments(filter).limit(10_000),
        ScholarshipAccessModel.aggregate([
          { $match: { status: { $in: ['active', 'expired'] } } },
          { $group: { _id: '$currency', total: { $sum: '$amountKobo' }, count: { $sum: 1 } } }
        ])
      ]);

      return res.json({
        items: rows.map((a) => ({
          id: String(a._id),
          email: a.email ?? null,
          phone: a.phone ?? null,
          planName: a.planName ?? null,
          status: a.status,
          startsAt: a.startsAt,
          endsAt: a.endsAt,
          amount: a.amountKobo ? a.amountKobo / 100 : null,
          currency: a.currency,
          deviceCount: a.deviceCount,
          lastSeenAt: a.lastSeenAt ?? null,
          reference: a.paystackReference ?? null
        })),
        revenue: revenue.map((r) => ({ currency: r._id, total: r.total / 100, count: r.count })),
        pagination: { page: q.page, limit: q.limit, total, totalPages: Math.ceil(total / q.limit) }
      });
    } catch (err) { return next(err); }
  });

  router.post('/subscribers/:id/revoke', async (req, res, next) => {
    try {
      const id = String(req.params.id);
      if (!objectId(id)) return res.status(400).json({ error: 'Invalid id' });
      await ScholarshipAccessModel.updateOne({ _id: id }, { $set: { status: 'revoked' } });
      return res.json({ ok: true });
    } catch (err) { return next(err); }
  });

  return router;
}
