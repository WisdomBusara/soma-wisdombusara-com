import { z } from 'zod';
import {
  DEGREE_LEVELS, STUDY_MODES, ATTENDANCE_MODES, DELIVERY_MODES,
  ELIGIBILITY_SCOPES, DEADLINE_KINDS, CERTAINTY
} from '../../../models/scholarship/types';

/**
 * The contract the LLM must satisfy (§20).
 *
 * Every field is nullable and every field carries evidence. The schema is the
 * enforcement mechanism for §21 and §56: a model that wants to assert
 * `tuitionCovered: true` must supply the sentence it read that from, and a
 * model that has no information must emit `null`, which is a distinct,
 * representable value rather than an omission.
 *
 * `.strict()` is deliberate — an LLM inventing extra keys is a signal that it
 * has drifted from the instructions, and we would rather reject and retry than
 * silently accept a half-hallucinated object.
 */

const evidence = z.object({
  value: z.unknown(),
  confidence: z.number().min(0).max(1),
  certainty: z.enum(CERTAINTY),
  evidence: z.string().max(1000).nullable()
});

const boolField = z.object({
  value: z.boolean().nullable(),
  confidence: z.number().min(0).max(1),
  certainty: z.enum(CERTAINTY),
  evidence: z.string().max(1000).nullable()
}).strict();

const numField = z.object({
  value: z.number().nullable(),
  confidence: z.number().min(0).max(1),
  certainty: z.enum(CERTAINTY),
  evidence: z.string().max(1000).nullable()
}).strict();

const strField = z.object({
  value: z.string().max(1000).nullable(),
  confidence: z.number().min(0).max(1),
  certainty: z.enum(CERTAINTY),
  evidence: z.string().max(1000).nullable()
}).strict();

const moneyField = z.object({
  amount: z.number().nullable(),
  currency: z.string().max(8).nullable(),
  period: z.string().max(60).nullable(),
  originalText: z.string().max(600).nullable(),
  confidence: z.number().min(0).max(1),
  certainty: z.enum(CERTAINTY)
}).strict();

const englishTest = z.object({
  required: z.boolean().nullable(),
  minScore: z.number().nullable(),
  detail: z.string().max(400).nullable(),
  waiverAvailable: z.boolean().nullable(),
  confidence: z.number().min(0).max(1),
  evidence: z.string().max(600).nullable()
}).strict();

export const aiExtractionSchema = z.object({
  isScholarship: z.boolean(),
  classificationConfidence: z.number().min(0).max(1),
  classificationReasons: z.array(z.string().max(200)).max(12),

  title: z.string().min(2).max(400).nullable(),
  provider: z.string().max(200).nullable(),
  description: z.string().max(2000).nullable(),

  degreeLevels: z.array(z.enum(DEGREE_LEVELS)).max(7),
  degreeEvidence: z.array(z.string().max(600)).max(7),

  fieldsOfStudy: z.array(z.string().max(120)).max(30),

  studyMode: z.array(z.enum(STUDY_MODES)).max(5),
  attendance: z.array(z.enum(ATTENDANCE_MODES)).max(4),
  deliveryMode: z.array(z.enum(DELIVERY_MODES)).max(4),
  modeEvidence: z.array(z.string().max(600)).max(6),

  funding: z.object({
    primaryType: z.string().max(40).nullable(),
    tuitionCovered: boolField,
    tuitionPercentage: numField,
    livingStipend: boolField,
    stipendAmount: moneyField,
    travelCovered: boolField,
    airfareCovered: boolField,
    accommodationCovered: boolField,
    healthInsurance: boolField,
    researchAllowance: boolField,
    booksAllowance: boolField,
    equipmentAllowance: boolField,
    applicationFeeWaiver: boolField,
    visaSupport: boolField,
    awardCount: numField
  }).strict(),

  eligibility: z.object({
    scope: z.enum(ELIGIBILITY_SCOPES),
    scopeEvidence: z.string().max(1000).nullable(),
    countries: z.array(z.string().length(2)).max(200),
    excludedCountries: z.array(z.string().length(2)).max(200),
    regions: z.array(z.string().max(60)).max(20),
    categories: z.array(z.string().max(80)).max(20),
    ageMin: numField,
    ageMax: numField
  }).strict(),

  requirements: z.object({
    minimumDegree: z.object({
      value: z.enum(DEGREE_LEVELS).nullable(),
      confidence: z.number().min(0).max(1),
      certainty: z.enum(CERTAINTY),
      evidence: z.string().max(1000).nullable()
    }).strict(),
    minimumGpa: numField,
    gpaScale: numField,
    minimumGrade: strField,
    english: z.object({
      ielts: englishTest,
      toefl: englishTest,
      pte: englishTest,
      duolingo: englishTest,
      anyTestRequired: z.boolean().nullable()
    }).strict(),
    documents: z.array(z.object({
      code: z.string().max(60),
      label: z.string().max(200),
      count: z.number().nullable(),
      mandatory: z.boolean().nullable(),
      evidence: z.string().max(600).nullable()
    }).strict()).max(30),
    workExperienceRequired: boolField,
    workExperienceYears: numField,
    supervisorRequired: boolField,
    admissionOfferRequired: boolField
  }).strict(),

  deadline: z.object({
    kind: z.enum(DEADLINE_KINDS),
    // ISO date string or null. Never a natural-language date.
    date: z.string().max(40).nullable(),
    originalText: z.string().max(600).nullable(),
    timezoneStated: z.string().max(20).nullable(),
    confidence: z.number().min(0).max(1),
    certainty: z.enum(CERTAINTY)
  }).strict(),

  applicationUrl: strField,
  academicYear: z.string().max(40).nullable(),
  intake: z.string().max(120).nullable(),
  duration: z.string().max(120).nullable()
}).strict();

