import type { EligibilityScope, Certainty } from '../../../models/scholarship/types';
import { extractCountries, extractRegions, toCountryCode, countryInRegion } from './country';

/**
 * Eligibility extraction (§17, §58).
 *
 * The load-bearing rule: "open to international students" is NOT "open to all
 * countries". It says the applicant must not be domestic. It says nothing
 * about whether Kenyans specifically qualify — the same page often goes on to
 * restrict awards to a named list.
 *
 * So scope and countries are extracted independently:
 *   scope=INTERNATIONAL, countries=[]        → nationality match = PROBABLE
 *   scope=SPECIFIC_COUNTRIES, countries=[KE] → nationality match = CONFIRMED
 *
 * A UI must be able to tell those two apart, so the pipeline never collapses
 * them.
 */

export interface EligibilityExtraction {
  scope: EligibilityScope;
  scopeCertainty: Certainty;
  scopeSourceText?: string;
  countries: string[];
  excludedCountries: string[];
  regions: string[];
  categories: string[];
  womenOnly: { value: boolean | null; sourceText?: string; confidence: number };
  refugeesEligible: { value: boolean | null; sourceText?: string; confidence: number };
  developingCountriesOnly: { value: boolean | null; sourceText?: string; confidence: number };
  ageMin: { value: number | null; sourceText?: string; confidence: number };
  ageMax: { value: number | null; sourceText?: string; confidence: number };
  residencyRequirement: { value: string | null; sourceText?: string; confidence: number };
  citizenshipRequirement: { value: string | null; sourceText?: string; confidence: number };
  rawEligibilityText: string[];
}

const INTERNATIONAL_RE = /\b(international\s+(?:students?|applicants?|candidates?)|overseas\s+(?:students?|applicants?)|non[-\s]?(?:UK|EU|US|domestic|home)\s+(?:students?|applicants?|nationals?)|students?\s+from\s+(?:outside|any\s+country)|foreign\s+(?:students?|nationals?))\b/i;

const DOMESTIC_RE = /\b(home\s+(?:students?|fee\s+status|applicants?)|domestic\s+(?:students?|applicants?)|(?:UK|US|Irish|Australian|Canadian)\s+(?:students?|nationals?|citizens?|residents?)\s+only|resident\s+students?\s+only|in[-\s]state)\b/i;

const BOTH_RE = /\b(home\s+and\s+(?:international|overseas)|(?:international|overseas)\s+and\s+home|(?:UK|EU)\s+and\s+international|all\s+(?:students?|applicants?|nationalities)|regardless\s+of\s+nationality|any\s+nationality|open\s+to\s+all)\b/i;

const CITIZEN_LIST_RE = /\b(?:open\s+to|available\s+to|restricted\s+to|eligible\s+(?:applicants?\s+)?(?:are|must\s+be)|applicants?\s+must\s+be|citizens?\s+of|nationals?\s+of|residents?\s+of|from)\b/i;

const EXCLUSION_RE = /\b(?:not\s+(?:open|available|eligible)\s+(?:to|for)|excluding|except\s+(?:for)?|are\s+not\s+eligible|ineligible)\b/i;

const WOMEN_RE = /\b(women\s+only|female\s+(?:applicants?|students?|candidates?)\s+only|open\s+(?:only\s+)?to\s+women|for\s+women\s+in\b)/i;
const REFUGEE_RE = /\b(refugees?|asylum\s+seekers?|displaced\s+(?:persons?|students?)|sanctuary\s+scholarship)\b/i;
const DEVELOPING_RE = /\b(developing\s+countr(?:y|ies)|low[-\s]income\s+countr(?:y|ies)|least\s+developed\s+countr(?:y|ies)|ODA[-\s]?eligible|DAC\s+list)\b/i;

const CATEGORY_PATTERNS: { code: string; re: RegExp }[] = [
  { code: 'women', re: WOMEN_RE },
  { code: 'women_in_stem', re: /\bwomen\s+in\s+(?:STEM|science|engineering|technology|computing)\b/i },
  { code: 'refugees', re: REFUGEE_RE },
  { code: 'disability', re: /\b((?:students?|applicants?|candidates?)\s+with\s+(?:a\s+)?disabilit(?:y|ies)|disabled\s+(?:students?|applicants?|candidates?))\b/i },
  { code: 'first_generation', re: /\bfirst[-\s]generation\s+(?:students?|university|college)\b/i },
  { code: 'care_leavers', re: /\bcare\s+leavers?\b/i },
  { code: 'indigenous', re: /\b(indigenous|first\s+nations|aboriginal)\s+(?:students?|applicants?|peoples?)\b/i },
  { code: 'low_income', re: /\b(low[-\s]income\s+(?:background|famil|household)|financially\s+disadvantaged|underprivileged)\b/i },
  { code: 'commonwealth', re: /\bcommonwealth\s+(?:citizens?|countr(?:y|ies)|scholar)\b/i }
];

