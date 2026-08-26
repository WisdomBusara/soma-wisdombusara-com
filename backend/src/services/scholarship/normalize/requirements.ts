import type { DegreeLevel } from '../../../models/scholarship/types';
import { normalizeDegree } from './degree';

/**
 * Requirements extraction (§18).
 *
 * Everything here obeys the unknown-vs-false rule. `ielts.required` is:
 *   null  — the page never mentioned IELTS          → UI shows "not confirmed"
 *   true  — the page requires it
 *   false — the page explicitly waives/excludes it
 *
 * There is no fourth state where we quietly assume the usual thing.
 */

export interface EnglishTest {
  required: boolean | null;
  minScore: number | null;
  detail?: string;
  waiverAvailable: boolean | null;
  confidence: number;
  sourceText?: string;
}

export interface RequiredDocument {
  code: string;
  label: string;
  count: number | null;
  mandatory: boolean | null;
  sourceText?: string;
}

export interface RequirementExtraction {
  minimumDegree: { value: DegreeLevel | null; sourceText?: string; confidence: number };
  minimumGpa: { value: number | null; sourceText?: string; confidence: number };
  gpaScale: { value: number | null; confidence: number };
  minimumGrade: { value: string | null; sourceText?: string; confidence: number };
  requiredFields: string[];
  english: {
    ielts: EnglishTest;
    toefl: EnglishTest;
    pte: EnglishTest;
    cambridge: EnglishTest;
    duolingo: EnglishTest;
    anyTestRequired: boolean | null;
    rawText: string[];
  };
  documents: RequiredDocument[];
  workExperienceRequired: { value: boolean | null; sourceText?: string; confidence: number };
  workExperienceYears: { value: number | null; sourceText?: string; confidence: number };
  professionalRegistration: { value: string | null; sourceText?: string; confidence: number };
  supervisorRequired: { value: boolean | null; sourceText?: string; confidence: number };
  admissionOfferRequired: { value: boolean | null; sourceText?: string; confidence: number };
  rawRequirementText: string[];
}

function sentences(text: string): string[] {
  return String(text || '')
    .split(/(?<=[.!?;:])\s+|\n+|(?:\s[•·▪‣–—]\s)/)
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter((s) => s.length > 2 && s.length < 700);
}

const noTest = (): EnglishTest => ({
  required: null, minScore: null, waiverAvailable: null, confidence: 0
});

interface TestSpec {
  key: keyof RequirementExtraction['english'];
  name: RegExp;
  scoreRe: RegExp;
  range: [number, number];
}

const TESTS: TestSpec[] = [
  { key: 'ielts', name: /\bIELTS\b/i, scoreRe: /\b(\d(?:\.\d)?)\b/, range: [0, 9] },
  { key: 'toefl', name: /\bTOEFL\b/i, scoreRe: /\b(\d{2,3})\b/, range: [0, 120] },
  { key: 'pte', name: /\bPTE\b/i, scoreRe: /\b(\d{2,3})\b/, range: [10, 90] },
  { key: 'cambridge', name: /\b(?:Cambridge\s+(?:English|Advanced|Proficiency)|CAE|CPE|C1\s+Advanced|C2\s+Proficiency)\b/i, scoreRe: /\b(\d{2,3})\b/, range: [80, 230] },
  { key: 'duolingo', name: /\bDuolingo\b/i, scoreRe: /\b(\d{2,3})\b/, range: [10, 160] }
];

const WAIVER_RE = /\b(waive[dr]?|exempt(?:ion|ed)?|not\s+required|no\s+(?:English\s+)?(?:language\s+)?test|may\s+be\s+waived)\b/i;
const NEGATION_RE = /\b(not?\s+required|no\s+(?:IELTS|TOEFL|English\s+test)|without\s+(?:an?\s+)?(?:IELTS|TOEFL|English\s+test))\b/i;

