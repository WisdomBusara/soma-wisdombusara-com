import { logger } from '../../../config/logger';
import { env } from '../../../config/env';
import { UniversityModel } from '../../../models/scholarship/University';
import { CrawlTargetModel } from '../../../models/scholarship/operational';
import type { TargetType } from '../../../models/scholarship/types';
import { canonicalUrl, domainOf, isSameSite } from '../normalize/text';
import { fetchPage } from '../fetcher';
import { classifyScholarshipLink } from '../scholarshipClassifier';

/**
 * Scholarship page discovery (§8).
 *
 * Two complementary strategies, because neither alone is adequate:
 *
 *   A. Path probing — universities overwhelmingly follow a handful of URL
 *      conventions. Probing ~20 known paths finds the funding hub on most
 *      sites in one round trip each, without crawling the whole domain.
 *
 *   B. Link classification — catches everything else, including the §8 case of
 *      /university/students/money/ where nothing in the URL says "scholarship"
 *      but the anchor text and surrounding context do.
 *
 * Output is CrawlTargets, not scholarships. Discovery decides *what to look
 * at*; extraction decides what it is.
 */

/** Conventional funding paths, ordered by how often they hit. */
const CANDIDATE_PATHS = [
  '/scholarships',
  '/scholarship',
  '/study/scholarships',
  '/students/scholarships',
  '/admissions/scholarships',
  '/fees-and-funding',
  '/fees-funding',
  '/funding',
  '/study/fees-and-funding',
  '/financial-aid',
  '/financial-support',
  '/study/funding',
  '/postgraduate/funding',
  '/postgraduate/scholarships',
  '/undergraduate/scholarships',
  '/international/scholarships',
  '/students/finance',
  '/study/international/scholarships',
  '/research/funding',
  '/bursaries',
  '/studentships',
  '/graduate/funding'
];

function targetTypeFor(url: string): TargetType {
  if (/\.pdf(\?|$)/i.test(url)) return 'PDF';
  if (/scholarship|studentship|bursar|fellowship/i.test(url)) return 'SCHOLARSHIP';
  if (/funding|financial|fees/i.test(url)) return 'FUNDING';
  if (/admission|apply|entry/i.test(url)) return 'ADMISSIONS';
  return 'OTHER';
}

export interface EnqueueInput {
  url: string;
  universityId?: unknown;
  targetType?: TargetType;
  priority?: number;
  depth?: number;
  discoveredFrom?: string;
}

/**
 * Insert-or-refresh a crawl target.
 *
 * Uses upsert against the unique canonicalUrl index rather than
 * find-then-insert, so two workers discovering the same URL concurrently
 * cannot create duplicates.
 */
export async function enqueueTarget(input: EnqueueInput): Promise<'created' | 'existing' | 'skipped'> {
  const canonical = canonicalUrl(input.url);
  const domain = domainOf(canonical);
  if (!domain || !canonical.startsWith('http')) return 'skipped';

  const existing = await CrawlTargetModel.findOne({ canonicalUrl: canonical }).select('_id priority').lean();
  if (existing) {
    // Raise priority if this discovery route considers it more important
    if (input.priority && input.priority > (existing.priority ?? 0)) {
      await CrawlTargetModel.updateOne({ _id: existing._id }, { $set: { priority: input.priority } });
    }
    return 'existing';
  }

  try {
    await CrawlTargetModel.create({
      url: input.url,
      canonicalUrl: canonical,
      domain,
      universityId: input.universityId,
      targetType: input.targetType ?? targetTypeFor(canonical),
      priority: input.priority ?? 50,
      depth: input.depth ?? 0,
      discoveredFrom: input.discoveredFrom,
      status: 'PENDING',
      nextCrawlAt: new Date()
    });
    return 'created';
  } catch (err: any) {
    // Duplicate key = another worker won the race; that is a success, not an error
    if (err?.code === 11000) return 'existing';
    throw err;
  }
}

export interface DiscoveryResult {
  universityId: string;
  universityName: string;
  probed: number;
  hits: string[];
  linksClassified: number;
  targetsCreated: number;
  targetsExisting: number;
  errors: string[];
}

/**
 * Find scholarship pages for one university.
 *
 * `dryRun` performs all the network work and classification but writes nothing,
 * which is what makes `--dry-run` genuinely informative rather than a no-op.
 */