function sentences(text: string): string[] {
  return String(text || '')
    .split(/(?<=[.!?;:])\s+|\n+|(?:\s[•·▪‣–—]\s)/)
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter((s) => s.length > 3 && s.length < 700);
}

function flag(text: string, re: RegExp) {
  for (const s of sentences(text)) {
    if (re.test(s)) return { value: true, sourceText: s, confidence: 0.85 };
  }
  return { value: null, confidence: 0 };
}

export function extractEligibility(text: string | null | undefined): EligibilityExtraction {
  const haystack = String(text || '');
  const sents = sentences(haystack);

  // ── Explicit country lists ────────────────────────────────────────────────
  // Only sentences that frame a list ("open to citizens of X, Y and Z") are
  // mined for countries. Scanning the whole page would pick up the university's
  // own country, campus locations, partner institutions and alumni anecdotes.
  const listSentences = sents.filter((s) => CITIZEN_LIST_RE.test(s) && !EXCLUSION_RE.test(s));
  const exclusionSentences = sents.filter((s) => EXCLUSION_RE.test(s));

  const countries: string[] = [];
  for (const s of listSentences) {
    for (const c of extractCountries(s)) if (!countries.includes(c)) countries.push(c);
  }

  const excludedCountries: string[] = [];
  for (const s of exclusionSentences) {
    for (const c of extractCountries(s)) if (!excludedCountries.includes(c)) excludedCountries.push(c);
  }
  // A country cannot be both listed and excluded — exclusion wins (safer)
  const finalCountries = countries.filter((c) => !excludedCountries.includes(c));

  const regions: string[] = [];
  for (const s of [...listSentences, ...sents.filter((s) => /\beligib|\bopen\s+to\b/i.test(s))]) {
    for (const r of extractRegions(s)) if (!regions.includes(r)) regions.push(r);
  }

  // ── Scope ─────────────────────────────────────────────────────────────────
  let scope: EligibilityScope = 'UNKNOWN';
  let scopeCertainty: Certainty = 'UNKNOWN';
  let scopeSourceText: string | undefined;

  const bothSentence = sents.find((s) => BOTH_RE.test(s));
  const intlSentence = sents.find((s) => INTERNATIONAL_RE.test(s));
  const domSentence = sents.find((s) => DOMESTIC_RE.test(s));

  if (finalCountries.length > 0) {
    scope = 'SPECIFIC_COUNTRIES';
    scopeCertainty = 'CONFIRMED';
    scopeSourceText = listSentences[0];
  } else if (regions.length > 0 && listSentences.length > 0) {
    scope = 'SPECIFIC_REGIONS';
    scopeCertainty = 'CONFIRMED';
    scopeSourceText = listSentences[0];
  } else if (bothSentence) {
    scope = 'BOTH';
    scopeCertainty = 'CONFIRMED';
    scopeSourceText = bothSentence;
  } else if (intlSentence && domSentence) {
    scope = 'BOTH';
    scopeCertainty = 'PROBABLE';
    scopeSourceText = intlSentence;
  } else if (intlSentence) {
    scope = 'INTERNATIONAL';
    scopeCertainty = 'CONFIRMED';
    scopeSourceText = intlSentence;
  } else if (domSentence) {
    scope = 'DOMESTIC';
    scopeCertainty = 'CONFIRMED';
    scopeSourceText = domSentence;
  }

  // ── Categories & flags ────────────────────────────────────────────────────
  const categories: string[] = [];
  for (const { code, re } of CATEGORY_PATTERNS) {
    if (re.test(haystack) && !categories.includes(code)) categories.push(code);
  }

  const womenOnly = flag(haystack, WOMEN_RE);
  const refugeesEligible = flag(haystack, REFUGEE_RE);
  const developingCountriesOnly = flag(haystack, DEVELOPING_RE);

  // ── Age ───────────────────────────────────────────────────────────────────
  let ageMin: EligibilityExtraction['ageMin'] = { value: null, confidence: 0 };
  let ageMax: EligibilityExtraction['ageMax'] = { value: null, confidence: 0 };
  for (const s of sents) {
    if (!/\bage[ds]?\b|\byears?\s+old\b/i.test(s)) continue;
    const under = /\b(?:under|below|younger\s+than|no\s+older\s+than|maximum\s+age\s+(?:of\s+)?)\s*(\d{2})\b/i.exec(s);
    if (under && !ageMax.value) ageMax = { value: Number(under[1]), sourceText: s, confidence: 0.8 };
    const over = /\b(?:over|above|at\s+least|minimum\s+age\s+(?:of\s+)?|older\s+than)\s*(\d{2})\b/i.exec(s);
    if (over && !ageMin.value) ageMin = { value: Number(over[1]), sourceText: s, confidence: 0.8 };
    const between = /\b(?:aged?\s+)?(\d{2})\s*(?:-|to|and)\s*(\d{2})\s*(?:years)?\b/i.exec(s);
    if (between && !ageMin.value && !ageMax.value) {
      ageMin = { value: Number(between[1]), sourceText: s, confidence: 0.7 };
      ageMax = { value: Number(between[2]), sourceText: s, confidence: 0.7 };
    }
  }

  // ── Residency / citizenship, kept verbatim ────────────────────────────────
  const residencySentence = sents.find((s) => /\b(residen(?:t|cy)\s+(?:in|of|requirement)|ordinarily\s+resident|permanent\s+residen)/i.test(s));
  const citizenshipSentence = sents.find((s) => /\b(citizens?hip|nationals?\s+of|passport\s+holders?|must\s+hold\s+(?:a\s+)?(?:\w+\s+)?citizenship)\b/i.test(s));

  const rawEligibilityText = sents
    .filter((s) => /\b(eligib|open\s+to|applicants?\s+must|who\s+can\s+apply|available\s+to|restricted\s+to|nationalit)/i.test(s))
    .slice(0, 15);

  return {
    scope,
    scopeCertainty,
    scopeSourceText,
    countries: finalCountries,
    excludedCountries,
    regions,
    categories,
    womenOnly,
    refugeesEligible,
    developingCountriesOnly,
    ageMin,
    ageMax,
    residencyRequirement: residencySentence
      ? { value: residencySentence.slice(0, 400), sourceText: residencySentence, confidence: 0.7 }
      : { value: null, confidence: 0 },
    citizenshipRequirement: citizenshipSentence
      ? { value: citizenshipSentence.slice(0, 400), sourceText: citizenshipSentence, confidence: 0.7 }
      : { value: null, confidence: 0 },
    rawEligibilityText
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Nationality matching (§31) — deterministic, explainable, never silently
// upgrades PROBABLE to CONFIRMED.
// ─────────────────────────────────────────────────────────────────────────────

export type NationalityVerdict = 'ELIGIBLE' | 'PROBABLY_ELIGIBLE' | 'NOT_ELIGIBLE' | 'UNKNOWN';

export interface NationalityCheck {
  verdict: NationalityVerdict;
  reason: string;
}

/**
 * Can an applicant of `nationality` apply?
 *
 * `homeCountryCode` is the scholarship's own country, needed to reason about
 * INTERNATIONAL (which means "not from here").
 */
export function checkNationality(
  eligibility: Pick<EligibilityExtraction, 'scope' | 'countries' | 'excludedCountries' | 'regions'>,
  nationality: string,
  homeCountryCode?: string | null
): NationalityCheck {
  const code = toCountryCode(nationality) ?? String(nationality || '').toUpperCase();
  if (!code) return { verdict: 'UNKNOWN', reason: 'No nationality supplied' };

  if (eligibility.excludedCountries?.includes(code)) {
    return { verdict: 'NOT_ELIGIBLE', reason: `${code} is explicitly excluded` };
  }

  switch (eligibility.scope) {
    case 'SPECIFIC_COUNTRIES':
      return eligibility.countries.includes(code)
        ? { verdict: 'ELIGIBLE', reason: `${code} is on the eligible country list` }
        : { verdict: 'NOT_ELIGIBLE', reason: `${code} is not on the eligible country list` };

    case 'SPECIFIC_REGIONS': {
      const hit = eligibility.regions.find((r) => countryInRegion(code, r));
      return hit
        ? { verdict: 'ELIGIBLE', reason: `${code} falls within the eligible region ${hit}` }
        : { verdict: 'NOT_ELIGIBLE', reason: `${code} is outside the eligible regions` };
    }

    case 'INTERNATIONAL':
      if (homeCountryCode && code === String(homeCountryCode).toUpperCase()) {
        return { verdict: 'NOT_ELIGIBLE', reason: 'Award is for international applicants; this is the home country' };
      }
      // Deliberately PROBABLY_ELIGIBLE, never ELIGIBLE — see §58.
      return {
        verdict: 'PROBABLY_ELIGIBLE',
        reason: 'Open to international applicants; no explicit country list was published'
      };

    case 'DOMESTIC':
      if (homeCountryCode && code === String(homeCountryCode).toUpperCase()) {
        return { verdict: 'ELIGIBLE', reason: 'Award is for domestic applicants' };
      }
      return { verdict: 'NOT_ELIGIBLE', reason: 'Award is restricted to domestic applicants' };

    case 'BOTH':
      return { verdict: 'ELIGIBLE', reason: 'Open to both home and international applicants' };

    default:
      return { verdict: 'UNKNOWN', reason: 'Eligibility scope was not stated on the source page' };
  }
}