function extractEnglishTest(sents: string[], spec: TestSpec): EnglishTest {
  const hits = sents.filter((s) => spec.name.test(s));
  if (hits.length === 0) return noTest();

  // Prefer the sentence that carries a number
  const withScore = hits.find((s) => {
    const after = s.slice(s.search(spec.name) + 4);
    const m = spec.scoreRe.exec(after);
    if (!m) return false;
    const v = Number(m[1]);
    return v >= spec.range[0] && v <= spec.range[1];
  });
  const chosen = withScore ?? hits[0];

  if (NEGATION_RE.test(chosen)) {
    return { required: false, minScore: null, waiverAvailable: true, confidence: 0.8, sourceText: chosen };
  }

  let minScore: number | null = null;
  if (withScore) {
    const idx = withScore.search(spec.name);
    const after = withScore.slice(idx + 4);
    const m = spec.scoreRe.exec(after);
    if (m) {
      const v = Number(m[1]);
      if (v >= spec.range[0] && v <= spec.range[1]) minScore = v;
    }
  }

  return {
    required: true,
    minScore,
    detail: chosen.slice(0, 300),
    waiverAvailable: WAIVER_RE.test(chosen) ? true : null,
    confidence: minScore !== null ? 0.9 : 0.65,
    sourceText: chosen
  };
}

const DOCUMENT_SPECS: { code: string; label: string; re: RegExp }[] = [
  { code: 'CV', label: 'CV / Résumé', re: /\b(curriculum\s+vitae|\bCV\b|r[ée]sum[ée])\b/i },
  { code: 'TRANSCRIPT', label: 'Academic transcripts', re: /\b(transcripts?|academic\s+records?|mark\s+sheets?)\b/i },
  { code: 'STATEMENT_OF_PURPOSE', label: 'Statement of purpose', re: /\b(statement\s+of\s+purpose|SOP\b|motivation\s+letter|letter\s+of\s+motivation)\b/i },
  { code: 'PERSONAL_STATEMENT', label: 'Personal statement', re: /\bpersonal\s+statement\b/i },
  { code: 'RESEARCH_PROPOSAL', label: 'Research proposal', re: /\b(research\s+proposal|project\s+proposal)\b/i },
  { code: 'REFERENCES', label: 'Reference letters', re: /\b(recommendation\s+letters?|letters?\s+of\s+recommendation|referee\s+reports?|references?)\b/i },
  { code: 'PORTFOLIO', label: 'Portfolio', re: /\bportfolio\b/i },
  { code: 'PASSPORT', label: 'Passport copy', re: /\b(passport(?:\s+copy)?|copy\s+of\s+(?:your\s+)?passport)\b/i },
  { code: 'PROOF_OF_NATIONALITY', label: 'Proof of nationality', re: /\b(proof\s+of\s+(?:nationality|citizenship)|national\s+ID|birth\s+certificate)\b/i },
  { code: 'DEGREE_CERTIFICATE', label: 'Degree certificate', re: /\b(degree\s+certificates?|graduation\s+certificates?|award\s+certificates?)\b/i },
  { code: 'ENGLISH_CERTIFICATE', label: 'English test certificate', re: /\b(English\s+(?:language\s+)?(?:test\s+)?certificate|proof\s+of\s+English)\b/i },
  { code: 'FINANCIAL_STATEMENT', label: 'Proof of funds / financial statement', re: /\b(bank\s+statements?|proof\s+of\s+funds?|financial\s+statement)\b/i },
  { code: 'ADMISSION_LETTER', label: 'Offer / admission letter', re: /\b(offer\s+letter|admission\s+letter|letter\s+of\s+(?:offer|admission)|unconditional\s+offer)\b/i }
];

const DOC_CONTEXT_RE = /\b(document|submit|upload|provide|attach|require|include|application\s+(?:pack|form|materials)|checklist|supporting)\b/i;

