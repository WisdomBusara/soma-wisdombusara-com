/**
 * Client for the public scholarship API (/api).
 *
 * Separate from api/client.ts on purpose: that client carries credentials and
 * CSRF headers for the authenticated admin, whereas the scholarship site is a
 * public, unauthenticated surface. Sending cookies there would be pointless at
 * best and a CORS problem at worst.
 */

const API_BASE =
  (import.meta.env.VITE_PUBLIC_API_BASE_URL as string | undefined) ?? '/api';

export async function publicFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers ?? {});
  if (init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  // credentials:'include' so the paywall cookie travels when the site and
  // API are on different origins.
  const res = await fetch(`${API_BASE}${path}`, { credentials: 'include', ...init, headers });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    // Attach the body so callers can act on structured errors (the 402 paywall
    // response carries preview data the detail page renders).
    const err = new Error(data?.message ?? data?.error ?? `Request failed (${res.status})`);
    (err as any).status = res.status;
    (err as any).payload = data;
    throw err;
  }
  return data as T;
}

// ── Shared shapes ───────────────────────────────────────────────────────────

export type DegreeLevel =
  | 'BACHELORS' | 'MASTERS' | 'PHD' | 'POSTDOC'
  | 'DIPLOMA' | 'CERTIFICATE' | 'RESEARCH_FELLOWSHIP';

export type Certainty = 'CONFIRMED' | 'PROBABLE' | 'UNKNOWN' | 'NEGATIVE';

export interface ScholarshipListItem {
  id: string;
  title: string;
  university: string | null;
  universityId: string | null;
  provider: string | null;
  country: string;
  countryCode: string | null;
  city: string | null;
  degreeLevels: DegreeLevel[];
  fieldsOfStudy: string[];
  studyMode: string[];
  attendance: string[];
  funding: {
    primaryType: string;
    certainty: Certainty;
    types: string[];
    tuitionCovered: boolean | null;
    livingStipend: boolean | null;
    stipendAmount: number | null;
    stipendCurrency: string | null;
  };
  eligibility: { scope: string; countries: string[]; regions: string[] };
  deadline: { kind: string; date: string | null; originalText: string | null };
  status: string;
  confidence: number;
  qualityScore: number;
  hasOfficialSource: boolean;
  needsVerification: boolean;
  extractionMethod: string;
  lastVerifiedAt: string | null;
  lastCrawledAt: string | null;
  nationalityMatch?: 'EXPLICIT' | 'OPEN_TO_ALL' | 'INTERNATIONAL_UNCONFIRMED' | 'REGION_OR_UNCONFIRMED';
  match?: {
    percentage: number;
    eligible: boolean;
    uncertain: boolean;
    passed: { label: string; detail: string }[];
    warnings: { label: string; detail: string }[];
    failures: { label: string; detail: string }[];
  };
}

export interface Provenance<T = unknown> {
  value: T;
  confidence: number;
  certainty: Certainty;
  sourceUrl?: string;
  sourceText?: string;
  method?: string;
}

export interface ScholarshipDetail extends ScholarshipListItem {
  description: string | null;
  intake: string | null;
  academicYear: string | null;
  duration: string | null;
  deliveryMode: string[];
  fundingDetail: any;
  eligibilityDetail: any;
  requirements: any;
  deadlineDetail: any;
  applicationUrl: string | null;
  sourceUrl: string;
  classificationReasons: string[];
  sources: {
    url: string; type: string; isPrimary: boolean;
    firstSeen: string; lastSeen: string; verificationStatus: string;
  }[];
  // Named separately from the inherited `university` (a display name string)
  universityRef: { id: string; name: string; website: string; country: string; city: string | null } | null;
}

export interface Pagination {
  page: number; limit: number; total: number; totalPages: number; hasMore: boolean;
}

export interface Facets {
  countries: { code: string; name: string; count: number }[];
  degreeLevels: { value: string; count: number }[];
  fundingTypes: { value: string; count: number }[];
  fields: { value: string; count: number }[];
}

// ── Presentation helpers ────────────────────────────────────────────────────

export const DEGREE_LABELS: Record<string, string> = {
  BACHELORS: "Bachelor's", MASTERS: "Master's", PHD: 'PhD',
  POSTDOC: 'Postdoctoral', DIPLOMA: 'Diploma', CERTIFICATE: 'Certificate',
  RESEARCH_FELLOWSHIP: 'Research Fellowship'
};

export const FUNDING_LABELS: Record<string, string> = {
  FULLY_FUNDED: 'Fully funded', PARTIALLY_FUNDED: 'Partially funded',
  TUITION_ONLY: 'Tuition only', TUITION_PLUS_STIPEND: 'Tuition + stipend',
  LIVING_STIPEND: 'Living stipend', RESEARCH_FUNDING: 'Research funding',
  TRAVEL_GRANT: 'Travel grant', ACCOMMODATION: 'Accommodation',
  APPLICATION_FEE_WAIVER: 'Fee waiver', MERIT_BASED: 'Merit based',
  NEED_BASED: 'Need based', SPORTS: 'Sports', GOVERNMENT: 'Government',
  UNIVERSITY: 'University', EXTERNAL: 'External', FELLOWSHIP: 'Fellowship',
  UNKNOWN: 'Not stated'
};

export const STATUS_LABELS: Record<string, string> = {
  DISCOVERED: 'Discovered', UNDER_REVIEW: 'Under review', VERIFIED: 'Verified',
  UPCOMING: 'Upcoming', OPEN: 'Open', CLOSING_SOON: 'Closing soon',
  CLOSED: 'Closed', EXPIRED: 'Expired', REPLACED: 'Replaced'
};

export const MODE_LABELS: Record<string, string> = {
  ON_CAMPUS: 'On campus', ONLINE: 'Online', HYBRID: 'Hybrid',
  DISTANCE: 'Distance', FULL_TIME: 'Full-time', PART_TIME: 'Part-time',
  BOTH: 'Full or part-time', IN_PERSON: 'In person', REMOTE: 'Remote',
  MIXED: 'Mixed', UNKNOWN: 'Not stated'
};

export const label = (map: Record<string, string>, key: string): string =>
  map[key] ?? key.replace(/_/g, ' ').toLowerCase();

/**
 * Render a tri-state boolean.
 *
 * The whole point of §56 surfaced in the UI: `null` renders as "Not stated",
 * never as a cross. A user must be able to tell "the page says no" apart from
 * "the page didn't say".
 */
export function triState(v: boolean | null | undefined): { icon: string; text: string; tone: 'yes' | 'no' | 'unknown' } {
  if (v === true) return { icon: '✓', text: 'Covered', tone: 'yes' };
  if (v === false) return { icon: '✕', text: 'Not covered', tone: 'no' };
  return { icon: '?', text: 'Not stated', tone: 'unknown' };
}

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
}

export function daysUntil(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return Math.ceil((d.getTime() - Date.now()) / 86_400_000);
}

export function formatMoney(amount: number | null, currency: string | null): string | null {
  if (amount === null) return null;
  const n = amount.toLocaleString('en-GB');
  return currency ? `${currency} ${n}` : n;
}

export function statusTone(status: string): 'green' | 'yellow' | 'red' | 'gray' {
  if (status === 'OPEN' || status === 'VERIFIED') return 'green';
  if (status === 'CLOSING_SOON' || status === 'UPCOMING') return 'yellow';
  if (status === 'CLOSED' || status === 'EXPIRED') return 'red';
  return 'gray';
}
