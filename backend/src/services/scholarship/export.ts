import { isValidObjectId } from 'mongoose';
import { z } from 'zod';

import { logger } from '../../config/logger';
import { ScholarshipModel } from '../../models/scholarship/Scholarship';
import { writeCsv, writeXlsx, type SheetColumn, type SheetValue } from '../../utils/spreadsheet';

/**
 * Scholarship spreadsheet export (admin "Export" button + CLI `export`).
 *
 * Columns are chosen for someone sitting down to *apply*, not to audit the
 * crawler: what it pays, who can apply, what to prepare, when it closes and
 * where to click. Crawler internals (fingerprints, classifier reasons, raw
 * extraction text) are deliberately left out.
 *
 * Tri-state fields follow §56 all the way into the sheet: a `null` ("the page
 * never said") renders as an empty cell, never as "No".
 */

export const EXPORT_FORMATS = ['xlsx', 'csv'] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

// Keeps a single export bounded in memory and under Excel's 65,530
// hyperlinks-per-sheet limit (two link columns per row).
export const MAX_EXPORT_ROWS = 20_000;

// ── Filters (shared with the admin list route) ──────────────────────────────

export const scholarshipFilterQuery = z.object({
  status: z.string().optional(),
  reviewStatus: z.string().optional(),
  country: z.string().optional(),
  university: z.string().optional(),
  degree: z.string().optional(),
  minConfidence: z.coerce.number().min(0).max(1).optional(),
  maxConfidence: z.coerce.number().min(0).max(1).optional(),
  q: z.string().max(200).optional()
});
export type ScholarshipFilterQuery = z.infer<typeof scholarshipFilterQuery>;

export function buildScholarshipFilter(q: ScholarshipFilterQuery): Record<string, any> {
  const filter: Record<string, any> = {};
  if (q.status) filter.status = { $in: q.status.split(',') };
  if (q.reviewStatus) filter.reviewStatus = { $in: q.reviewStatus.split(',') };
  if (q.country) filter.countryCode = { $in: q.country.split(',').map((c) => c.toUpperCase()) };
  if (q.university && isValidObjectId(q.university)) filter.universityId = q.university;
  if (q.degree) filter.degreeLevels = { $in: q.degree.split(',').map((d) => d.toUpperCase()) };
  if (q.minConfidence !== undefined || q.maxConfidence !== undefined) {
    filter.confidence = {};
    if (q.minConfidence !== undefined) filter.confidence.$gte = q.minConfidence;
    if (q.maxConfidence !== undefined) filter.confidence.$lte = q.maxConfidence;
  }
  if (q.q) filter.$text = { $search: q.q };
  return filter;
}

// ── Source shape ────────────────────────────────────────────────────────────

type Prov<T> = { value?: T | null } | null | undefined;
type Money = { amount?: number | null; currency?: string | null; period?: string | null; originalText?: string | null } | null | undefined;
type EnglishTest = { required?: boolean | null; minScore?: number | null; detail?: string | null; waiverAvailable?: boolean | null } | null | undefined;

/** Only the fields the export reads — matches EXPORT_PROJECTION below. */
export interface ExportSource {
  _id: unknown;
  title: string;
  universityName?: string | null;
  provider?: string | null;
  country?: string | null;
  city?: string | null;
  degreeLevels?: string[];
  fieldsOfStudy?: string[];
  studyMode?: string[];
  attendance?: string[];
  intake?: string | null;
  academicYear?: string | null;
  duration?: string | null;
  description?: string | null;
  status?: string;
  reviewStatus?: string;
  confidence?: number;
  hasOfficialSource?: boolean;
  lastVerifiedAt?: Date | null;
  sourceUrl?: string;
  applicationUrl?: Prov<string>;
  deadline?: { date?: Date | null; kind?: string | null; originalText?: string | null } | null;
  funding?: Record<string, any> & {
    primaryType?: string;
    tuitionPercentage?: Prov<number>;
    tuitionAmount?: Money;
    stipendAmount?: Money;
    awardCount?: Prov<number>;
  };
  eligibility?: {
    scope?: string;
    countries?: string[];
    excludedCountries?: string[];
    regions?: string[];
    categories?: string[];
    womenOnly?: Prov<boolean>;
    refugeesEligible?: Prov<boolean>;
    developingCountriesOnly?: Prov<boolean>;
    ageMin?: Prov<number>;
    ageMax?: Prov<number>;
    residencyRequirement?: Prov<string>;
    citizenshipRequirement?: Prov<string>;
  };
  requirements?: {
    minimumDegree?: Prov<string>;
    minimumGpa?: Prov<number>;
    gpaScale?: Prov<number>;
    minimumGrade?: Prov<string>;
    english?: Record<string, any> & { anyTestRequired?: boolean | null };
    documents?: { label?: string; count?: number | null }[];
    workExperienceRequired?: Prov<boolean>;
    workExperienceYears?: Prov<number>;
    professionalRegistration?: Prov<string>;
    supervisorRequired?: Prov<boolean>;
    admissionOfferRequired?: Prov<boolean>;
  };
}

