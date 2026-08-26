// Shared vocabulary for the scholarship vertical.
//
// Everything here is a *closed* set. Normalizers map free text onto these
// values; anything the source does not clearly support becomes UNKNOWN rather
// than a guess (see §14, §56 of the directive).

export const DEGREE_LEVELS = [
  'BACHELORS',
  'MASTERS',
  'PHD',
  // reserved for future expansion — already accepted by the schema so no
  // migration is needed when the extractors start emitting them
  'POSTDOC',
  'DIPLOMA',
  'CERTIFICATE',
  'RESEARCH_FELLOWSHIP'
] as const;
export type DegreeLevel = (typeof DEGREE_LEVELS)[number];

export const STUDY_MODES = ['ON_CAMPUS', 'ONLINE', 'HYBRID', 'DISTANCE', 'UNKNOWN'] as const;
export type StudyMode = (typeof STUDY_MODES)[number];

export const ATTENDANCE_MODES = ['FULL_TIME', 'PART_TIME', 'BOTH', 'UNKNOWN'] as const;
export type AttendanceMode = (typeof ATTENDANCE_MODES)[number];

export const DELIVERY_MODES = ['IN_PERSON', 'REMOTE', 'MIXED', 'UNKNOWN'] as const;
export type DeliveryMode = (typeof DELIVERY_MODES)[number];

export const FUNDING_TYPES = [
  'FULLY_FUNDED',
  'PARTIALLY_FUNDED',
  'TUITION_ONLY',
  'TUITION_PLUS_STIPEND',
  'LIVING_STIPEND',
  'RESEARCH_FUNDING',
  'TRAVEL_GRANT',
  'ACCOMMODATION',
  'APPLICATION_FEE_WAIVER',
  'MERIT_BASED',
  'NEED_BASED',
  'SPORTS',
  'GOVERNMENT',
  'UNIVERSITY',
  'EXTERNAL',
  'FELLOWSHIP',
  'UNKNOWN'
] as const;
export type FundingType = (typeof FUNDING_TYPES)[number];

/**
 * Three-plus-one state truth value.
 *
 * The whole point of §56: "unknown" and "false" are different states. A page
 * that never mentions IELTS yields UNKNOWN, never NO. A page that says
 * "IELTS is not required" yields NO.
 */
export const CERTAINTY = ['CONFIRMED', 'PROBABLE', 'UNKNOWN', 'NEGATIVE'] as const;
export type Certainty = (typeof CERTAINTY)[number];

export const ELIGIBILITY_SCOPES = [
  'INTERNATIONAL',
  'DOMESTIC',
  'BOTH',
  'SPECIFIC_COUNTRIES',
  'SPECIFIC_REGIONS',
  'UNKNOWN'
] as const;
export type EligibilityScope = (typeof ELIGIBILITY_SCOPES)[number];

export const DEADLINE_KINDS = ['FIXED', 'ROLLING', 'MULTIPLE_ROUNDS', 'UNKNOWN'] as const;
export type DeadlineKind = (typeof DEADLINE_KINDS)[number];

/** Lifecycle status. Distinct from reviewStatus — see below. */
export const SCHOLARSHIP_STATUSES = [
  'DISCOVERED',
  'UNDER_REVIEW',
  'VERIFIED',
  'UPCOMING',
  'OPEN',
  'CLOSING_SOON',
  'CLOSED',
  'EXPIRED',
  'REPLACED'
] as const;
export type ScholarshipStatus = (typeof SCHOLARSHIP_STATUSES)[number];

/**
 * Human moderation state, kept separate from the lifecycle status so a
 * scholarship can be simultaneously OPEN and NEEDS_REVIEW (§34).
 */
export const REVIEW_STATUSES = ['AUTO_APPROVED', 'NEEDS_REVIEW', 'APPROVED', 'REJECTED'] as const;
export type ReviewStatus = (typeof REVIEW_STATUSES)[number];

export const SOURCE_TYPES = [
  'UNIVERSITY',
  'GOVERNMENT',
  'PROVIDER',
  'FACULTY',
  'INSTITUTIONAL',
  'AGGREGATOR',
  'PDF',
  'OTHER'
] as const;
export type SourceType = (typeof SOURCE_TYPES)[number];

/** §47 — lower number wins when choosing the primary source. */
export const SOURCE_AUTHORITY: Record<SourceType, number> = {
  UNIVERSITY: 1,
  GOVERNMENT: 2,
  PROVIDER: 3,
  FACULTY: 4,
  INSTITUTIONAL: 5,
  PDF: 5,
  AGGREGATOR: 6,
  OTHER: 7
};

export const TARGET_TYPES = [
  'UNIVERSITY',
  'SCHOLARSHIP',
  'FUNDING',
  'ADMISSIONS',
  'PDF',
  'OTHER'
] as const;
export type TargetType = (typeof TARGET_TYPES)[number];

export const TARGET_STATUSES = [
  'PENDING',
  'PROCESSING',
  'COMPLETED',
  'FAILED',
  'BLOCKED',
  'SKIPPED'
] as const;
export type TargetStatus = (typeof TARGET_STATUSES)[number];

export const EXTRACTION_METHODS = ['RULES', 'AI', 'HYBRID', 'MANUAL'] as const;
export type ExtractionMethod = (typeof EXTRACTION_METHODS)[number];

/**
 * A value plus where it came from (§19, §55).
 *
 * Nothing important is stored as a bare value. If an admin cannot see the
 * sentence the crawler read, the field is not trustworthy.
 */
export interface Provenance<T = unknown> {
  value: T;
  confidence: number;
  certainty: Certainty;
  sourceUrl?: string;
  sourceText?: string;
  method?: ExtractionMethod;
}

export function prov<T>(
  value: T,
  opts: Partial<Omit<Provenance<T>, 'value'>> = {}
): Provenance<T> {
  return {
    value,
    confidence: opts.confidence ?? 0,
    certainty: opts.certainty ?? 'UNKNOWN',
    sourceUrl: opts.sourceUrl,
    sourceText: opts.sourceText,
    method: opts.method ?? 'RULES'
  };
}

export function unknownProv<T>(fallback: T): Provenance<T> {
  return { value: fallback, confidence: 0, certainty: 'UNKNOWN', method: 'RULES' };
}
