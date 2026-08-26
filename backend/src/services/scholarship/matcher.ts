import { checkNationality, type NationalityVerdict } from './normalize/eligibility';
import type { DegreeLevel, AttendanceMode, StudyMode } from '../../models/scholarship/types';
import { toCountryCode } from './normalize/country';

/**
 * Matching engine (§31).
 *
 * Deterministic and explainable by construction. Hard eligibility is evaluated
 * as *rules*, not as a learned score — an applicant told "92% match" deserves
 * to see which five facts produced it, and a model must never be able to
 * quietly override "this award excludes your nationality".
 *
 * The three-way outcome matters:
 *   PASS  — the source supports it
 *   WARN  — the source is silent, so we cannot confirm (§56)
 *   FAIL  — the source rules the applicant out
 *
 * A single FAIL on a hard criterion caps the score, regardless of how many
 * other criteria pass. WARNs reduce it but never disqualify.
 */

export interface ApplicantProfile {
  nationality?: string;
  currentCountry?: string;
  degreeLevel?: DegreeLevel;
  fieldOfStudy?: string;
  gpa?: number;
  gpaScale?: number;
  englishTest?: { type: 'IELTS' | 'TOEFL' | 'PTE' | 'DUOLINGO'; score: number };
  workExperienceYears?: number;
  preferredCountries?: string[];
  studyMode?: StudyMode;
  attendance?: AttendanceMode;
  fullyFundedOnly?: boolean;
}

export type CriterionOutcome = 'PASS' | 'WARN' | 'FAIL';

export interface MatchCriterion {
  key: string;
  label: string;
  outcome: CriterionOutcome;
  detail: string;
  /** Hard criteria can disqualify; soft ones only shade the score. */
  hard: boolean;
  weight: number;
}

export interface MatchResult {
  score: number;
  percentage: number;
  eligible: boolean;
  /** True when a hard criterion could not be confirmed either way */
  uncertain: boolean;
  criteria: MatchCriterion[];
  passed: MatchCriterion[];
  warnings: MatchCriterion[];
  failures: MatchCriterion[];
}

const outcomeValue = (o: CriterionOutcome): number => (o === 'PASS' ? 1 : o === 'WARN' ? 0.45 : 0);

/**
 * Score a scholarship against an applicant.
 *
 * `scholarship` is intentionally typed loosely — it accepts either a lean Mongo
 * document or an API-shaped object, so the same function backs both the
 * server-side matcher and any future client preview.
 */
