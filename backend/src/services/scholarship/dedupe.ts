import type { Types } from 'mongoose';
import { logger } from '../../config/logger';
import { ScholarshipModel } from '../../models/scholarship/Scholarship';
import { ScholarshipSourceModel } from '../../models/scholarship/operational';
import { SOURCE_AUTHORITY, type SourceType } from '../../models/scholarship/types';
import { fingerprintOf, canonicalUrl, normalizeTitle, domainOf, isSameSite } from './normalize/text';

/**
 * Deduplication (§23, §24).
 *
 * The same award appears on the university page, the faculty page, the
 * scholarship office index, a PDF, and possibly a government site. Creating
 * five records would make the whole product useless, so identity is decided by
 * a canonical fingerprint and everything else becomes an attached source.
 *
 * Fingerprint components, and why each one is there:
 *
 *   universityId     — "Excellence Scholarship" exists at fifty universities
 *   normalizedTitle  — the award's identity within that institution
 *   academicYear     — 2027/28 is a genuinely different award from 2028/29
 *   degreeLevels     — many schemes run parallel Masters and PhD variants
 *   provider         — distinguishes an externally-funded scheme hosted by the
 *                      same university from the university's own award
 *
 * Deliberately NOT included: the URL. URL is a *location*, not an identity, and
 * including it would defeat the entire purpose.
 */

export function computeFingerprint(input: {
  universityId?: unknown;
  normalizedTitle: string;
  academicYear?: string | null;
  degreeLevels?: string[];
  provider?: string | null;
}): string {
  const degrees = [...(input.degreeLevels ?? [])].sort().join(',');
  return fingerprintOf([
    input.universityId ? String(input.universityId) : 'no-university',
    input.normalizedTitle,
    // Normalize 2027/28, 2027-2028, 2027/2028 to one token
    (input.academicYear ?? '').replace(/[^0-9]/g, '').slice(0, 8) || 'no-year',
    degrees || 'no-degree',
    (input.provider ?? '').toLowerCase().trim() || 'no-provider'
  ]);
}

/**
 * Classify a URL's authority relative to the owning institution (§47).
 *
 * A faculty subdomain is institutional but not the canonical scholarship
 * office; a .gov/.gouv host is a government source; anything off-domain that
 * is neither is an aggregator until proven otherwise.
 */