const COVERAGE: [field: string, label: string][] = [
  ['tuitionCovered', 'Tuition'],
  ['livingStipend', 'Living stipend'],
  ['travelCovered', 'Travel'],
  ['airfareCovered', 'Airfare'],
  ['accommodationCovered', 'Accommodation'],
  ['healthInsurance', 'Health insurance'],
  ['researchAllowance', 'Research allowance'],
  ['booksAllowance', 'Books'],
  ['equipmentAllowance', 'Equipment'],
  ['applicationFeeWaiver', 'Application fee waiver'],
  ['visaSupport', 'Visa support']
];

const ENGLISH_TESTS: [key: string, label: string][] = [
  ['ielts', 'IELTS'], ['toefl', 'TOEFL'], ['pte', 'PTE'], ['cambridge', 'Cambridge'], ['duolingo', 'Duolingo']
];

/**
 * Explicit inclusion projection. Provenance envelopes carry up to 1.2 kB of
 * `sourceText` each and the raw*Text arrays are unbounded, so selecting whole
 * sub-documents would pull megabytes the sheet never shows.
 */
const EXPORT_PROJECTION = [
  'title', 'universityName', 'provider', 'country', 'city', 'degreeLevels', 'fieldsOfStudy',
  'studyMode', 'attendance', 'intake', 'academicYear', 'duration', 'description',
  'status', 'reviewStatus', 'confidence', 'hasOfficialSource', 'lastVerifiedAt', 'sourceUrl',
  'applicationUrl.value',
  'deadline.date', 'deadline.kind', 'deadline.originalText',
  'funding.primaryType', 'funding.tuitionPercentage.value', 'funding.awardCount.value',
  ...['tuitionAmount', 'stipendAmount'].flatMap((m) =>
    ['amount', 'currency', 'period', 'originalText'].map((f) => `funding.${m}.${f}`)),
  ...COVERAGE.map(([f]) => `funding.${f}.value`),
  'eligibility.scope', 'eligibility.countries', 'eligibility.excludedCountries',
  'eligibility.regions', 'eligibility.categories',
  ...['womenOnly', 'refugeesEligible', 'developingCountriesOnly', 'ageMin', 'ageMax',
    'residencyRequirement', 'citizenshipRequirement'].map((f) => `eligibility.${f}.value`),
  ...['minimumDegree', 'minimumGpa', 'gpaScale', 'minimumGrade', 'workExperienceRequired',
    'workExperienceYears', 'professionalRegistration', 'supervisorRequired',
    'admissionOfferRequired'].map((f) => `requirements.${f}.value`),
  'requirements.english.anyTestRequired',
  ...ENGLISH_TESTS.flatMap(([t]) =>
    ['required', 'minScore', 'detail', 'waiverAvailable'].map((f) => `requirements.english.${t}.${f}`)),
  'requirements.documents.label', 'requirements.documents.count'
].join(' ');

// ── Formatting ──────────────────────────────────────────────────────────────

const DEGREE_LABELS: Record<string, string> = {
  BACHELORS: "Bachelor's", MASTERS: "Master's", PHD: 'PhD', POSTDOC: 'Postdoctoral',
  DIPLOMA: 'Diploma', CERTIFICATE: 'Certificate', RESEARCH_FELLOWSHIP: 'Research Fellowship'
};

/** FULLY_FUNDED → "Fully funded"; UNKNOWN → "" (not stated). */
function humanize(v: string | null | undefined): string {
  if (!v || v === 'UNKNOWN') return '';
  const s = v.replace(/_/g, ' ').toLowerCase();
  return s[0].toUpperCase() + s.slice(1);
}

const joinKnown = (xs: (string | null | undefined)[] | undefined, sep = ', ') =>
  (xs ?? []).map((x) => humanize(x)).filter(Boolean).join(sep);

function money(m: Money): string {
  if (!m) return '';
  if (typeof m.amount === 'number') {
    const n = m.amount.toLocaleString('en-GB');
    return [m.currency, n, m.period].filter(Boolean).join(' ');
  }
  return m.originalText ?? '';
}

function yesNo(v: boolean | null | undefined): string {
  return v === true ? 'Yes' : v === false ? 'No' : '';
}

