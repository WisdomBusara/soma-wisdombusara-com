import cors from 'cors';
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { isValidObjectId } from 'mongoose';
import { z } from 'zod';

import { ScholarshipModel } from '../models/scholarship/Scholarship';
import { UniversityModel } from '../models/scholarship/University';
import { ScholarshipSourceModel } from '../models/scholarship/operational';
import { DEGREE_LEVELS, STUDY_MODES, ATTENDANCE_MODES, FUNDING_TYPES, SCHOLARSHIP_STATUSES } from '../models/scholarship/types';
import { env } from '../config/env';
import { toCountryCode } from '../services/scholarship/normalize/country';
import { matchScholarship, type ApplicantProfile } from '../services/scholarship/matcher';
import {
  resolveAccess, consumeFreeView, requirePremium, accessSummary
} from '../services/scholarship/paywall';
import { scholarshipAccessRouter } from './scholarshipAccessRoutes';
import { scholarshipDeliveryRouter } from './scholarshipDeliveryRoutes';

/**
 * Public scholarship API (§29, §30).
 *
 * Mirrors the conventions of the existing publicRouter: permissive GET-only
 * CORS, no cookies, its own rate limit. Mounted separately from /public so the
 * two can be limited independently — scholarship search is heavier than the
 * cached plans endpoint.
 *
 * Everything is paginated and capped. There is no code path that returns an
 * unbounded result set.
 */

const MAX_LIMIT = 50;
const DEFAULT_LIMIT = 20;

const listQuerySchema = z.object({
  degree: z.string().optional(),
  country: z.string().optional(),
  university: z.string().optional(),
  field: z.string().optional(),
  funding: z.string().optional(),
  fullyFunded: z.string().optional(),
  studyMode: z.string().optional(),
  attendance: z.string().optional(),
  nationality: z.string().optional(),
  status: z.string().optional(),
  deadlineBefore: z.string().optional(),
  deadlineAfter: z.string().optional(),
  q: z.string().max(200).optional(),
  minConfidence: z.coerce.number().min(0).max(1).optional(),
  sort: z.enum(['deadline', 'newest', 'confidence', 'quality']).optional(),
  page: z.coerce.number().int().min(1).max(500).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_LIMIT).optional()
});

const csv = (v?: string): string[] =>
  (v ?? '').split(',').map((s) => s.trim()).filter(Boolean);

const truthy = (v?: string): boolean => ['true', '1', 'yes'].includes(String(v ?? '').toLowerCase());

/** Trim the stored document down to what a list view needs. */
function toListItem(s: any) {
  return {
    id: String(s._id),
    title: s.title,
    university: s.universityName ?? null,
    universityId: s.universityId ? String(s.universityId) : null,
    provider: s.provider ?? null,
    country: s.country,
    countryCode: s.countryCode ?? null,
    city: s.city ?? null,
    degreeLevels: s.degreeLevels ?? [],
    fieldsOfStudy: s.fieldsOfStudy ?? [],
    studyMode: s.studyMode ?? ['UNKNOWN'],
    attendance: s.attendance ?? ['UNKNOWN'],
    funding: {
      primaryType: s.funding?.primaryType ?? 'UNKNOWN',
      certainty: s.funding?.primaryTypeCertainty ?? 'UNKNOWN',
      types: s.funding?.types ?? [],
      tuitionCovered: s.funding?.tuitionCovered?.value ?? null,
      livingStipend: s.funding?.livingStipend?.value ?? null,
      stipendAmount: s.funding?.stipendAmount?.amount ?? null,
      stipendCurrency: s.funding?.stipendAmount?.currency ?? null
    },
    eligibility: {
      scope: s.eligibility?.scope ?? 'UNKNOWN',
      countries: s.eligibility?.countries ?? [],
      regions: s.eligibility?.regions ?? []
    },
    deadline: {
      kind: s.deadline?.kind ?? 'UNKNOWN',
      date: s.deadline?.date ?? null,
      originalText: s.deadline?.originalText ?? null
    },
    status: s.status,
    confidence: s.confidence ?? 0,
    qualityScore: s.qualityScore ?? 0,
    hasOfficialSource: Boolean(s.hasOfficialSource),
    needsVerification: s.reviewStatus === 'NEEDS_REVIEW',
    extractionMethod: s.extractionMethod ?? 'RULES',
    lastVerifiedAt: s.lastVerifiedAt ?? null,
    lastCrawledAt: s.lastCrawledAt ?? null
  };
}

