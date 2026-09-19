import cors from 'cors';
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { PlanModel } from '../models/Plan';
import { ScrapeSourceModel } from '../models/ScrapeSource';
import { JobModel } from '../models/Job';

// Read-only marketing endpoints. No cookies, no auth, aggressive limits.
// Plans are cached in memory so a burst of traffic never reaches Mongo.

const CACHE_TTL_MS = 60_000;
let industriesCache: { at: number; body: unknown } | null = null;
const plansCacheByVertical = new Map<string, { at: number; body: unknown }>();
let overviewCache: { at: number; body: unknown } | null = null;

export function publicRouter() {
  const router = Router();

  router.use(cors({ origin: true, credentials: false, methods: ['GET'] }));
  router.use(rateLimit({ windowMs: 60_000, limit: 30, standardHeaders: 'draft-7', legacyHeaders: false }));

  router.get('/plans', async (req, res, next) => {
    try {
      // No ?vertical= keeps the original unfiltered behaviour, in case
      // anything outside this repo already depends on the all-plans response.
      const vertical = ['scholarships', 'jobs', 'tenders'].includes(String(req.query.vertical))
        ? String(req.query.vertical)
        : null;
      const cacheKey = vertical ?? '__all__';
      const cached = plansCacheByVertical.get(cacheKey);
      if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
        res.setHeader('X-Cache', 'HIT');
        return res.json(cached.body);
      }
      const filter: Record<string, unknown> = { isActive: true };
      if (vertical) filter.vertical = vertical;
      const plans = await PlanModel.find(filter)
        .select('name description amountKobo currency durationMinutes isTrial vertical')
        .sort({ amountKobo: 1 })
        .lean();
      const body = {
        plans: plans.map((p) => ({
          id: String(p._id),
          name: p.name,
          description: p.description ?? '',
          amount: p.amountKobo / 100,
          currency: p.currency,
          durationMinutes: p.durationMinutes,
          isTrial: p.isTrial,
          vertical: p.vertical ?? 'jobs'
        }))
      };
      plansCacheByVertical.set(cacheKey, { at: Date.now(), body });
      res.setHeader('Cache-Control', 'public, max-age=60');
      res.setHeader('X-Cache', 'MISS');
      return res.json(body);
    } catch (err) {
      return next(err);
    }
  });

  router.get('/jobs-overview', async (_req, res, next) => {
    try {
      if (overviewCache && Date.now() - overviewCache.at < CACHE_TTL_MS) {
        res.setHeader('X-Cache', 'HIT');
        return res.json(overviewCache.body);
      }
      const [jobsSourceCount, tendersSourceCount, jobsItemCount, tendersItemCount] = await Promise.all([
        ScrapeSourceModel.countDocuments({ isActive: true, $or: [{ vertical: 'jobs' }, { vertical: { $exists: false } }] }),
        ScrapeSourceModel.countDocuments({ isActive: true, vertical: 'tenders' }),
        JobModel.countDocuments({ $or: [{ vertical: 'jobs' }, { vertical: { $exists: false } }] }),
        JobModel.countDocuments({ vertical: 'tenders' })
      ]);
      const body = {
        jobs: { sourceCount: jobsSourceCount, itemCount: jobsItemCount },
        tenders: { sourceCount: tendersSourceCount, itemCount: tendersItemCount }
      };
      overviewCache = { at: Date.now(), body };
      res.setHeader('Cache-Control', 'public, max-age=60');
      res.setHeader('X-Cache', 'MISS');
      return res.json(body);
    } catch (err) {
      return next(err);
    }
  });

  router.get('/industries', async (_req, res, next) => {
    try {
      if (industriesCache && Date.now() - industriesCache.at < CACHE_TTL_MS) {
        res.setHeader('X-Cache', 'HIT');
        return res.json(industriesCache.body);
      }
      const rows = await ScrapeSourceModel.aggregate([
        { $match: { isActive: true } },
        { $group: { _id: '$industry', count: { $sum: 1 } } },
        { $sort: { count: -1 } }
      ]);
      const body = { industries: rows.map((r) => ({ industry: String(r._id), sources: r.count })) };
      industriesCache = { at: Date.now(), body };
      res.setHeader('Cache-Control', 'public, max-age=60');
      return res.json(body);
    } catch (err) {
      return next(err);
    }
  });

  return router;
}
