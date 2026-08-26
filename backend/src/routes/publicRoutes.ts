import cors from 'cors';
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { PlanModel } from '../models/Plan';
import { ScrapeSourceModel } from '../models/ScrapeSource';

// Read-only marketing endpoints. No cookies, no auth, aggressive limits.
// Plans are cached in memory so a burst of traffic never reaches Mongo.

const CACHE_TTL_MS = 60_000;
let cache: { at: number; body: unknown } | null = null;
let industriesCache: { at: number; body: unknown } | null = null;

export function publicRouter() {
  const router = Router();

  router.use(cors({ origin: true, credentials: false, methods: ['GET'] }));
  router.use(rateLimit({ windowMs: 60_000, limit: 30, standardHeaders: 'draft-7', legacyHeaders: false }));

  router.get('/plans', async (_req, res, next) => {
    try {
      if (cache && Date.now() - cache.at < CACHE_TTL_MS) {
        res.setHeader('X-Cache', 'HIT');
        return res.json(cache.body);
      }
      const plans = await PlanModel.find({ isActive: true })
        .select('name description amountKobo currency durationMinutes')
        .sort({ amountKobo: 1 })
        .lean();
      const body = {
        plans: plans.map((p) => ({
          id: String(p._id),
          name: p.name,
          description: p.description ?? '',
          amount: p.amountKobo / 100,
          currency: p.currency,
          durationMinutes: p.durationMinutes
        }))
      };
      cache = { at: Date.now(), body };
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