/**
 * Build the Mongo filter.
 *
 * The nationality filter is the subtle one (§30, §58): a request for KE must
 * return awards that explicitly list Kenya, awards open to a region Kenya
 * belongs to, and awards open to international applicants generally — but the
 * response marks which is which so the UI never presents "international" as a
 * confirmed match.
 */
function buildFilter(q: z.infer<typeof listQuerySchema>): Record<string, unknown> {
  const filter: Record<string, unknown> = {
    // Replaced records are history, never search results
    status: { $ne: 'REPLACED' },
    reviewStatus: { $ne: 'REJECTED' }
  };

  const degrees = csv(q.degree).map((d) => d.toUpperCase()).filter((d) => (DEGREE_LEVELS as readonly string[]).includes(d));
  if (degrees.length) filter.degreeLevels = { $in: degrees };

  const countries = csv(q.country).map((c) => toCountryCode(c) ?? c.toUpperCase());
  if (countries.length) filter.countryCode = { $in: countries };

  if (q.university && isValidObjectId(q.university)) filter.universityId = q.university;

  const fields = csv(q.field).map((f) => f.toLowerCase());
  if (fields.length) filter.fieldsOfStudy = { $in: fields };

  if (truthy(q.fullyFunded)) {
    filter['funding.primaryType'] = 'FULLY_FUNDED';
  } else {
    const funding = csv(q.funding).map((f) => f.toUpperCase()).filter((f) => (FUNDING_TYPES as readonly string[]).includes(f));
    if (funding.length) filter['funding.types'] = { $in: funding };
  }

  const modes = csv(q.studyMode).map((m) => m.toUpperCase()).filter((m) => (STUDY_MODES as readonly string[]).includes(m));
  if (modes.length) filter.studyMode = { $in: modes };

  const attend = csv(q.attendance).map((a) => a.toUpperCase()).filter((a) => (ATTENDANCE_MODES as readonly string[]).includes(a));
  // BOTH satisfies a FULL_TIME request — an award open to either is open to you
  if (attend.length) filter.attendance = { $in: [...attend, 'BOTH'] };

  const nationality = q.nationality ? toCountryCode(q.nationality) : null;
  if (nationality) {
    filter.$and = [
      {
        $or: [
          { 'eligibility.countries': nationality },
          { 'eligibility.scope': { $in: ['INTERNATIONAL', 'BOTH'] } },
          { 'eligibility.scope': 'SPECIFIC_REGIONS' }
        ]
      },
      { 'eligibility.excludedCountries': { $ne: nationality } }
    ];
  }

  const statuses = csv(q.status).map((s) => s.toUpperCase()).filter((s) => (SCHOLARSHIP_STATUSES as readonly string[]).includes(s));
  if (statuses.length) filter.status = { $in: statuses };

  const dl: Record<string, Date> = {};
  if (q.deadlineAfter) {
    const d = new Date(q.deadlineAfter);
    if (!Number.isNaN(d.getTime())) dl.$gte = d;
  }
  if (q.deadlineBefore) {
    const d = new Date(q.deadlineBefore);
    if (!Number.isNaN(d.getTime())) dl.$lte = d;
  }
  if (Object.keys(dl).length) filter['deadline.date'] = dl;

  if (q.minConfidence !== undefined) filter.confidence = { $gte: q.minConfidence };
  if (q.q) filter.$text = { $search: q.q };

  return filter;
}

function buildSort(sort?: string): Record<string, 1 | -1> {
  switch (sort) {
    case 'newest': return { discoveredAt: -1 };
    case 'confidence': return { confidence: -1 };
    case 'quality': return { qualityScore: -1 };
    case 'deadline':
    default:
      // Awards with a real deadline first, soonest first
      return { 'deadline.date': 1, qualityScore: -1 };
  }
}

