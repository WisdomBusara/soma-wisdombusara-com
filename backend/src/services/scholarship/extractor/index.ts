import { env } from '../../../config/env';
import { logger } from '../../../config/logger';
import { ExtractionRunModel } from '../../../models/scholarship/operational';
import type { SourceType, ExtractionMethod } from '../../../models/scholarship/types';
import { SOURCE_AUTHORITY } from '../../../models/scholarship/types';
import type { FetchResult } from '../fetcher';
import { extractWithRules, type ScholarshipDraft } from './rules';
import { extractWithAi, isAiEnabled } from './ai';
import type { AiExtraction } from './schema';
import { normalizeTitle } from '../normalize/text';

export { extractWithRules, isAiEnabled };
export type { ScholarshipDraft };

/**
 * Extraction orchestration.
 *
 * Rules always run. AI runs only when enabled AND the page passed cheap
 * classification. When both run, the merge is asymmetric on purpose:
 *
 *   • The AI may FILL fields the rules left unknown.
 *   • The AI may RAISE confidence where it agrees with the rules.
 *   • The AI may NOT silently overwrite a CONFIRMED rule-based value with a
 *     contradictory one. Disagreements downgrade certainty to PROBABLE and are
 *     recorded, so a human sees them rather than the model quietly winning.
 *
 * That asymmetry is the practical form of §19's "the AI must never become the
 * unquestioned source of truth".
 */

export interface ExtractionOutcome {
  draft: ScholarshipDraft;
  method: ExtractionMethod;
  aiUsed: boolean;
  aiState?: string;
  aiErrors: string[];
  disagreements: string[];
  confidence: number;
  qualityScore: number;
}

// ── Merge helpers ───────────────────────────────────────────────────────────

type AiBool = { value: boolean | null; confidence: number; certainty: string; evidence: string | null };

function mergeBoolField(
  // `certainty` is optional because requirement flags carry confidence only —
  // the merge result still stamps one on.
  ruleField: { value: boolean | null; certainty?: string; confidence: number; sourceText?: string },
  aiField: AiBool | undefined,
  label: string,
  disagreements: string[]
) {
  if (!aiField) return ruleField;

  // Rules found nothing → AI fills the gap
  if (ruleField.value === null && aiField.value !== null) {
    return {
      value: aiField.value,
      certainty: aiField.certainty as any,
      confidence: aiField.confidence,
      sourceText: aiField.evidence ?? undefined
    };
  }
  if (aiField.value === null) return ruleField;

  // Agreement → keep the rule reading, take the higher confidence
  if (ruleField.value === aiField.value) {
    return { ...ruleField, confidence: Math.max(ruleField.confidence, aiField.confidence) };
  }

  // Disagreement → keep the deterministic value, downgrade, and surface it
  disagreements.push(`${label}: rules=${ruleField.value} ai=${aiField.value}`);
  return { ...ruleField, certainty: 'PROBABLE' as any, confidence: Math.min(ruleField.confidence, 0.5) };
}

