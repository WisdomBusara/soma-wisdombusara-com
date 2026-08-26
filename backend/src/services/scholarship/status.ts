import { env } from '../../config/env';
import { logger } from '../../config/logger';
import { ScholarshipModel } from '../../models/scholarship/Scholarship';
import { ScholarshipChangeModel } from '../../models/scholarship/operational';
import type { ScholarshipStatus, ReviewStatus } from '../../models/scholarship/types';

/**
 * Status engine (§25) and change detection (§26).
 *
 * Status is *derived*, never hand-set by the crawler, so the same input always
 * produces the same status and a scheduled sweep can recompute the whole
 * collection without surprises.
 *
 * Nothing is ever deleted. An award whose deadline passed becomes CLOSED, then
 * EXPIRED once it is stale — both remain queryable, which is what makes
 * "when did this normally open?" answerable next cycle.
 */

export interface StatusInput {
  deadlineKind: string;
  deadlineDate: Date | null;
  confidence: number;
  reviewStatus?: ReviewStatus;
  currentStatus?: ScholarshipStatus;
  discoveredAt?: Date;
}

const DAY_MS = 86_400_000;
/** Past this long after a deadline, CLOSED becomes EXPIRED. */
const EXPIRY_GRACE_DAYS = 120;

export function computeStatus(input: StatusInput, now: Date = new Date()): ScholarshipStatus {
  // A human rejection is terminal and outranks any date arithmetic.
  if (input.reviewStatus === 'REJECTED') return 'CLOSED';
  if (input.currentStatus === 'REPLACED') return 'REPLACED';

  // Below the confidence floor we will not claim a page is open for
  // applications — that is a claim a person might act on.
  if (input.confidence < env.SCHOLARSHIP_MIN_CONFIDENCE) {
    return input.reviewStatus === 'APPROVED' ? 'VERIFIED' : 'UNDER_REVIEW';
  }

  const verifiedByHuman = input.reviewStatus === 'APPROVED';

  if (input.deadlineKind === 'ROLLING') {
    // Rolling awards have no close date; they are open until the page says
    // otherwise, which change detection will catch.
    return 'OPEN';
  }

  if (!input.deadlineDate) {
    // No date at all — we know it exists, we cannot claim it is open.
    return verifiedByHuman ? 'VERIFIED' : 'DISCOVERED';
  }

  const deadline = input.deadlineDate.getTime();
  const t = now.getTime();

  if (deadline < t) {
    const daysPast = (t - deadline) / DAY_MS;
    return daysPast > EXPIRY_GRACE_DAYS ? 'EXPIRED' : 'CLOSED';
  }

  const daysLeft = (deadline - t) / DAY_MS;
  if (daysLeft <= env.SCHOLARSHIP_CLOSING_SOON_DAYS) return 'CLOSING_SOON';

  // Far-future deadlines for a cycle that has not opened yet
  if (daysLeft > 365) return 'UPCOMING';

  return 'OPEN';
}

/**
 * Recompute status across the collection.
 *
 * Batched via cursor so this stays flat in memory at any collection size (§62),
 * and it emits STATUS_CHANGED events so "deadline approaching" alerts have
 * something to hang off later (§63).
 */
export async function refreshStatuses(opts: { limit?: number; dryRun?: boolean } = {}): Promise<{
  scanned: number;
  changed: number;
  transitions: Record<string, number>;
}> {
  const now = new Date();
  const transitions: Record<string, number> = {};
  let scanned = 0;
  let changed = 0;

  const cursor = ScholarshipModel.find({ status: { $nin: ['EXPIRED', 'REPLACED'] } })
    .select('_id status reviewStatus confidence deadline discoveredAt')
    .limit(opts.limit ?? 100_000)
    .cursor();

  for await (const doc of cursor) {
    scanned += 1;
    const next = computeStatus(
      {
        deadlineKind: doc.deadline?.kind ?? 'UNKNOWN',
        deadlineDate: doc.deadline?.date ?? null,
        confidence: doc.confidence ?? 0,
        reviewStatus: doc.reviewStatus as ReviewStatus,
        currentStatus: doc.status as ScholarshipStatus,
        discoveredAt: doc.discoveredAt
      },
      now
    );
    if (next === doc.status) continue;

    changed += 1;
    const key = `${doc.status}→${next}`;
    transitions[key] = (transitions[key] ?? 0) + 1;

    if (opts.dryRun) continue;

    await ScholarshipModel.updateOne({ _id: doc._id }, { $set: { status: next, lastChangedAt: now } });
    await ScholarshipChangeModel.create({
      scholarshipId: doc._id,
      field: 'status',
      oldValue: doc.status,
      newValue: next,
      changeType: 'STATUS_CHANGED',
      // A reopening or an imminent close is worth telling someone about
      significance: ['CLOSING_SOON', 'OPEN', 'CLOSED'].includes(next) ? 'MAJOR' : 'MINOR',
      detectedAt: now
    }).catch((err) => logger.warn({ err }, 'scholarship: failed to record status change'));
  }

  return { scanned, changed, transitions };
}

// ── Change detection (§26) ──────────────────────────────────────────────────