export function scholarshipPublicRouter() {
  const router = Router();

  // Anti-abuse: even with the cookie meter, cap detail views per IP per day so
  // clearing cookies / incognito cannot mint unlimited free reads.
  const detailIpLimiter = rateLimit({
    windowMs: 24 * 60 * 60 * 1000,
    limit: 40,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { error: 'ip_rate_limited', message: 'Too many scholarship views from this network today. Please subscribe for unlimited access.', upgradeUrl: '/upgrade' }
  });

  // credentials:true because the paywall cookie must travel with requests when
  // the site is served from a different origin than the API.
  router.use(cors({ origin: true, credentials: true, methods: ['GET', 'POST'] }));
  router.use(rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: 'draft-7', legacyHeaders: false }));
  // Every route below can read req.access. Never rejects — degrades to free.
  router.use(resolveAccess);

  // Checkout, restore and ad delivery share this router's CORS and cookies.
  router.use(scholarshipAccessRouter());
  router.use(scholarshipDeliveryRouter());

  // ── GET /api/scholarships ─────────────────────────────────────────────────
  router.get('/scholarships', async (req, res, next) => {
    try {
      const q = listQuerySchema.parse(req.query);
      const page = q.page ?? 1;
      const limit = Math.min(q.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
      const filter = buildFilter(q);

      const [rows, total] = await Promise.all([
        ScholarshipModel.find(filter)
          .sort(buildSort(q.sort))
          .skip((page - 1) * limit)
          .limit(limit)
          .lean(),
        // Cap the count so a broad query cannot force a full scan
        ScholarshipModel.countDocuments(filter).limit(5000)
      ]);

      const nationality = q.nationality ? toCountryCode(q.nationality) : null;
      const items = rows.map((s) => {
        const item = toListItem(s) as any;
        if (nationality) {
          // Tell the client HOW this matched, so "international" is never shown
          // as a confirmed nationality match (§58)
          const explicit = (s.eligibility?.countries ?? []).includes(nationality);
          item.nationalityMatch = explicit
            ? 'EXPLICIT'
            : s.eligibility?.scope === 'BOTH' ? 'OPEN_TO_ALL'
            : s.eligibility?.scope === 'INTERNATIONAL' ? 'INTERNATIONAL_UNCONFIRMED'
            : 'REGION_OR_UNCONFIRMED';
        }
        return item;
      });

      // Listings are never gated — an index search engines cannot crawl has no
      // audience, and a reader who cannot see what exists will not pay to see
      // more. Private because the response now carries the reader's quota.
      res.setHeader('Cache-Control', 'private, max-age=60');
      return res.json({
        items,
        access: accessSummary(req),
        pagination: {
          page,
          limit,
          total,
          totalPages: Math.ceil(total / limit),
          hasMore: page * limit < total
        }
      });
    } catch (err) {
      return next(err);
    }
  });

  // ── GET /api/scholarships/facets ──────────────────────────────────────────
  // Powers the filter sidebar without the client guessing what exists.
  router.get('/scholarships/facets', async (_req, res, next) => {
    try {
      const [countries, degrees, funding, fields] = await Promise.all([
        ScholarshipModel.aggregate([
          { $match: { status: { $nin: ['REPLACED', 'EXPIRED'] }, countryCode: { $ne: null } } },
          { $group: { _id: { code: '$countryCode', name: '$country' }, count: { $sum: 1 } } },
          { $sort: { count: -1 } },
          { $limit: 60 }
        ]),
        ScholarshipModel.aggregate([
          { $match: { status: { $nin: ['REPLACED', 'EXPIRED'] } } },
          { $unwind: '$degreeLevels' },
          { $group: { _id: '$degreeLevels', count: { $sum: 1 } } },
          { $sort: { count: -1 } }
        ]),
        ScholarshipModel.aggregate([
          { $match: { status: { $nin: ['REPLACED', 'EXPIRED'] } } },
          { $group: { _id: '$funding.primaryType', count: { $sum: 1 } } },
          { $sort: { count: -1 } }
        ]),
        ScholarshipModel.aggregate([
          { $match: { status: { $nin: ['REPLACED', 'EXPIRED'] } } },
          { $unwind: '$fieldsOfStudy' },
          { $group: { _id: '$fieldsOfStudy', count: { $sum: 1 } } },
          { $sort: { count: -1 } },
          { $limit: 40 }
        ])
      ]);

      res.setHeader('Cache-Control', 'public, max-age=300');
      return res.json({
        countries: countries.map((c) => ({ code: c._id.code, name: c._id.name, count: c.count })),
        degreeLevels: degrees.map((d) => ({ value: d._id, count: d.count })),
        fundingTypes: funding.map((f) => ({ value: f._id, count: f.count })),
        fields: fields.map((f) => ({ value: f._id, count: f.count }))
      });
    } catch (err) {
      return next(err);
    }
  });

  // ── GET /api/scholarships/:id ─────────────────────────────────────────────
  router.get('/scholarships/:id', detailIpLimiter, async (req, res, next) => {
    try {
      const id = String(req.params.id);
      if (!isValidObjectId(id)) return res.status(400).json({ error: 'Invalid id' });

      const s = await ScholarshipModel.findById(id).lean();
      if (!s || s.status === 'REPLACED') {
        // A replaced record redirects rather than 404s — old links keep working
        if (s?.replacedBy) return res.json({ replacedBy: String(s.replacedBy) });
        return res.status(404).json({ error: 'Not found' });
      }

      // §Paywall: distinct detail views count against the free allowance.
      // Re-opening the same scholarship is always free.
      if (!consumeFreeView(req, res, id)) {
        return res.status(402).json({
          error: 'free_limit_reached',
          message: 'You have used your free scholarship views this month.',
          access: accessSummary(req),
          // Enough to keep the page useful and honest while locked
          preview: {
            id: String(s._id),
            title: s.title,
            university: s.universityName ?? null,
            country: s.country,
            degreeLevels: s.degreeLevels ?? [],
            funding: s.funding?.primaryType ?? 'UNKNOWN',
            deadline: s.deadline?.date ?? null,
            deadlineKind: s.deadline?.kind ?? 'UNKNOWN',
            status: s.status
          },
          // The teaser tells them what they get by subscribing.
          delivery: 'Unlock full details, and get new scholarships delivered by email, Telegram or WhatsApp.',
          upgradeUrl: '/upgrade'
        });
      }

      const [sources, university] = await Promise.all([
        ScholarshipSourceModel.find({ scholarshipId: s._id }).sort({ isPrimary: -1 }).lean(),
        s.universityId ? UniversityModel.findById(s.universityId).lean() : null
      ]);

      res.setHeader('Cache-Control', 'private, max-age=60');
      return res.json({
        ...toListItem(s),
        access: accessSummary(req),
        description: s.description ?? null,
        intake: s.intake ?? null,
        academicYear: s.academicYear ?? null,
        duration: s.duration ?? null,
        deliveryMode: s.deliveryMode ?? ['UNKNOWN'],
        // Full provenance-bearing objects — the detail page shows evidence
        fundingDetail: s.funding,
        eligibilityDetail: s.eligibility,
        requirements: s.requirements,
        deadlineDetail: s.deadline,
        applicationUrl: s.applicationUrl?.value ?? null,
        sourceUrl: s.sourceUrl,
        classificationReasons: s.classificationReasons ?? [],
        sources: sources.map((src) => ({
          url: src.sourceUrl,
          type: src.sourceType,
          isPrimary: Boolean(src.isPrimary),
          firstSeen: src.firstSeen,
          lastSeen: src.lastSeen,
          verificationStatus: src.verificationStatus
        })),
        universityRef: university
          ? {
              id: String(university._id),
              name: university.name,
              website: university.website,
              country: university.country,
              city: university.city ?? null
            }
          : null
      });
    } catch (err) {
      return next(err);
    }
  });

  // ── POST /api/scholarships/match ──────────────────────────────────────────
  // Deterministic matching with per-criterion explanations (§31).
  const profileSchema = z.object({
    nationality: z.string().max(60).optional(),
    degreeLevel: z.enum(DEGREE_LEVELS).optional(),
    fieldOfStudy: z.string().max(80).optional(),
    gpa: z.number().min(0).max(10).optional(),
    gpaScale: z.number().min(1).max(10).optional(),
    englishTest: z.object({
      type: z.enum(['IELTS', 'TOEFL', 'PTE', 'DUOLINGO']),
      score: z.number().min(0).max(200)
    }).optional(),
    workExperienceYears: z.number().min(0).max(60).optional(),
    preferredCountries: z.array(z.string().max(60)).max(20).optional(),
    studyMode: z.enum(STUDY_MODES).optional(),
    attendance: z.enum(ATTENDANCE_MODES).optional(),
    fullyFundedOnly: z.boolean().optional(),
    limit: z.number().int().min(1).max(MAX_LIMIT).optional()
  });

  router.post('/scholarships/match', requirePremium, async (req, res, next) => {
    try {
      const profile = profileSchema.parse(req.body ?? {}) as ApplicantProfile & { limit?: number };
      const limit = Math.min((profile as any).limit ?? DEFAULT_LIMIT, MAX_LIMIT);

      // Pre-filter in Mongo on the cheap hard criteria, then score in memory.
      // Scoring every scholarship in the collection would not scale; scoring a
      // pre-filtered few hundred is fine.
      const filter: Record<string, unknown> = {
        status: { $in: ['OPEN', 'CLOSING_SOON', 'UPCOMING', 'VERIFIED'] },
        reviewStatus: { $ne: 'REJECTED' }
      };
      if (profile.degreeLevel) filter.degreeLevels = profile.degreeLevel;
      if (profile.fullyFundedOnly) filter['funding.primaryType'] = 'FULLY_FUNDED';
      if (profile.preferredCountries?.length) {
        filter.countryCode = { $in: profile.preferredCountries.map((c) => toCountryCode(c) ?? c.toUpperCase()) };
      }
      const nationality = profile.nationality ? toCountryCode(profile.nationality) : null;
      if (nationality) filter['eligibility.excludedCountries'] = { $ne: nationality };

      const candidates = await ScholarshipModel.find(filter)
        .sort({ qualityScore: -1 })
        .limit(400)
        .lean();

      const ranked = candidates
        .map((s) => ({ s, match: matchScholarship(s, profile) }))
        .filter((r) => r.match.eligible)
        .sort((a, b) => b.match.score - a.match.score)
        .slice(0, limit);

      return res.json({
        items: ranked.map(({ s, match }) => ({
          ...toListItem(s),
          match: {
            percentage: match.percentage,
            eligible: match.eligible,
            uncertain: match.uncertain,
            passed: match.passed.map((c) => ({ label: c.label, detail: c.detail })),
            warnings: match.warnings.map((c) => ({ label: c.label, detail: c.detail })),
            failures: match.failures.map((c) => ({ label: c.label, detail: c.detail }))
          }
        })),
        evaluated: candidates.length
      });
    } catch (err) {
      return next(err);
    }
  });

  // ── GET /api/universities ─────────────────────────────────────────────────
  router.get('/universities', async (req, res, next) => {
    try {
      const q = z.object({
        country: z.string().optional(),
        q: z.string().max(120).optional(),
        page: z.coerce.number().int().min(1).max(500).optional(),
        limit: z.coerce.number().int().min(1).max(MAX_LIMIT).optional()
      }).parse(req.query);

      const page = q.page ?? 1;
      const limit = Math.min(q.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
      const filter: Record<string, unknown> = { status: 'ACTIVE' };
      const countries = csv(q.country).map((c) => toCountryCode(c) ?? c.toUpperCase());
      if (countries.length) filter.countryCode = { $in: countries };
      if (q.q) filter.$text = { $search: q.q };

      const [rows, total] = await Promise.all([
        UniversityModel.find(filter)
          .select('name country countryCode city website domain type stats')
          .sort({ 'stats.scholarshipsFound': -1, name: 1 })
          .skip((page - 1) * limit)
          .limit(limit)
          .lean(),
        UniversityModel.countDocuments(filter).limit(5000)
      ]);

      res.setHeader('Cache-Control', 'public, max-age=300');
      return res.json({
        items: rows.map((u) => ({
          id: String(u._id),
          name: u.name,
          country: u.country,
          countryCode: u.countryCode ?? null,
          city: u.city ?? null,
          website: u.website,
          domain: u.domain,
          type: u.type,
          scholarshipCount: u.stats?.scholarshipsFound ?? 0
        })),
        pagination: { page, limit, total, totalPages: Math.ceil(total / limit), hasMore: page * limit < total }
      });
    } catch (err) {
      return next(err);
    }
  });

  // ── GET /api/universities/:id ─────────────────────────────────────────────
  router.get('/universities/:id', async (req, res, next) => {
    try {
      const id = String(req.params.id);
      if (!isValidObjectId(id)) return res.status(400).json({ error: 'Invalid id' });

      const u = await UniversityModel.findById(id).lean();
      if (!u) return res.status(404).json({ error: 'Not found' });

      const scholarships = await ScholarshipModel.find({
        universityId: u._id,
        status: { $nin: ['REPLACED', 'EXPIRED'] }
      })
        .sort({ 'deadline.date': 1 })
        .limit(50)
        .lean();

      res.setHeader('Cache-Control', 'public, max-age=300');
      return res.json({
        id: String(u._id),
        name: u.name,
        officialName: u.officialName ?? null,
        country: u.country,
        countryCode: u.countryCode ?? null,
        city: u.city ?? null,
        website: u.website,
        domain: u.domain,
        type: u.type,
        admissionsUrl: u.admissionsUrl ?? null,
        internationalStudentsUrl: u.internationalStudentsUrl ?? null,
        lastVerifiedAt: u.lastVerifiedAt ?? null,
        scholarships: scholarships.map(toListItem)
      });
    } catch (err) {
      return next(err);
    }
  });

  // ── Sitemap ───────────────────────────────────────────────────────────────
  // Organic search is the top of the funnel for a freemium product, so the
  // index has to be discoverable. Capped at 40k URLs — beyond that this needs
  // splitting into a sitemap index.
  router.get('/sitemap.xml', async (_req, res, next) => {
    try {
      const base = (env.SCHOLARSHIP_SITE_URL ?? '').replace(/\/$/, '');
      if (!base) return res.status(404).send('SCHOLARSHIP_SITE_URL is not configured');

      const [scholarships, universities] = await Promise.all([
        ScholarshipModel.find({ status: { $nin: ['REPLACED', 'EXPIRED'] } })
          .select('_id updatedAt').sort({ updatedAt: -1 }).limit(30_000).lean(),
        UniversityModel.find({ status: 'ACTIVE' })
          .select('_id updatedAt').limit(10_000).lean()
      ]);

      const esc = (u: string) => u.replace(/&/g, '&amp;');
      const urls = [
        `<url><loc>${esc(base)}/</loc><changefreq>daily</changefreq><priority>1.0</priority></url>`,
        `<url><loc>${esc(base)}/scholarships</loc><changefreq>daily</changefreq><priority>0.9</priority></url>`,
        `<url><loc>${esc(base)}/universities</loc><changefreq>weekly</changefreq><priority>0.7</priority></url>`,
        `<url><loc>${esc(base)}/about</loc><changefreq>monthly</changefreq><priority>0.4</priority></url>`,
        ...scholarships.map((s) =>
          `<url><loc>${esc(base)}/scholarships/${String(s._id)}</loc><lastmod>${new Date(s.updatedAt ?? Date.now()).toISOString().slice(0, 10)}</lastmod><changefreq>weekly</changefreq><priority>0.8</priority></url>`),
        ...universities.map((u) =>
          `<url><loc>${esc(base)}/universities/${String(u._id)}</loc><changefreq>monthly</changefreq><priority>0.5</priority></url>`)
      ];

      res.setHeader('Content-Type', 'application/xml; charset=utf-8');
      res.setHeader('Cache-Control', 'public, max-age=3600');
      return res.send(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join('\n')}\n</urlset>`);
    } catch (err) { return next(err); }
  });

  return router;
}