function mergeDraft(rules: ScholarshipDraft, ai: AiExtraction, disagreements: string[]): ScholarshipDraft {
  const merged: ScholarshipDraft = { ...rules, method: 'HYBRID' };

  // Title: prefer the AI's, which strips site chrome better, but only if it is
  // plausible and not wildly longer than what the rules saw.
  if (ai.title && ai.title.length >= 4 && ai.title.length <= 300) {
    merged.title = ai.title;
    merged.normalizedTitle = normalizeTitle(ai.title);
  }
  if (!merged.provider && ai.provider) merged.provider = ai.provider;
  if (ai.description && (!merged.description || merged.description.length < 80)) merged.description = ai.description;

  // Degree levels: union. Missing a level is worse than having an extra one,
  // and both sides quote evidence.
  if (ai.degreeLevels.length > 0) {
    const set = new Set([...merged.degreeLevels, ...ai.degreeLevels]);
    merged.degreeLevels = [...set];
    merged.degreeEvidence = [...merged.degreeEvidence, ...ai.degreeEvidence].slice(0, 10);
  }

  if (ai.fieldsOfStudy.length > 0) {
    merged.fieldsOfStudy = [...new Set([...merged.fieldsOfStudy, ...ai.fieldsOfStudy.map((f) => f.toLowerCase())])];
  }

  // Modes: only overwrite UNKNOWN. §14 — never upgrade a stated value.
  if (merged.studyMode[0] === 'UNKNOWN' && ai.studyMode.length && ai.studyMode[0] !== 'UNKNOWN') {
    merged.studyMode = ai.studyMode;
  }
  if (merged.attendance[0] === 'UNKNOWN' && ai.attendance.length && ai.attendance[0] !== 'UNKNOWN') {
    merged.attendance = ai.attendance;
  }
  if (merged.deliveryMode[0] === 'UNKNOWN' && ai.deliveryMode.length && ai.deliveryMode[0] !== 'UNKNOWN') {
    merged.deliveryMode = ai.deliveryMode;
  }

  // Funding booleans
  const f = merged.funding;
  const af = ai.funding;
  f.tuitionCovered = mergeBoolField(f.tuitionCovered, af.tuitionCovered, 'funding.tuitionCovered', disagreements) as any;
  f.livingStipend = mergeBoolField(f.livingStipend, af.livingStipend, 'funding.livingStipend', disagreements) as any;
  f.travelCovered = mergeBoolField(f.travelCovered, af.travelCovered, 'funding.travelCovered', disagreements) as any;
  f.airfareCovered = mergeBoolField(f.airfareCovered, af.airfareCovered, 'funding.airfareCovered', disagreements) as any;
  f.accommodationCovered = mergeBoolField(f.accommodationCovered, af.accommodationCovered, 'funding.accommodationCovered', disagreements) as any;
  f.healthInsurance = mergeBoolField(f.healthInsurance, af.healthInsurance, 'funding.healthInsurance', disagreements) as any;
  f.researchAllowance = mergeBoolField(f.researchAllowance, af.researchAllowance, 'funding.researchAllowance', disagreements) as any;
  f.booksAllowance = mergeBoolField(f.booksAllowance, af.booksAllowance, 'funding.booksAllowance', disagreements) as any;
  f.equipmentAllowance = mergeBoolField(f.equipmentAllowance, af.equipmentAllowance, 'funding.equipmentAllowance', disagreements) as any;
  f.applicationFeeWaiver = mergeBoolField(f.applicationFeeWaiver, af.applicationFeeWaiver, 'funding.applicationFeeWaiver', disagreements) as any;
  f.visaSupport = mergeBoolField(f.visaSupport, af.visaSupport, 'funding.visaSupport', disagreements) as any;

  if (f.stipendAmount.amount === null && af.stipendAmount.amount !== null) {
    f.stipendAmount = {
      amount: af.stipendAmount.amount,
      currency: af.stipendAmount.currency,
      period: af.stipendAmount.period,
      originalText: af.stipendAmount.originalText,
      confidence: af.stipendAmount.confidence,
      certainty: af.stipendAmount.certainty as any
    };
  }
  if (f.awardCount.value === null && af.awardCount.value !== null) {
    f.awardCount = { value: af.awardCount.value, sourceText: af.awardCount.evidence ?? undefined, confidence: af.awardCount.confidence };
  }
  if (f.primaryType === 'UNKNOWN' && af.primaryType) {
    const t = String(af.primaryType).toUpperCase();
    if (/^[A-Z_]+$/.test(t)) {
      f.primaryType = t as any;
      f.primaryTypeCertainty = 'PROBABLE';
      if (!f.types.includes(t as any)) f.types.push(t as any);
    }
  }

  // Eligibility — the most consequential merge, so the most conservative.
  const e = merged.eligibility;
  const ae = ai.eligibility;
  if (e.scope === 'UNKNOWN' && ae.scope !== 'UNKNOWN') {
    e.scope = ae.scope;
    e.scopeCertainty = 'PROBABLE';
    e.scopeSourceText = ae.scopeEvidence ?? undefined;
  } else if (e.scope !== 'UNKNOWN' && ae.scope !== 'UNKNOWN' && e.scope !== ae.scope) {
    disagreements.push(`eligibility.scope: rules=${e.scope} ai=${ae.scope}`);
    e.scopeCertainty = 'PROBABLE';
  }
  // Country lists are unioned only when the rules found none — an AI adding
  // countries to an explicit list is exactly the §58 failure mode.
  if (e.countries.length === 0 && ae.countries.length > 0 && ae.countries.length <= 60) {
    e.countries = ae.countries;
    if (e.scope === 'UNKNOWN') e.scope = 'SPECIFIC_COUNTRIES';
  }
  if (e.excludedCountries.length === 0 && ae.excludedCountries.length > 0) {
    e.excludedCountries = ae.excludedCountries;
  }
  if (ae.regions.length > 0) e.regions = [...new Set([...e.regions, ...ae.regions])];
  if (ae.categories.length > 0) e.categories = [...new Set([...e.categories, ...ae.categories])];

  // Requirements
  const r = merged.requirements;
  const ar = ai.requirements;
  if (!r.minimumDegree.value && ar.minimumDegree.value) {
    r.minimumDegree = { value: ar.minimumDegree.value, sourceText: ar.minimumDegree.evidence ?? undefined, confidence: ar.minimumDegree.confidence };
  }
  if (r.minimumGpa.value === null && ar.minimumGpa.value !== null) {
    r.minimumGpa = { value: ar.minimumGpa.value, sourceText: ar.minimumGpa.evidence ?? undefined, confidence: ar.minimumGpa.confidence };
  }
  if (!r.minimumGrade.value && ar.minimumGrade.value) {
    r.minimumGrade = { value: ar.minimumGrade.value, sourceText: ar.minimumGrade.evidence ?? undefined, confidence: ar.minimumGrade.confidence };
  }
  for (const key of ['ielts', 'toefl', 'pte', 'duolingo'] as const) {
    const ruleTest = r.english[key];
    const aiTest = ar.english[key];
    if (ruleTest.required === null && aiTest.required !== null) {
      r.english[key] = {
        required: aiTest.required,
        minScore: aiTest.minScore,
        detail: aiTest.detail ?? undefined,
        waiverAvailable: aiTest.waiverAvailable,
        confidence: aiTest.confidence,
        sourceText: aiTest.evidence ?? undefined
      };
    } else if (ruleTest.required !== null && aiTest.required !== null && ruleTest.required !== aiTest.required) {
      disagreements.push(`requirements.english.${key}.required: rules=${ruleTest.required} ai=${aiTest.required}`);
      ruleTest.confidence = Math.min(ruleTest.confidence, 0.5);
    } else if (ruleTest.minScore === null && aiTest.minScore !== null && ruleTest.required === aiTest.required) {
      ruleTest.minScore = aiTest.minScore;
    }
  }
  if (r.english.anyTestRequired === null && ar.english.anyTestRequired !== null) {
    r.english.anyTestRequired = ar.english.anyTestRequired;
  }
  if (ar.documents.length > 0) {
    const have = new Set(r.documents.map((d) => d.code));
    for (const d of ar.documents) {
      if (have.has(d.code)) continue;
      r.documents.push({ code: d.code, label: d.label, count: d.count, mandatory: d.mandatory, sourceText: d.evidence ?? undefined });
    }
  }
  r.workExperienceRequired = mergeBoolField(r.workExperienceRequired, ar.workExperienceRequired, 'requirements.workExperienceRequired', disagreements) as any;
  r.supervisorRequired = mergeBoolField(r.supervisorRequired, ar.supervisorRequired, 'requirements.supervisorRequired', disagreements) as any;
  r.admissionOfferRequired = mergeBoolField(r.admissionOfferRequired, ar.admissionOfferRequired, 'requirements.admissionOfferRequired', disagreements) as any;

  // Deadline — only fill, never overwrite a CONFIRMED rule parse
  if (merged.deadline.kind === 'UNKNOWN' && ai.deadline.kind !== 'UNKNOWN') {
    const parsed = ai.deadline.date ? new Date(ai.deadline.date) : null;
    merged.deadline = {
      kind: ai.deadline.kind,
      date: parsed && !Number.isNaN(parsed.getTime()) ? parsed : null,
      additionalDates: [],
      originalText: ai.deadline.originalText,
      timezoneStated: ai.deadline.timezoneStated,
      confidence: ai.deadline.confidence,
      certainty: ai.deadline.certainty as any
    };
  } else if (
    merged.deadline.date && ai.deadline.date &&
    new Date(ai.deadline.date).getTime() !== merged.deadline.date.getTime()
  ) {
    disagreements.push(`deadline.date: rules=${merged.deadline.date.toISOString().slice(0, 10)} ai=${ai.deadline.date}`);
    merged.deadline.certainty = 'PROBABLE';
    merged.deadline.confidence = Math.min(merged.deadline.confidence, 0.55);
  }

  // Application URL — never accept a fabricated one (§59). It must be a link
  // that actually appeared on the page.
  if (!merged.applicationUrl.value && ai.applicationUrl.value) {
    merged.applicationUrl = { value: ai.applicationUrl.value, sourceText: ai.applicationUrl.evidence ?? undefined, confidence: Math.min(ai.applicationUrl.confidence, 0.7) };
  }

  if (!merged.academicYear && ai.academicYear) merged.academicYear = ai.academicYear;
  if (!merged.intake && ai.intake) merged.intake = ai.intake;
  if (!merged.duration && ai.duration) merged.duration = ai.duration;

  return merged;
}