/** Fields worth diffing, with the significance a change to each carries. */
const TRACKED: { path: string; label: string; significance: 'MAJOR' | 'MINOR' }[] = [
  { path: 'title', label: 'title', significance: 'MINOR' },
  { path: 'deadline.date', label: 'deadline', significance: 'MAJOR' },
  { path: 'deadline.kind', label: 'deadline.kind', significance: 'MAJOR' },
  { path: 'funding.primaryType', label: 'funding', significance: 'MAJOR' },
  { path: 'funding.tuitionCovered.value', label: 'funding.tuitionCovered', significance: 'MAJOR' },
  { path: 'funding.livingStipend.value', label: 'funding.livingStipend', significance: 'MAJOR' },
  { path: 'funding.stipendAmount.amount', label: 'funding.stipendAmount', significance: 'MAJOR' },
  { path: 'eligibility.scope', label: 'eligibility', significance: 'MAJOR' },
  { path: 'eligibility.countries', label: 'eligibility.countries', significance: 'MAJOR' },
  { path: 'degreeLevels', label: 'degreeLevels', significance: 'MAJOR' },
  { path: 'studyMode', label: 'studyMode', significance: 'MINOR' },
  { path: 'attendance', label: 'attendance', significance: 'MINOR' },
  { path: 'applicationUrl.value', label: 'applicationUrl', significance: 'MAJOR' },
  { path: 'requirements.english.ielts.minScore', label: 'requirements.ielts', significance: 'MINOR' },
  { path: 'requirements.minimumGpa.value', label: 'requirements.minimumGpa', significance: 'MINOR' },
  { path: 'academicYear', label: 'academicYear', significance: 'MINOR' }
];

function valueAt(obj: any, path: string): unknown {
  return path.split('.').reduce((acc, key) => (acc == null ? undefined : acc[key]), obj);
}

/**
 * Fields compared at day granularity rather than exact value.
 *
 * Two sources for the same award routinely state the same deadline at
 * different precision — the scholarship office writes "23:59 GMT on 15
 * January 2027", the faculty page writes "15 January 2027". Those parse to
 * 23:59:00 and 23:59:59 on the same day. Comparing exactly would emit a MAJOR
 * "deadline changed" event every time the crawler alternated between the two
 * sources, which is both wrong and would poison deadline alerts.
 */
const DAY_GRANULARITY_FIELDS = new Set(['deadline.date']);

/** Normalize for comparison so Date vs ISO-string and array order don't false-positive. */
function comparable(v: unknown, path?: string): string {
  if (v === null || v === undefined) return '\u0000null';
  if (v instanceof Date) {
    return path && DAY_GRANULARITY_FIELDS.has(path)
      ? v.toISOString().slice(0, 10)
      : v.toISOString();
  }
  if (typeof v === 'string' && path && DAY_GRANULARITY_FIELDS.has(path) && /^\d{4}-\d{2}-\d{2}T/.test(v)) {
    return v.slice(0, 10);
  }
  if (Array.isArray(v)) return [...v].map((x) => String(x)).sort().join(',');
  return String(v);
}

export interface DetectedChange {
  field: string;
  oldValue: unknown;
  newValue: unknown;
  significance: 'MAJOR' | 'MINOR';
}

/**
 * Diff a stored scholarship against a freshly-extracted version.
 *
 * A change from a known value to UNKNOWN is *not* reported. Pages get
 * restructured, extraction misses a section, and reporting "funding changed to
 * unknown" every time a selector shifts would drown the real signal.
 */
export function detectChanges(existing: any, incoming: any): DetectedChange[] {
  const changes: DetectedChange[] = [];
  for (const { path, label, significance } of TRACKED) {
    const before = valueAt(existing, path);
    const after = valueAt(incoming, path);
    const a = comparable(before, path);
    const b = comparable(after, path);
    if (a === b) continue;

    // Losing information is a extraction-quality event, not a content change
    const lostInfo =
      (before !== null && before !== undefined && String(before) !== 'UNKNOWN') &&
      (after === null || after === undefined || String(after) === 'UNKNOWN' ||
        (Array.isArray(after) && after.length === 0) ||
        (Array.isArray(after) && after.length === 1 && after[0] === 'UNKNOWN'));
    if (lostInfo) continue;

    changes.push({ field: label, oldValue: before ?? null, newValue: after ?? null, significance });
  }
  return changes;
}

export async function recordChanges(
  scholarshipId: unknown,
  changes: DetectedChange[],
  ctx: { sourceUrl?: string; crawlRunId?: unknown } = {}
): Promise<number> {
  if (changes.length === 0) return 0;
  const now = new Date();
  await ScholarshipChangeModel.insertMany(
    changes.map((c) => ({
      scholarshipId,
      field: c.field,
      oldValue: c.oldValue,
      newValue: c.newValue,
      changeType: 'UPDATED',
      significance: c.significance,
      detectedAt: now,
      sourceUrl: ctx.sourceUrl,
      crawlRunId: ctx.crawlRunId
    })),
    { ordered: false }
  ).catch((err) => logger.warn({ err }, 'scholarship: failed to record changes'));

  await ScholarshipModel.updateOne({ _id: scholarshipId }, { $set: { lastChangedAt: now } });
  return changes.length;
}

/** Human-readable status label for the UI. */
export function statusLabel(s: ScholarshipStatus): string {
  return {
    DISCOVERED: 'Discovered',
    UNDER_REVIEW: 'Under review',
    VERIFIED: 'Verified',
    UPCOMING: 'Upcoming',
    OPEN: 'Open',
    CLOSING_SOON: 'Closing soon',
    CLOSED: 'Closed',
    EXPIRED: 'Expired',
    REPLACED: 'Replaced'
  }[s] ?? s;
}