export function classifySourceType(url: string, universityDomain?: string | null, contentType?: string): SourceType {
  if (contentType?.includes('pdf') || /\.pdf(\?|$)/i.test(url)) return 'PDF';

  const host = domainOf(url);
  if (/\.(gov|gov\.[a-z]{2}|gouv\.[a-z]{2}|go\.[a-z]{2}|govt\.nz)$/i.test(host)) return 'GOVERNMENT';

  if (universityDomain && isSameSite(url, universityDomain)) {
    // Sub-site of the same institution: faculty/department pages are useful but
    // the central scholarship office page is the better primary.
    if (/\/(faculty|dept|department|school|college|research-?groups?)\//i.test(url)) return 'FACULTY';
    if (host !== domainOf(`https://${universityDomain}`)) return 'FACULTY';
    return 'UNIVERSITY';
  }

  if (/\.(edu|ac\.[a-z]{2}|edu\.[a-z]{2})$/i.test(host)) return 'INSTITUTIONAL';
  if (/scholarship|studyabroad|opportunit|aggregat/i.test(host)) return 'AGGREGATOR';
  return 'OTHER';
}

export interface AttachSourceInput {
  scholarshipId: Types.ObjectId | unknown;
  universityId?: unknown;
  sourceUrl: string;
  sourceType: SourceType;
  contentType?: string;
  title?: string;
  contentHash?: string;
  httpStatus?: number;
}

/**
 * Attach a source to a scholarship, then re-elect the primary.
 *
 * Upsert on (scholarshipId, canonicalUrl) — the unique index makes concurrent
 * crawlers finding the same page idempotent rather than a race.
 */
export async function attachSource(input: AttachSourceInput): Promise<{ created: boolean }> {
  const canonical = canonicalUrl(input.sourceUrl);
  const now = new Date();

  const res = await ScholarshipSourceModel.updateOne(
    { scholarshipId: input.scholarshipId, canonicalUrl: canonical },
    {
      $set: {
        sourceUrl: input.sourceUrl,
        sourceType: input.sourceType,
        contentType: input.contentType ?? 'text/html',
        title: input.title,
        contentHash: input.contentHash,
        lastSeen: now,
        lastHttpStatus: input.httpStatus,
        verificationStatus: 'REACHABLE'
      },
      $setOnInsert: {
        scholarshipId: input.scholarshipId,
        universityId: input.universityId,
        canonicalUrl: canonical,
        firstSeen: now
      }
    },
    { upsert: true }
  );

  await electPrimarySource(input.scholarshipId);
  return { created: res.upsertedCount > 0 };
}

/**
 * Pick the most authoritative source and mark it primary.
 *
 * Ties break on earliest firstSeen — the source we found first is the one the
 * discovery path considered canonical.
 */
export async function electPrimarySource(scholarshipId: unknown): Promise<void> {
  const sources = await ScholarshipSourceModel.find({ scholarshipId })
    .select('_id sourceType firstSeen isPrimary')
    .lean();
  if (sources.length === 0) return;

  const ranked = [...sources].sort((a, b) => {
    const ra = SOURCE_AUTHORITY[a.sourceType as SourceType] ?? 9;
    const rb = SOURCE_AUTHORITY[b.sourceType as SourceType] ?? 9;
    if (ra !== rb) return ra - rb;
    return new Date(a.firstSeen).getTime() - new Date(b.firstSeen).getTime();
  });

  const winner = ranked[0];
  const bulk = ScholarshipSourceModel.collection.initializeUnorderedBulkOp();
  let dirty = false;
  for (const s of sources) {
    const shouldBePrimary = String(s._id) === String(winner._id);
    if (Boolean(s.isPrimary) !== shouldBePrimary) {
      bulk.find({ _id: s._id }).updateOne({ $set: { isPrimary: shouldBePrimary } });
      dirty = true;
    }
  }
  if (dirty) await bulk.execute();

  const official = ranked.some((s) => ['UNIVERSITY', 'GOVERNMENT', 'PROVIDER', 'FACULTY'].includes(s.sourceType as string));
  await ScholarshipModel.updateOne(
    { _id: scholarshipId },
    { $set: { sourceCount: sources.length, hasOfficialSource: official } }
  );
}

// ── Near-duplicate detection ────────────────────────────────────────────────

/**
 * Token-level Jaccard similarity of two normalized titles.
 *
 * Used only as a *secondary* check when the fingerprint misses — e.g. one page
 * writes "Global Excellence Scholarship" and another "Global Excellence
 * Scholarships for International Students". A hard fingerprint match is always
 * preferred; this exists to catch the long tail.
 */
export function titleSimilarity(a: string, b: string): number {
  const ta = new Set(normalizeTitle(a).split(' ').filter(Boolean));
  const tb = new Set(normalizeTitle(b).split(' ').filter(Boolean));
  if (ta.size === 0 || tb.size === 0) return 0;
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared += 1;
  return shared / (ta.size + tb.size - shared);
}

export const NEAR_DUPLICATE_THRESHOLD = 0.82;

export interface DuplicateMatch {
  scholarshipId: string;
  fingerprint: string;
  matchType: 'FINGERPRINT' | 'CONTENT_HASH' | 'CANONICAL_URL' | 'NEAR_TITLE';
  similarity: number;
}

/**
 * Find an existing scholarship that this draft is another copy of.
 *
 * Order matters — cheapest and most certain first:
 *   1. exact fingerprint (indexed, unique)
 *   2. an existing source with the same canonical URL
 *   3. an existing source with the same content hash (mirrored PDF etc.)
 *   4. near-title within the same university + academic year
 */
export async function findDuplicate(input: {
  fingerprint: string;
  canonicalUrl: string;
  contentHash?: string;
  universityId?: unknown;
  normalizedTitle: string;
  academicYear?: string | null;
}): Promise<DuplicateMatch | null> {
  const byFingerprint = await ScholarshipModel.findOne({ fingerprint: input.fingerprint })
    .select('_id fingerprint')
    .lean();
  if (byFingerprint) {
    return { scholarshipId: String(byFingerprint._id), fingerprint: byFingerprint.fingerprint, matchType: 'FINGERPRINT', similarity: 1 };
  }

  const byUrl = await ScholarshipSourceModel.findOne({ canonicalUrl: input.canonicalUrl })
    .select('scholarshipId')
    .lean();
  if (byUrl?.scholarshipId) {
    const s = await ScholarshipModel.findById(byUrl.scholarshipId).select('_id fingerprint').lean();
    if (s) return { scholarshipId: String(s._id), fingerprint: s.fingerprint, matchType: 'CANONICAL_URL', similarity: 1 };
  }

  if (input.contentHash) {
    const byHash = await ScholarshipSourceModel.findOne({ contentHash: input.contentHash })
      .select('scholarshipId')
      .lean();
    if (byHash?.scholarshipId) {
      const s = await ScholarshipModel.findById(byHash.scholarshipId).select('_id fingerprint').lean();
      if (s) return { scholarshipId: String(s._id), fingerprint: s.fingerprint, matchType: 'CONTENT_HASH', similarity: 1 };
    }
  }

  // Near-title, scoped to the same institution + year so this stays a bounded,
  // index-backed query rather than a collection scan.
  if (input.universityId) {
    const query: Record<string, unknown> = { universityId: input.universityId, status: { $ne: 'REPLACED' } };
    if (input.academicYear) query.academicYear = input.academicYear;
    const siblings = await ScholarshipModel.find(query)
      .select('_id fingerprint normalizedTitle')
      .limit(200)
      .lean();
    let best: DuplicateMatch | null = null;
    for (const s of siblings) {
      const sim = titleSimilarity(input.normalizedTitle, s.normalizedTitle);
      if (sim >= NEAR_DUPLICATE_THRESHOLD && (!best || sim > best.similarity)) {
        best = { scholarshipId: String(s._id), fingerprint: s.fingerprint, matchType: 'NEAR_TITLE', similarity: Number(sim.toFixed(3)) };
      }
    }
    if (best) return best;
  }

  return null;
}

/**
 * Merge one scholarship into another: move sources, mark the loser REPLACED.
 *
 * Records are never deleted (§25) — a REPLACED record keeps its history and
 * points at its successor, so an old bookmark or alert still resolves.
 */
export async function mergeScholarships(loserId: unknown, winnerId: unknown): Promise<void> {
  if (String(loserId) === String(winnerId)) return;
  const sources = await ScholarshipSourceModel.find({ scholarshipId: loserId }).lean();
  for (const s of sources) {
    await ScholarshipSourceModel.updateOne(
      { scholarshipId: winnerId, canonicalUrl: s.canonicalUrl },
      {
        $set: { sourceUrl: s.sourceUrl, sourceType: s.sourceType, contentHash: s.contentHash, lastSeen: s.lastSeen },
        $setOnInsert: { scholarshipId: winnerId, canonicalUrl: s.canonicalUrl, firstSeen: s.firstSeen }
      },
      { upsert: true }
    ).catch(() => undefined);
  }
  await ScholarshipSourceModel.deleteMany({ scholarshipId: loserId });
  await ScholarshipModel.updateOne(
    { _id: loserId },
    { $set: { status: 'REPLACED', replacedBy: winnerId, lastChangedAt: new Date() } }
  );
  await electPrimarySource(winnerId);
  logger.info({ loserId: String(loserId), winnerId: String(winnerId) }, 'scholarship: merged duplicate');
}