export function extractRequirements(text: string | null | undefined): RequirementExtraction {
  const haystack = String(text || '');
  const sents = sentences(haystack);

  // ── Academic ──────────────────────────────────────────────────────────────
  let minimumDegree: RequirementExtraction['minimumDegree'] = { value: null, confidence: 0 };
  const degreeSentence = sents.find((s) =>
    /\b(hold|holding|possess|must\s+have|require[sd]?|completed?|awarded)\b/i.test(s) &&
    /\b(bachelor|master|degree|honours|first\s+degree|undergraduate|postgraduate)\b/i.test(s)
  );
  if (degreeSentence) {
    const lvl = normalizeDegree(degreeSentence);
    if (lvl) minimumDegree = { value: lvl, sourceText: degreeSentence, confidence: 0.8 };
  }

  let minimumGpa: RequirementExtraction['minimumGpa'] = { value: null, confidence: 0 };
  let gpaScale: RequirementExtraction['gpaScale'] = { value: null, confidence: 0 };
  for (const s of sents) {
    const m = /\bGPA\s*(?:of\s*)?(?:at\s+least\s*)?(?:>=?\s*)?(\d(?:\.\d{1,2})?)\s*(?:\/\s*(\d(?:\.\d)?)|\s+on\s+a\s+(\d(?:\.\d)?)[-\s]point)?/i.exec(s)
      ?? /\b(?:minimum|min\.?)\s+(?:cumulative\s+)?GPA\s*(?:of\s*)?(\d(?:\.\d{1,2})?)/i.exec(s);
    if (m) {
      const v = Number(m[1]);
      if (v > 0 && v <= 10) {
        minimumGpa = { value: v, sourceText: s, confidence: 0.85 };
        const scale = m[2] ?? m[3];
        if (scale) gpaScale = { value: Number(scale), confidence: 0.85 };
        else if (v <= 4) gpaScale = { value: 4, confidence: 0.4 }; // conventional, flagged low
        break;
      }
    }
  }

  let minimumGrade: RequirementExtraction['minimumGrade'] = { value: null, confidence: 0 };
  for (const s of sents) {
    const m = /\b(?:minimum\s+(?:of\s+)?|at\s+least\s+(?:a\s+)?|equivalent\s+(?:to|of)\s+(?:a\s+)?)?((?:upper|lower)\s+second[-\s]class(?:\s+honours)?|first[-\s]class(?:\s+honours)?|2[:.]1|2[:.]2|second\s+class\s+(?:upper|lower)|distinction|merit|credit|[A-C][+-]?\s+average)\b/i.exec(s);
    if (m && /\b(minimum|at\s+least|require|equivalent|classification|honours)\b/i.test(s)) {
      minimumGrade = { value: m[1].trim(), sourceText: s, confidence: 0.8 };
      break;
    }
  }

  const FIELD_RE = /\b(engineering|computer\s+science|medicine|law|business|economics|agriculture|education|nursing|public\s+health|environmental\s+science|data\s+science|mathematics|physics|chemistry|biology|social\s+sciences?|humanities|architecture|psychology|veterinary|pharmacy|journalism|finance|accounting|statistics|artificial\s+intelligence|renewable\s+energy|climate\s+change)\b/gi;
  const fieldHits = new Set<string>();
  for (const s of sents) {
    if (!/\b(field|discipline|subject|programme|program|course|stud(?:y|ies)\s+in|degree\s+in|applicants?\s+in)\b/i.test(s)) continue;
    let m: RegExpExecArray | null;
    const re = new RegExp(FIELD_RE.source, 'gi');
    while ((m = re.exec(s))) fieldHits.add(m[1].toLowerCase().replace(/\s+/g, ' '));
  }

  // ── English ───────────────────────────────────────────────────────────────
  const english = {
    ielts: extractEnglishTest(sents, TESTS[0]),
    toefl: extractEnglishTest(sents, TESTS[1]),
    pte: extractEnglishTest(sents, TESTS[2]),
    cambridge: extractEnglishTest(sents, TESTS[3]),
    duolingo: extractEnglishTest(sents, TESTS[4]),
    anyTestRequired: null as boolean | null,
    rawText: sents.filter((s) => /\b(IELTS|TOEFL|PTE|Duolingo|English\s+language\s+(?:requirement|proficiency|test))\b/i.test(s)).slice(0, 8)
  };
  const anyRequired = [english.ielts, english.toefl, english.pte, english.cambridge, english.duolingo]
    .map((t) => t.required)
    .filter((r) => r !== null);
  if (anyRequired.length > 0) english.anyTestRequired = anyRequired.some((r) => r === true);
  else if (/\bEnglish\s+language\s+(?:requirement|proficiency)\b/i.test(haystack)) english.anyTestRequired = true;

  // ── Documents ─────────────────────────────────────────────────────────────
  const documents: RequiredDocument[] = [];
  for (const spec of DOCUMENT_SPECS) {
    const hit = sents.find((s) => spec.re.test(s) && DOC_CONTEXT_RE.test(s));
    if (!hit) continue;
    let count: number | null = null;
    const cm = new RegExp(String.raw`\b(\d|two|three|four|one)\s+(?:\w+\s+){0,2}?(?=${spec.re.source})`, 'i').exec(hit);
    if (cm) {
      const words: Record<string, number> = { one: 1, two: 2, three: 3, four: 4 };
      count = words[cm[1].toLowerCase()] ?? Number(cm[1]);
      if (!Number.isFinite(count) || count > 20) count = null;
    }
    documents.push({
      code: spec.code,
      label: spec.label,
      count,
      mandatory: /\b(must|required|mandatory|essential)\b/i.test(hit) ? true : null,
      sourceText: hit.slice(0, 400)
    });
  }

  // ── Professional & other ──────────────────────────────────────────────────
  let workExperienceRequired: RequirementExtraction['workExperienceRequired'] = { value: null, confidence: 0 };
  let workExperienceYears: RequirementExtraction['workExperienceYears'] = { value: null, confidence: 0 };
  for (const s of sents) {
    if (!/\b(work\s+experience|professional\s+experience|years?\s+of\s+experience|employment\s+history)\b/i.test(s)) continue;
    if (NEGATION_RE.test(s) || /\bno\s+(?:prior\s+)?(?:work\s+)?experience\s+(?:is\s+)?required\b/i.test(s)) {
      workExperienceRequired = { value: false, sourceText: s, confidence: 0.8 };
      break;
    }
    workExperienceRequired = { value: true, sourceText: s, confidence: 0.8 };
    const ym = /\b(?:at\s+least\s+|minimum\s+(?:of\s+)?)?(\d{1,2})\s*(?:\+)?\s*years?\b/i.exec(s);
    if (ym) {
      const y = Number(ym[1]);
      if (y >= 1 && y <= 30) workExperienceYears = { value: y, sourceText: s, confidence: 0.85 };
    }
    break;
  }

  const regSentence = sents.find((s) => /\b(professional\s+(?:registration|licence|license|body|certification)|registered\s+with\s+the|chartered\s+status)\b/i.test(s));
  const supervisorSentence = sents.find((s) => /\b(supervisor|supervisory\s+team|academic\s+supervisor|identify\s+a\s+supervisor|agreed\s+supervisor)\b/i.test(s));
  const offerSentence = sents.find((s) => /\b((?:an\s+)?(?:unconditional\s+)?offer\s+of\s+(?:admission|a\s+place)|must\s+have\s+(?:been\s+)?(?:accepted|admitted)|hold\s+an\s+offer|admission\s+offer)\b/i.test(s));

  const rawRequirementText = sents
    .filter((s) => /\b(require|must|eligib|criteria|qualif|minimum|applicants?\s+should|you\s+will\s+need)\b/i.test(s))
    .slice(0, 20);

  return {
    minimumDegree,
    minimumGpa,
    gpaScale,
    minimumGrade,
    requiredFields: [...fieldHits],
    english,
    documents,
    workExperienceRequired,
    workExperienceYears,
    professionalRegistration: regSentence
      ? { value: regSentence.slice(0, 300), sourceText: regSentence, confidence: 0.7 }
      : { value: null, confidence: 0 },
    supervisorRequired: supervisorSentence
      ? { value: true, sourceText: supervisorSentence, confidence: 0.75 }
      : { value: null, confidence: 0 },
    admissionOfferRequired: offerSentence
      ? { value: true, sourceText: offerSentence, confidence: 0.75 }
      : { value: null, confidence: 0 },
    rawRequirementText
  };
}