export function matchScholarship(scholarship: any, profile: ApplicantProfile): MatchResult {
  const criteria: MatchCriterion[] = [];
  const add = (c: MatchCriterion) => criteria.push(c);

  // ── Nationality (hard) ────────────────────────────────────────────────────
  if (profile.nationality) {
    const verdict = checkNationality(
      {
        scope: scholarship.eligibility?.scope ?? 'UNKNOWN',
        countries: scholarship.eligibility?.countries ?? [],
        excludedCountries: scholarship.eligibility?.excludedCountries ?? [],
        regions: scholarship.eligibility?.regions ?? []
      },
      profile.nationality,
      scholarship.countryCode
    );
    const map: Record<NationalityVerdict, CriterionOutcome> = {
      ELIGIBLE: 'PASS', PROBABLY_ELIGIBLE: 'WARN', NOT_ELIGIBLE: 'FAIL', UNKNOWN: 'WARN'
    };
    add({
      key: 'nationality',
      label: `${profile.nationality} applicants`,
      outcome: map[verdict.verdict],
      detail: verdict.reason,
      hard: true,
      weight: 3
    });
  }

  // ── Degree level (hard) ───────────────────────────────────────────────────
  if (profile.degreeLevel) {
    const levels: DegreeLevel[] = scholarship.degreeLevels ?? [];
    add({
      key: 'degree',
      label: profile.degreeLevel,
      outcome: levels.length === 0 ? 'WARN' : levels.includes(profile.degreeLevel) ? 'PASS' : 'FAIL',
      detail: levels.length === 0
        ? 'Degree level is not stated on the source page'
        : levels.includes(profile.degreeLevel)
          ? `Award covers ${levels.join(', ')}`
          : `Award covers ${levels.join(', ')} only`,
      hard: true,
      weight: 3
    });
  }

  // ── Field of study (soft) ─────────────────────────────────────────────────
  if (profile.fieldOfStudy) {
    const fields: string[] = (scholarship.fieldsOfStudy ?? []).map((f: string) => f.toLowerCase());
    const want = profile.fieldOfStudy.toLowerCase();
    const hit = fields.some((f) => f.includes(want) || want.includes(f));
    add({
      key: 'field',
      label: profile.fieldOfStudy,
      outcome: fields.length === 0 ? 'WARN' : hit ? 'PASS' : 'FAIL',
      detail: fields.length === 0
        ? 'No field restriction was published — may be open to all disciplines'
        : hit ? `Listed fields include ${profile.fieldOfStudy}` : `Restricted to: ${fields.join(', ')}`,
      hard: false,
      weight: 2
    });
  }

  // ── Funding preference (soft) ─────────────────────────────────────────────
  if (profile.fullyFundedOnly) {
    const type = scholarship.funding?.primaryType ?? 'UNKNOWN';
    add({
      key: 'funding',
      label: 'Fully funded',
      outcome: type === 'FULLY_FUNDED' ? 'PASS' : type === 'UNKNOWN' ? 'WARN' : 'FAIL',
      detail: type === 'UNKNOWN' ? 'Funding level not confirmed on the source page' : `Funding: ${type.replace(/_/g, ' ').toLowerCase()}`,
      hard: false,
      weight: 2
    });
  }

  // ── Attendance / study mode (soft) ────────────────────────────────────────
  if (profile.attendance) {
    const modes: AttendanceMode[] = scholarship.attendance ?? [];
    const unknown = modes.length === 0 || modes[0] === 'UNKNOWN';
    const ok = modes.includes(profile.attendance) || modes.includes('BOTH');
    add({
      key: 'attendance',
      label: profile.attendance === 'FULL_TIME' ? 'Full-time' : 'Part-time',
      outcome: unknown ? 'WARN' : ok ? 'PASS' : 'FAIL',
      detail: unknown ? 'Attendance mode not stated on the source page' : `Award supports ${modes.join(', ')}`,
      hard: false,
      weight: 1
    });
  }
  if (profile.studyMode) {
    const modes: StudyMode[] = scholarship.studyMode ?? [];
    const unknown = modes.length === 0 || modes[0] === 'UNKNOWN';
    add({
      key: 'studyMode',
      label: profile.studyMode.replace(/_/g, ' ').toLowerCase(),
      outcome: unknown ? 'WARN' : modes.includes(profile.studyMode) ? 'PASS' : 'FAIL',
      detail: unknown ? 'Study mode not stated on the source page' : `Award supports ${modes.join(', ')}`,
      hard: false,
      weight: 1
    });
  }

  // ── English test (soft, but the classic WARN case) ────────────────────────
  if (profile.englishTest) {
    const key = profile.englishTest.type.toLowerCase() as 'ielts' | 'toefl' | 'pte' | 'duolingo';
    const req = scholarship.requirements?.english?.[key];
    if (!req || req.required === null || req.required === undefined) {
      add({
        key: 'english',
        label: `${profile.englishTest.type} requirement`,
        outcome: 'WARN',
        // §56 in the user-facing surface: not confirmed ≠ not required
        detail: `${profile.englishTest.type} requirement not confirmed on the source page`,
        hard: false,
        weight: 1
      });
    } else if (req.required === false) {
      add({ key: 'english', label: 'English test', outcome: 'PASS', detail: 'No English test required', hard: false, weight: 1 });
    } else if (req.minScore === null || req.minScore === undefined) {
      add({
        key: 'english',
        label: `${profile.englishTest.type} required`,
        outcome: 'WARN',
        detail: 'Test is required but no minimum score was published',
        hard: false,
        weight: 1
      });
    } else {
      const ok = profile.englishTest.score >= req.minScore;
      add({
        key: 'english',
        label: `${profile.englishTest.type} ${profile.englishTest.score}`,
        outcome: ok ? 'PASS' : 'FAIL',
        detail: `Requires ${profile.englishTest.type} ${req.minScore}${req.detail ? ` — ${req.detail}` : ''}`,
        hard: false,
        weight: 2
      });
    }
  }

  // ── GPA (soft) ────────────────────────────────────────────────────────────
  if (profile.gpa !== undefined && scholarship.requirements?.minimumGpa?.value != null) {
    const min = scholarship.requirements.minimumGpa.value;
    const scale = scholarship.requirements.gpaScale?.value ?? 4;
    const applicantScale = profile.gpaScale ?? 4;
    // Only compare on a shared scale — cross-scale conversion is a guess
    if (Math.abs(scale - applicantScale) < 0.01) {
      add({
        key: 'gpa',
        label: `GPA ${profile.gpa}`,
        outcome: profile.gpa >= min ? 'PASS' : 'FAIL',
        detail: `Minimum GPA ${min} on a ${scale}-point scale`,
        hard: false,
        weight: 2
      });
    } else {
      add({
        key: 'gpa',
        label: 'GPA',
        outcome: 'WARN',
        detail: `Award states GPA ${min}/${scale}; your GPA is on a ${applicantScale}-point scale and cannot be compared directly`,
        hard: false,
        weight: 1
      });
    }
  }

  // ── Work experience (soft) ────────────────────────────────────────────────
  const weYears = scholarship.requirements?.workExperienceYears?.value;
  if (profile.workExperienceYears !== undefined && weYears != null) {
    add({
      key: 'experience',
      label: `${profile.workExperienceYears} years experience`,
      outcome: profile.workExperienceYears >= weYears ? 'PASS' : 'FAIL',
      detail: `Requires at least ${weYears} years of work experience`,
      hard: false,
      weight: 1
    });
  }

  // ── Destination preference (soft) ─────────────────────────────────────────
  if (profile.preferredCountries?.length && scholarship.countryCode) {
    const wanted = profile.preferredCountries.map((c) => toCountryCode(c) ?? c.toUpperCase());
    add({
      key: 'destination',
      label: 'Preferred destination',
      outcome: wanted.includes(scholarship.countryCode) ? 'PASS' : 'FAIL',
      detail: wanted.includes(scholarship.countryCode)
        ? `${scholarship.country} is on your preferred list`
        : `Located in ${scholarship.country}`,
      hard: false,
      weight: 1
    });
  }

  // ── Aggregate ─────────────────────────────────────────────────────────────
  const failures = criteria.filter((c) => c.outcome === 'FAIL');
  const warnings = criteria.filter((c) => c.outcome === 'WARN');
  const passed = criteria.filter((c) => c.outcome === 'PASS');

  const hardFailure = failures.some((c) => c.hard);
  const totalWeight = criteria.reduce((s, c) => s + c.weight, 0) || 1;
  const earned = criteria.reduce((s, c) => s + c.weight * outcomeValue(c.outcome), 0);

  let score = earned / totalWeight;
  // A hard failure is not a low score, it is a no. Cap it hard so it can never
  // rank above a genuine match.
  if (hardFailure) score = Math.min(score, 0.2);

  // Extraction confidence shades the result — a 0.4-confidence record should
  // not present as a 95% match.
  const confidence = typeof scholarship.confidence === 'number' ? scholarship.confidence : 0.7;
  score *= 0.7 + 0.3 * confidence;

  return {
    score: Number(score.toFixed(3)),
    percentage: Math.round(score * 100),
    eligible: !hardFailure,
    uncertain: warnings.some((c) => c.hard),
    criteria,
    passed,
    warnings,
    failures
  };
}

/** Rank a list of scholarships for one applicant, best first. */
export function rankScholarships(
  scholarships: any[],
  profile: ApplicantProfile,
  opts: { minScore?: number; includeIneligible?: boolean } = {}
): { scholarship: any; match: MatchResult }[] {
  const minScore = opts.minScore ?? 0;
  return scholarships
    .map((s) => ({ scholarship: s, match: matchScholarship(s, profile) }))
    .filter((r) => (opts.includeIneligible ? true : r.match.eligible))
    .filter((r) => r.match.score >= minScore)
    .sort((a, b) => b.match.score - a.match.score);
}