function openTo(e: ExportSource['eligibility']): string {
  if (!e) return '';
  const parts: string[] = [];
  const scope = humanize(e.scope);
  if (scope) parts.push(scope);
  if (e.countries?.length) parts.push(`Countries: ${e.countries.join(', ')}`);
  if (e.regions?.length) parts.push(`Regions: ${e.regions.join(', ')}`);
  return parts.join('; ');
}

function otherEligibility(e: ExportSource['eligibility']): string {
  if (!e) return '';
  const parts: string[] = [...(e.categories ?? [])];
  if (e.womenOnly?.value === true) parts.push('Women only');
  if (e.refugeesEligible?.value === true) parts.push('Refugees eligible');
  if (e.developingCountriesOnly?.value === true) parts.push('Developing countries only');
  const min = e.ageMin?.value;
  const max = e.ageMax?.value;
  if (typeof min === 'number' && typeof max === 'number') parts.push(`Age ${min}–${max}`);
  else if (typeof min === 'number') parts.push(`Age ${min}+`);
  else if (typeof max === 'number') parts.push(`Age up to ${max}`);
  if (e.citizenshipRequirement?.value) parts.push(e.citizenshipRequirement.value);
  if (e.residencyRequirement?.value) parts.push(e.residencyRequirement.value);
  return parts.join('; ');
}

function academic(r: ExportSource['requirements']): string {
  if (!r) return '';
  const parts: string[] = [];
  const degree = r.minimumDegree?.value;
  if (degree) parts.push(`Min. degree: ${DEGREE_LABELS[degree] ?? humanize(degree)}`);
  const gpa = r.minimumGpa?.value;
  if (typeof gpa === 'number') {
    const scale = r.gpaScale?.value;
    parts.push(`Min. GPA: ${gpa}${typeof scale === 'number' ? `/${scale}` : ''}`);
  }
  if (r.minimumGrade?.value) parts.push(`Min. grade: ${r.minimumGrade.value}`);
  return parts.join('; ');
}

function english(r: ExportSource['requirements']): string {
  const en = r?.english;
  if (!en) return '';
  const parts: string[] = [];
  for (const [key, label] of ENGLISH_TESTS) {
    const t = en[key] as EnglishTest;
    if (!t || t.required !== true) continue;
    let s = label;
    if (typeof t.minScore === 'number') s += ` ${t.minScore}`;
    if (t.detail) s += ` (${t.detail})`;
    if (t.waiverAvailable === true) s += ', waiver available';
    parts.push(s);
  }
  if (parts.length === 0 && en.anyTestRequired === false) return 'Not required';
  return parts.join('; ');
}

function workExperience(r: ExportSource['requirements']): string {
  const required = r?.workExperienceRequired?.value;
  const years = r?.workExperienceYears?.value;
  if (typeof years === 'number' && required !== false) return `${years}+ years`;
  return required === true ? 'Required' : required === false ? 'Not required' : '';
}

function otherRequirements(r: ExportSource['requirements']): string {
  if (!r) return '';
  const parts: string[] = [];
  if (r.admissionOfferRequired?.value === true) parts.push('Admission offer required');
  if (r.supervisorRequired?.value === true) parts.push('Supervisor required');
  if (r.professionalRegistration?.value) parts.push(`Registration: ${r.professionalRegistration.value}`);
  return parts.join('; ');
}

// ── Columns ─────────────────────────────────────────────────────────────────

interface ExportColumn extends SheetColumn {
  value: (s: ExportSource) => SheetValue;
}

