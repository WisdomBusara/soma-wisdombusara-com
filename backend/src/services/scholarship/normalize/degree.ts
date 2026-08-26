import type { DegreeLevel } from '../../../models/scholarship/types';

/**
 * Degree level normalization (§13).
 *
 * Ordered longest-first inside each level so "postgraduate taught" is tested
 * before "postgraduate", and word-boundary anchored so "ma" cannot fire on
 * "management" or "ba" on "bachelor's-adjacent" prose.
 *
 * The original matched wording is always returned alongside the normalized
 * value so provenance survives (§13: "Retain original text").
 */

interface Rule {
  level: DegreeLevel;
  patterns: RegExp[];
}

// Note on ambiguity: "postgraduate" alone covers both taught masters and
// research degrees in UK usage. It maps to MASTERS only, because a PhD page
// that says "postgraduate" essentially always also says "PhD"/"doctoral"
// somewhere — so we would pick up PHD from the stronger signal anyway, and
// mapping it to both would flood MASTERS filters with doctoral results.
const RULES: Rule[] = [
  {
    level: 'PHD',
    patterns: [
      /\bdoctor\s+of\s+philosophy\b/i,
      /\bph\.?\s?d\.?s?\b/i,
      /\bd\.?phil\.?\b/i,
      /\bdoctoral\b/i,
      /\bdoctorate\b/i,
      /\bpostgraduate\s+research\b/i,
      /\bresearch\s+degree\b/i,
      /\bedd\b/i,
      /\bdba\b/i
    ]
  },
  {
    level: 'MASTERS',
    patterns: [
      /\bpostgraduate\s+taught\b/i,
      /\bmaster'?s?\s+degree\b/i,
      /\bmasters?\b/i,
      /\bm\.?sc\.?\b/i,
      /\bm\.?a\.?\b/i,
      /\bm\.?eng\.?\b/i,
      /\bm\.?b\.?a\.?\b/i,
      /\bm\.?p\.?h\.?\b/i,
      /\bm\.?phil\.?\b/i,
      /\bm\.?res\.?\b/i,
      /\bl\.?l\.?m\.?\b/i,
      /\bm\.?arch\.?\b/i,
      /\bm\.?fa\.?\b/i,
      /\bpostgraduate\b/i,
      /\bgraduate\s+(?:study|studies|programme|program)\b/i,
      /\bpgt\b/i
    ]
  },
  {
    level: 'BACHELORS',
    patterns: [
      /\bbachelor'?s?\s+degree\b/i,
      /\bbachelors?\b/i,
      /\bundergraduate\b/i,
      /\bb\.?sc\.?\b/i,
      /\bb\.?a\.?\b/i,
      /\bb\.?eng\.?\b/i,
      /\bl\.?l\.?b\.?\b/i,
      /\bb\.?com\.?\b/i,
      /\bb\.?ed\.?\b/i,
      /\bfirst\s+degree\b/i
    ]
  },
  { level: 'POSTDOC', patterns: [/\bpost-?doctoral\b/i, /\bpost-?doc\b/i] },
  { level: 'RESEARCH_FELLOWSHIP', patterns: [/\bresearch\s+fellowship\b/i] },
  { level: 'DIPLOMA', patterns: [/\bdiploma\b/i, /\bhnd\b/i] },
  { level: 'CERTIFICATE', patterns: [/\bcertificate\b/i, /\bpgce\b/i] }
];

export interface DegreeMatch {
  levels: DegreeLevel[];
  /** Verbatim phrases that produced each level — provenance for §19. */
  evidence: string[];
  confidence: number;
  /**
   * Levels that appeared ONLY as entry requirements ("must hold a Bachelor
   * degree"). Reported separately rather than discarded, so an admin can see
   * why a level was considered and rejected.
   */
  prerequisiteLevels: DegreeLevel[];
}

/**
 * Normalize a single phrase to one level. Returns null when nothing matches —
 * never a default guess.
 */
export function normalizeDegree(input: string | null | undefined): DegreeLevel | null {
  if (!input) return null;
  const text = String(input);
  for (const rule of RULES) {
    for (const p of rule.patterns) {
      if (p.test(text)) return rule.level;
    }
  }
  return null;
}

/**
 * Sentences that describe what an applicant must ALREADY hold, rather than
 * what the award funds.
 *
 * This distinction is load-bearing. "The Masters Scholarship … applicants must
 * hold a Bachelor degree" describes a Master's award with a Bachelor's
 * prerequisite. Reading BACHELORS as the award level would put a postgraduate
 * scholarship in undergraduate search results — the exact kind of error that
 * makes a listing untrustworthy.
 *
 * The prerequisite degree is not lost: extractRequirements() captures it as
 * `minimumDegree`, which is where it belongs.
 */