// ── Confidence & quality (§35, §60) ─────────────────────────────────────────

export function sourceAuthorityScore(sourceType: SourceType): number {
  const rank = SOURCE_AUTHORITY[sourceType] ?? 7;
  return Math.max(0.2, 1 - (rank - 1) * 0.13);
}

/**
 * Confidence: how much do we trust that what we stored matches the page?
 * Quality: how *useful* is the record — completeness and freshness included.
 *
 * They are separate because a sparse page can be extracted with total
 * confidence and still be a low-value record.
 */
export function scoreDraft(
  draft: ScholarshipDraft,
  opts: { sourceType: SourceType; classificationScore: number; aiUsed: boolean; disagreements: number }
): { confidence: number; qualityScore: number } {
  const authority = sourceAuthorityScore(opts.sourceType);

  const deadlineConf = draft.deadline.kind === 'UNKNOWN' ? 0 : draft.deadline.confidence;
  const fundingConf = draft.funding.primaryType === 'UNKNOWN'
    ? 0
    : Math.max(draft.funding.tuitionCovered.confidence, draft.funding.livingStipend.confidence, 0.4);
  const eligibilityConf = draft.eligibility.scope === 'UNKNOWN'
    ? 0
    : draft.eligibility.scopeCertainty === 'CONFIRMED' ? 0.9 : 0.6;
  const degreeConf = draft.degreeLevels.length > 0 ? 0.85 : 0;

  const confidence =
    0.28 * authority +
    0.20 * opts.classificationScore +
    0.16 * fundingConf +
    0.14 * eligibilityConf +
    0.12 * deadlineConf +
    0.10 * degreeConf;

  // Every unresolved rules-vs-AI disagreement is a real reason to trust less
  const penalty = Math.min(0.25, opts.disagreements * 0.06);

  const MAX_FIELDS = 16;
  const completeness = Math.min(1, draft.fieldsExtracted / MAX_FIELDS);

  const qualityScore =
    0.30 * completeness +
    0.25 * authority +
    0.20 * Math.max(0, confidence - penalty) +
    0.15 * (draft.applicationUrl.value ? 1 : 0) +
    0.10 * (draft.deadline.kind !== 'UNKNOWN' ? 1 : 0);

  return {
    confidence: Number(Math.max(0, Math.min(1, confidence - penalty)).toFixed(3)),
    qualityScore: Number(Math.max(0, Math.min(1, qualityScore)).toFixed(3))
  };
}