export const EXPORT_COLUMNS: ExportColumn[] = [
  { header: 'Title', width: 45, value: (s) => s.title },
  { header: 'University', width: 30, value: (s) => s.universityName },
  { header: 'Provider', width: 25, value: (s) => s.provider },
  { header: 'Country', width: 16, value: (s) => s.country },
  { header: 'City', width: 14, value: (s) => s.city },
  { header: 'Degree level', width: 20, value: (s) => (s.degreeLevels ?? []).map((d) => DEGREE_LABELS[d] ?? humanize(d)).join(', ') },
  { header: 'Fields of study', width: 30, value: (s) => (s.fieldsOfStudy ?? []).join(', ') },
  { header: 'Funding', width: 20, value: (s) => humanize(s.funding?.primaryType) },
  {
    header: 'Covers', width: 35,
    value: (s) => COVERAGE.filter(([f]) => s.funding?.[f]?.value === true).map(([, label]) => label).join(', ')
  },
  {
    header: 'Tuition', width: 18,
    value: (s) => {
      const pct = s.funding?.tuitionPercentage?.value;
      return typeof pct === 'number' ? `${pct}%` : money(s.funding?.tuitionAmount);
    }
  },
  { header: 'Stipend', width: 22, value: (s) => money(s.funding?.stipendAmount) },
  { header: 'Number of awards', width: 10, value: (s) => s.funding?.awardCount?.value },
  { header: 'Deadline', width: 12, value: (s) => s.deadline?.date ?? null },
  { header: 'Deadline type', width: 14, value: (s) => humanize(s.deadline?.kind) },
  { header: 'Deadline (as stated)', width: 35, value: (s) => s.deadline?.originalText },
  { header: 'Status', width: 13, value: (s) => humanize(s.status) },
  { header: 'Open to', width: 30, value: (s) => openTo(s.eligibility) },
  { header: 'Excluded countries', width: 18, value: (s) => (s.eligibility?.excludedCountries ?? []).join(', ') },
  { header: 'Other eligibility', width: 30, value: (s) => otherEligibility(s.eligibility) },
  { header: 'Academic requirements', width: 30, value: (s) => academic(s.requirements) },
  { header: 'English test', width: 25, value: (s) => english(s.requirements) },
  {
    header: 'Documents', width: 40,
    value: (s) => (s.requirements?.documents ?? [])
      .filter((d) => d.label)
      .map((d) => (typeof d.count === 'number' && d.count > 1 ? `${d.label} (${d.count})` : d.label))
      .join('; ')
  },
  { header: 'Work experience', width: 15, value: (s) => workExperience(s.requirements) },
  { header: 'Other requirements', width: 25, value: (s) => otherRequirements(s.requirements) },
  { header: 'Study mode', width: 14, value: (s) => joinKnown(s.studyMode) },
  { header: 'Attendance', width: 14, value: (s) => joinKnown(s.attendance) },
  { header: 'Intake', width: 14, value: (s) => s.intake },
  { header: 'Academic year', width: 12, value: (s) => s.academicYear },
  { header: 'Duration', width: 14, value: (s) => s.duration },
  { header: 'Application link', width: 40, link: true, value: (s) => s.applicationUrl?.value },
  { header: 'Source page', width: 40, link: true, value: (s) => s.sourceUrl },
  { header: 'Description', width: 60, value: (s) => s.description },
  { header: 'Official source', width: 10, value: (s) => yesNo(s.hasOfficialSource) },
  { header: 'Review status', width: 15, value: (s) => humanize(s.reviewStatus) },
  { header: 'Confidence %', width: 10, value: (s) => (typeof s.confidence === 'number' ? Math.round(s.confidence * 100) : null) },
  { header: 'Last verified', width: 12, value: (s) => s.lastVerifiedAt ?? null },
  { header: 'ID', width: 26, value: (s) => String(s._id) },
  // Blank on purpose — for the applicant's own tracking
  { header: 'My status', width: 14, value: () => null },
  { header: 'My notes', width: 30, value: () => null }
];

// ── Loading & rendering ─────────────────────────────────────────────────────

/** Soonest deadline first; rolling/unknown deadlines after every dated one. */
export function sortForApplying(rows: ExportSource[]): ExportSource[] {
  const time = (s: ExportSource) => {
    const t = s.deadline?.date ? new Date(s.deadline.date).getTime() : NaN;
    return Number.isNaN(t) ? Infinity : t;
  };
  return [...rows].sort((a, b) => time(a) - time(b) || a.title.localeCompare(b.title));
}

export async function loadScholarshipsForExport(
  filter: Record<string, any>
): Promise<{ rows: ExportSource[]; truncated: boolean }> {
  const docs = await ScholarshipModel.find(filter)
    .select(EXPORT_PROJECTION)
    .sort({ 'deadline.date': 1, _id: 1 })
    .limit(MAX_EXPORT_ROWS + 1)
    .lean<ExportSource[]>();

  const truncated = docs.length > MAX_EXPORT_ROWS;
  if (truncated) {
    logger.warn({ filter, max: MAX_EXPORT_ROWS }, 'scholarship: export truncated — narrow the filters');
  }
  return { rows: sortForApplying(docs.slice(0, MAX_EXPORT_ROWS)), truncated };
}

export function renderScholarshipExport(rows: ExportSource[], format: ExportFormat): Buffer {
  const cells = rows.map((s) => EXPORT_COLUMNS.map((c) => c.value(s)));
  return format === 'csv'
    ? writeCsv(EXPORT_COLUMNS, cells)
    : writeXlsx('Scholarships', EXPORT_COLUMNS, cells);
}

export const EXPORT_CONTENT_TYPES: Record<ExportFormat, string> = {
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  csv: 'text/csv; charset=utf-8'
};

export function exportFilename(format: ExportFormat, now = new Date()): string {
  return `scholarships-${now.toISOString().slice(0, 10)}.${format}`;
}