const PREREQUISITE_CONTEXT =
  /\b(must\s+(?:hold|have|possess|already\s+have)|hold(?:ing)?\s+an?\b|have\s+(?:completed|obtained|been\s+awarded)|completed\s+an?\b|awarded\s+an?\b|in\s+possession\s+of|entry\s+requirements?|minimum\s+(?:degree|qualification)|equivalent\s+(?:to|of)\s+an?\b|applicants?\s+(?:must|should|require|need)|require[sd]?\s+an?\b|graduated\s+with|obtained\s+an?\b|prior\s+(?:degree|qualification)|first\s+degree\s+in)\b/i;

/** Sentences that describe what the award itself is for. */
const AWARD_CONTEXT =
  /\b(scholarships?|studentships?|bursar(?:y|ies)|fellowships?|award|funding|open\s+to|available\s+to|supports?|for\s+students?|programmes?\s+covered|eligible\s+(?:programmes?|courses?)|study\s+towards?|to\s+study|enrol(?:ling|led)?\s+(?:on|in))\b/i;

function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?;:])\s+|\n+|(?:\s[•·▪‣–—]\s)/)
    .map((s) => s.trim())
    .filter((s) => s.length > 2);
}

/**
 * Find every degree level the AWARD applies to.
 *
 * A scholarship page routinely covers more than one level ("open to Master's
 * and PhD applicants"), so this returns a set rather than a single value —
 * but it excludes levels that only ever appear as entry requirements.
 */
export function extractDegreeLevels(text: string | null | undefined): DegreeMatch {
  if (!text) return { levels: [], evidence: [], confidence: 0, prerequisiteLevels: [] };
  const haystack = String(text);
  const sentences = splitSentences(haystack);

  // Per level: did it appear in award context, prerequisite context, or both?
  const inAward = new Map<DegreeLevel, string>();
  const inPrereq = new Map<DegreeLevel, string>();

  for (const sentence of sentences) {
    const isPrereq = PREREQUISITE_CONTEXT.test(sentence);
    const isAward = AWARD_CONTEXT.test(sentence);

    for (const rule of RULES) {
      const hit = rule.patterns.some((p) => p.test(sentence));
      if (!hit) continue;
      const snippet = sentence.replace(/\s+/g, ' ').trim().slice(0, 240);

      // A sentence carrying both framings ("Masters scholarship for applicants
      // who must hold a Bachelor degree") is ambiguous at sentence level. Fall
      // back to phrase proximity: whichever framing sits closer to the match.
      if (isPrereq && !isAward) {
        if (!inPrereq.has(rule.level)) inPrereq.set(rule.level, snippet);
      } else if (isPrereq && isAward) {
        const matchIdx = sentence.search(rule.patterns.find((p) => p.test(sentence))!);
        const prereqIdx = sentence.search(PREREQUISITE_CONTEXT);
        const awardIdx = sentence.search(AWARD_CONTEXT);
        const nearerPrereq = Math.abs(matchIdx - prereqIdx) < Math.abs(matchIdx - awardIdx);
        if (nearerPrereq) {
          if (!inPrereq.has(rule.level)) inPrereq.set(rule.level, snippet);
        } else if (!inAward.has(rule.level)) {
          inAward.set(rule.level, snippet);
        }
      } else if (!inAward.has(rule.level)) {
        inAward.set(rule.level, snippet);
      }
    }
  }

  const levels = [...inAward.keys()];
  const prerequisiteLevels = [...inPrereq.keys()].filter((l) => !levels.includes(l));

  let confidence = 0;
  if (levels.length > 0) {
    const explicit = /\b(bachelor|master|doctoral|doctorate|ph\.?d|undergraduate|postgraduate)\w*\b/i.test(haystack);
    confidence = explicit ? 0.9 : 0.6;
  }

  return {
    levels,
    evidence: levels.map((l) => inAward.get(l) ?? ''),
    confidence,
    prerequisiteLevels
  };
}

/** Human label for the UI. */
export function degreeLabel(level: DegreeLevel): string {
  const map: Record<DegreeLevel, string> = {
    BACHELORS: "Bachelor's",
    MASTERS: "Master's",
    PHD: 'PhD',
    POSTDOC: 'Postdoctoral',
    DIPLOMA: 'Diploma',
    CERTIFICATE: 'Certificate',
    RESEARCH_FELLOWSHIP: 'Research Fellowship'
  };
  return map[level] ?? level;
}