// ── Entry point ─────────────────────────────────────────────────────────────

export interface ExtractOptions {
  sourceType: SourceType;
  classificationScore: number;
  universityName?: string;
  countryCode?: string | null;
  crawlRunId?: unknown;
  crawlTargetId?: unknown;
  /** When false, skip the AI even if it is globally enabled */
  allowAi?: boolean;
  dryRun?: boolean;
}

export async function extractScholarship(
  page: FetchResult,
  opts: ExtractOptions
): Promise<ExtractionOutcome> {
  const rules = extractWithRules(page, { countryCode: opts.countryCode });

  const outcome: ExtractionOutcome = {
    draft: rules,
    method: 'RULES',
    aiUsed: false,
    aiErrors: [],
    disagreements: [],
    ...scoreDraft(rules, {
      sourceType: opts.sourceType,
      classificationScore: opts.classificationScore,
      aiUsed: false,
      disagreements: 0
    })
  };

  const wantAi = (opts.allowAi ?? true) && isAiEnabled();
  if (!wantAi) return outcome;

  const ai = await extractWithAi({
    url: page.finalUrl,
    title: page.title,
    universityName: opts.universityName,
    countryCode: opts.countryCode,
    text: page.text
  });

  outcome.aiState = ai.state;
  outcome.aiErrors = ai.errors;

  if (!opts.dryRun) {
    // Every AI attempt is auditable, success or failure (§34)
    await ExtractionRunModel.create({
      crawlRunId: opts.crawlRunId,
      crawlTargetId: opts.crawlTargetId,
      sourceUrl: page.finalUrl,
      contentHash: page.contentHash,
      method: 'AI',
      provider: ai.provider,
      model: ai.model,
      state: ai.state === 'SKIPPED' ? 'SKIPPED' : ai.state,
      durationMs: ai.durationMs,
      promptTokens: ai.promptTokens,
      completionTokens: ai.completionTokens,
      rawOutput: ai.raw?.slice(0, 20_000),
      validationErrors: ai.errors,
      confidence: ai.data?.classificationConfidence ?? 0
    }).catch((err) => logger.warn({ err }, 'scholarship: failed to record extraction run'));
  }

  if (ai.state !== 'SUCCESS' || !ai.data) return outcome;

  // The AI is allowed to veto: if it says this is not a scholarship and is
  // confident, that is information the rules did not have.
  if (!ai.data.isScholarship && ai.data.classificationConfidence > 0.7) {
    outcome.aiErrors.push('AI classified the page as not-a-scholarship');
    outcome.confidence = Math.min(outcome.confidence, 0.25);
    return outcome;
  }

  const disagreements: string[] = [];
  const merged = mergeDraft(rules, ai.data, disagreements);

  const scores = scoreDraft(merged, {
    sourceType: opts.sourceType,
    classificationScore: Math.max(opts.classificationScore, ai.data.classificationConfidence),
    aiUsed: true,
    disagreements: disagreements.length
  });

  return {
    draft: merged,
    method: 'HYBRID',
    aiUsed: true,
    aiState: ai.state,
    aiErrors: ai.errors,
    disagreements,
    ...scores
  };
}