export type AiExtraction = z.infer<typeof aiExtractionSchema>;

export interface ValidationOutcome {
  ok: boolean;
  data?: AiExtraction;
  errors: string[];
}

/**
 * Parse and validate raw model output.
 *
 * Tolerates the two things every LLM does regardless of instructions —
 * wrapping JSON in a markdown fence, and prefixing it with a sentence — but
 * nothing beyond that. Everything else is a rejection.
 */
export function validateAiOutput(raw: string): ValidationOutcome {
  if (!raw || !raw.trim()) return { ok: false, errors: ['empty response'] };

  let text = raw.trim();
  const fence = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  if (fence) text = fence[1].trim();

  // Trim any prose before the first { / after the last }
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) return { ok: false, errors: ['no JSON object found'] };
  text = text.slice(start, end + 1);

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err: any) {
    return { ok: false, errors: [`JSON parse failed: ${err?.message ?? 'unknown'}`] };
  }

  const result = aiExtractionSchema.safeParse(parsed);
  if (!result.success) {
    return {
      ok: false,
      errors: result.error.issues.slice(0, 20).map((i) => `${i.path.join('.')}: ${i.message}`)
    };
  }

  // Cross-field sanity checks the schema cannot express.
  const errors: string[] = [];
  const d = result.data;

  if (d.deadline.date) {
    const parsedDate = new Date(d.deadline.date);
    if (Number.isNaN(parsedDate.getTime())) errors.push('deadline.date is not a valid ISO date');
    else {
      const year = parsedDate.getUTCFullYear();
      if (year < 2000 || year > 2100) errors.push(`deadline.date year out of range: ${year}`);
    }
  }
  // §58: INTERNATIONAL must not be smuggled in as a country list
  if (d.eligibility.scope === 'INTERNATIONAL' && d.eligibility.countries.length > 40) {
    errors.push('eligibility: INTERNATIONAL scope must not enumerate a country list');
  }
  for (const c of [...d.eligibility.countries, ...d.eligibility.excludedCountries]) {
    if (!/^[A-Z]{2}$/.test(c)) errors.push(`eligibility: "${c}" is not an ISO-3166 alpha-2 code`);
  }
  // §21: an assertion without evidence is not acceptable
  const assertedWithoutEvidence: string[] = [];
  for (const [k, v] of Object.entries(d.funding)) {
    if (v && typeof v === 'object' && 'value' in v && (v as any).value === true && !(v as any).evidence) {
      assertedWithoutEvidence.push(`funding.${k}`);
    }
  }
  if (assertedWithoutEvidence.length > 0) {
    errors.push(`asserted without evidence: ${assertedWithoutEvidence.join(', ')}`);
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, data: d, errors: [] };
}