export async function discoverScholarshipUrls(
  universityId: string,
  opts: { dryRun?: boolean; maxProbes?: number } = {}
): Promise<DiscoveryResult> {
  const university = await UniversityModel.findById(universityId).lean();
  if (!university) throw new Error(`University not found: ${universityId}`);

  const result: DiscoveryResult = {
    universityId: String(university._id),
    universityName: university.name,
    probed: 0,
    hits: [],
    linksClassified: 0,
    targetsCreated: 0,
    targetsExisting: 0,
    errors: []
  };

  const base = university.website ?? `https://${university.domain}`;
  const dryRun = opts.dryRun ?? false;
  const found = new Set<string>();

  const record = async (url: string, type: TargetType, priority: number, from: string) => {
    const canonical = canonicalUrl(url);
    if (found.has(canonical)) return;
    found.add(canonical);
    result.hits.push(canonical);
    if (dryRun) return;
    const outcome = await enqueueTarget({
      url, universityId: university._id, targetType: type, priority, depth: 1, discoveredFrom: from
    });
    if (outcome === 'created') result.targetsCreated += 1;
    else if (outcome === 'existing') result.targetsExisting += 1;
  };

  // ── Strategy A: probe conventional paths ──────────────────────────────────
  const maxProbes = opts.maxProbes ?? CANDIDATE_PATHS.length;
  for (const path of CANDIDATE_PATHS.slice(0, maxProbes)) {
    const url = new URL(path, base).href;
    result.probed += 1;
    try {
      const page = await fetchPage(url, { allowBrowser: false });
      if (!page.ok || !page.status || page.status >= 300) continue;
      // A 200 that redirected to the homepage is a soft-404
      if (domainOf(page.finalUrl) === domainOf(base) && new URL(page.finalUrl).pathname === '/') continue;
      if (page.text.length < 200) continue;
      await record(page.finalUrl, targetTypeFor(page.finalUrl), 70, 'path-probe');
    } catch (err: any) {
      result.errors.push(`probe ${path}: ${err?.message ?? 'failed'}`);
    }
  }

  // ── Strategy B: classify links on the homepage and on any hub found ───────
  const pagesToScan = [base, ...result.hits.slice(0, 3)];
  for (const pageUrl of pagesToScan) {
    try {
      const page = await fetchPage(pageUrl);
      if (!page.ok) continue;
      for (const link of page.links) {
        // Stay on the institution's own estate — cross-domain links are a
        // discovery signal for *universities*, not for scholarship pages.
        if (!isSameSite(link.href, university.domain)) continue;
        const verdict = classifyScholarshipLink(link);
        if (verdict.type === 'reject') continue;
        result.linksClassified += 1;
        const priority = verdict.type === 'scholarship' ? 80 : 55;
        await record(link.href, targetTypeFor(link.href), priority, `link:${pageUrl}`);
        if (found.size > 250) break; // bounded per university
      }
    } catch (err: any) {
      result.errors.push(`scan ${pageUrl}: ${err?.message ?? 'failed'}`);
    }
    if (found.size > 250) break;
  }

  if (!dryRun) {
    await UniversityModel.updateOne(
      { _id: university._id },
      {
        $set: {
          lastCrawledAt: new Date(),
          'stats.scholarshipUrlsFound': found.size,
          scholarshipUrls: [...found].slice(0, 100),
          consecutiveFailures: 0
        }
      }
    );
  }

  logger.info(
    { university: university.name, found: found.size, created: result.targetsCreated },
    'scholarship: URL discovery complete'
  );
  return result;
}

/**
 * Run discovery across universities that are due.
 *
 * Uses a cursor rather than loading the collection — at 10k+ universities a
 * `find().lean()` would be a memory incident (§62).
 */
export async function discoverForDueUniversities(
  opts: { limit?: number; dryRun?: boolean; countryCodes?: string[] } = {}
): Promise<{ processed: number; results: DiscoveryResult[] }> {
  const limit = opts.limit ?? 10;
  const query: Record<string, unknown> = { status: 'ACTIVE', crawlEnabled: true };
  if (opts.countryCodes?.length) query.countryCode = { $in: opts.countryCodes.map((c) => c.toUpperCase()) };

  const cursor = UniversityModel.find(query)
    .select('_id name')
    .sort({ lastCrawledAt: 1, createdAt: 1 })
    .limit(limit)
    .cursor();

  const results: DiscoveryResult[] = [];
  let processed = 0;

  for await (const uni of cursor) {
    try {
      results.push(await discoverScholarshipUrls(String(uni._id), { dryRun: opts.dryRun }));
    } catch (err) {
      // Isolate failure per university (§37)
      logger.error({ err, university: uni.name }, 'scholarship: URL discovery failed');
      await UniversityModel.updateOne({ _id: uni._id }, { $inc: { consecutiveFailures: 1 } });
    }
    processed += 1;
  }

  return { processed, results };
}

export const _internal = { CANDIDATE_PATHS, targetTypeFor };
