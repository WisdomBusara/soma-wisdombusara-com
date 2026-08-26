import type {
  DegreeLevel, StudyMode, AttendanceMode, DeliveryMode, ExtractionMethod
} from '../../../models/scholarship/types';
import { cleanText, normalizeTitle, resolveUrl } from '../normalize/text';
import { extractDegreeLevels } from '../normalize/degree';
import { extractStudyMode, extractAttendance, extractDeliveryMode } from '../normalize/studyMode';
import { extractFunding, type FundingExtraction } from '../normalize/funding';
import { extractEligibility, type EligibilityExtraction } from '../normalize/eligibility';
import { extractRequirements, type RequirementExtraction } from '../normalize/requirements';
import { extractDeadline, type DeadlineResult } from '../normalize/deadline';
import type { FetchResult } from '../fetcher';

/**
 * Rule-based extraction (§6 of the pipeline, §39).
 *
 * This is the *baseline*, and it is always run — including when AI extraction
 * is enabled. Two reasons:
 *
 *   1. §39 requires the system to work without an AI provider configured.
 *   2. It gives the AI overlay something to be diffed against, so a model that
 *      contradicts the deterministic reading is visible rather than silently
 *      authoritative.
 */

export interface ScholarshipDraft {
  title: string;
  normalizedTitle: string;
  provider: string | null;
  description: string | null;

  degreeLevels: DegreeLevel[];
  degreeEvidence: string[];

  fieldsOfStudy: string[];

  studyMode: StudyMode[];
  attendance: AttendanceMode[];
  deliveryMode: DeliveryMode[];
  modeEvidence: string[];

  funding: FundingExtraction;
  eligibility: EligibilityExtraction;
  requirements: RequirementExtraction;
  deadline: DeadlineResult;

  applicationUrl: { value: string | null; sourceText?: string; confidence: number };
  academicYear: string | null;
  intake: string | null;
  duration: string | null;

  sourceUrl: string;
  method: ExtractionMethod;
  fieldsExtracted: number;
}

const APPLY_TEXT_RE = /\b(apply\s+now|apply\s+online|apply\s+here|start\s+your\s+application|make\s+an\s+application|application\s+form|submit\s+an\s+application|apply\s+for\s+this)\b/i;
const APPLY_URL_RE = /\/(apply|application|admissions?\/apply|portal|forms?)\b|apply\.|applications?\./i;

/**
 * Find the real application URL (§59).
 *
 * Prefers, in order: a link whose text is an explicit call to action, then a
 * link whose URL looks like an application endpoint. Never falls back to the
 * homepage, and never invents one — a null applicationUrl is correct output
 * when the page does not link to an application.
 */
function findApplicationUrl(page: FetchResult): { value: string | null; sourceText?: string; confidence: number } {
  for (const link of page.links) {
    if (APPLY_TEXT_RE.test(link.text)) {
      return { value: link.href, sourceText: cleanText(link.text), confidence: 0.9 };
    }
  }
  for (const link of page.links) {
    if (APPLY_URL_RE.test(link.href) && /\bappl(y|ication)\b/i.test(`${link.text} ${link.context}`)) {
      return { value: link.href, sourceText: cleanText(link.text) || link.href, confidence: 0.7 };
    }
  }
  return { value: null, confidence: 0 };
}

/** "2027/28", "2027-2028", "academic year 2027" */
function findAcademicYear(text: string): string | null {
  const m =
    /\b(?:academic\s+year|entry|intake|session|for)\s*:?\s*((?:19|20)\d{2}\s*[/-]\s*(?:19|20)?\d{2})\b/i.exec(text) ??
    /\b((?:19|20)\d{2}\s*[/-]\s*(?:19|20)?\d{2})\s+(?:academic\s+year|entry|intake|session)\b/i.exec(text) ??
    /\b((?:19|20)\d{2}\s*[/-]\s*(?:19|20)?\d{2})\b/.exec(text);
  if (!m) return null;
  return m[1].replace(/\s+/g, '');
}

function findIntake(text: string): string | null {
  const m = /\b((?:September|October|January|February|March|April|May|June|July|August|November|December|Autumn|Fall|Spring|Summer|Winter)\s+(?:19|20)\d{2}|(?:September|January|Autumn|Fall|Spring)\s+(?:intake|entry|start))\b/i.exec(text);
  return m ? cleanText(m[1]) : null;
}

function findDuration(text: string): string | null {
  const m = /\b((?:up\s+to\s+|for\s+)?(?:one|two|three|four|five|\d{1,2})\s*(?:\+)?\s*(?:year|month|semester)s?\s*(?:of\s+(?:funding|study|support))?)\b/i.exec(text);
  if (!m) return null;
  // Only accept it when the sentence is actually about duration of the award
  const around = text.slice(Math.max(0, m.index - 120), m.index + m[0].length + 120);
  if (!/\b(duration|award\s+is\s+(?:held|tenable)|funded\s+for|tenure|length\s+of|support(?:ed)?\s+for|covers?\s+\w+\s+years)\b/i.test(around)) {
    return null;
  }
  return cleanText(m[1]);
}

/** The scholarship provider when it is not the university itself. */
function findProvider(text: string, title: string): string | null {
  const m =
    /\b(?:funded\s+by|sponsored\s+by|in\s+partnership\s+with|offered\s+by|awarded\s+by|supported\s+by)\s+(?:the\s+)?([A-Z][A-Za-z&.,'-]*(?:\s+[A-Z][A-Za-z&.,'-]*){0,5})/.exec(text);
  if (m) return cleanText(m[1]).replace(/[.,]$/, '').slice(0, 150);
  // Named schemes in the title: "Chevening Scholarships", "Commonwealth Shared Scholarship"
  const t = /\b(Chevening|Commonwealth|Fulbright|Erasmus\s*\+?|DAAD|Gates\s+Cambridge|Rhodes|Marshall|Mandela\s+Rhodes|MasterCard\s+Foundation|Schwarzman|Clarendon|Vanier|Endeavour)\b/i.exec(title);
  return t ? cleanText(t[1]) : null;
}

/** Clean a page title down to the award name. */
function deriveTitle(page: FetchResult): string {
  const raw = page.title ?? page.headings[0] ?? '';
  let t = cleanText(raw);
  // Strip site-name suffixes: "X Scholarship | University of Y"
  t = t.split(/\s+[|·—–]\s+/)[0].trim();
  if (t.length < 4 && page.headings.length > 0) t = cleanText(page.headings[0]);
  return t.slice(0, 300) || 'Untitled scholarship';
}

function countExtracted(d: Omit<ScholarshipDraft, 'fieldsExtracted'>): number {
  let n = 0;
  if (d.degreeLevels.length) n += 1;
  if (d.fieldsOfStudy.length) n += 1;
  if (d.studyMode[0] !== 'UNKNOWN') n += 1;
  if (d.attendance[0] !== 'UNKNOWN') n += 1;
  if (d.funding.primaryType !== 'UNKNOWN') n += 1;
  if (d.funding.tuitionCovered.value !== null) n += 1;
  if (d.funding.livingStipend.value !== null) n += 1;
  if (d.funding.stipendAmount.amount !== null) n += 1;
  if (d.eligibility.scope !== 'UNKNOWN') n += 1;
  if (d.eligibility.countries.length) n += 1;
  if (d.requirements.minimumDegree.value) n += 1;
  if (d.requirements.english.anyTestRequired !== null) n += 1;
  if (d.requirements.documents.length) n += 1;
  if (d.deadline.kind !== 'UNKNOWN') n += 1;
  if (d.applicationUrl.value) n += 1;
  if (d.academicYear) n += 1;
  return n;
}

/**
 * Extract a scholarship draft from a fetched page using deterministic rules.
 */
export function extractWithRules(
  page: FetchResult,
  opts: { countryCode?: string | null } = {}
): ScholarshipDraft {
  // Headings carry disproportionate signal, so weight them by including them
  // twice in the analysis corpus. Body text alone under-detects section labels
  // like "Eligibility" that appear once as an <h2>.
  const headingBlock = page.headings.join('. ');
  const corpus = [page.title ?? '', page.metaDescription ?? '', headingBlock, headingBlock, page.text]
    .filter(Boolean)
    .join('\n');

  const title = deriveTitle(page);
  const degree = extractDegreeLevels(corpus);
  const study = extractStudyMode(corpus);
  const attend = extractAttendance(corpus);
  const delivery = extractDeliveryMode(corpus);
  const funding = extractFunding(corpus, page.finalUrl);
  const eligibility = extractEligibility(corpus);
  const requirements = extractRequirements(corpus);
  const deadline = extractDeadline(corpus, { countryCode: opts.countryCode });

  const applicationUrl = findApplicationUrl(page);
  if (applicationUrl.value) {
    const abs = resolveUrl(applicationUrl.value, page.finalUrl);
    applicationUrl.value = abs;
  }

  const description = cleanText(page.metaDescription || page.text.slice(0, 600)) || null;

  const draft: Omit<ScholarshipDraft, 'fieldsExtracted'> = {
    title,
    normalizedTitle: normalizeTitle(title),
    provider: findProvider(corpus, title),
    description,
    degreeLevels: degree.levels,
    degreeEvidence: degree.evidence,
    fieldsOfStudy: requirements.requiredFields,
    studyMode: study.values,
    attendance: attend.values,
    deliveryMode: delivery.values,
    modeEvidence: [...study.evidence, ...attend.evidence],
    funding,
    eligibility,
    requirements,
    deadline,
    applicationUrl,
    academicYear: findAcademicYear(corpus),
    intake: findIntake(corpus),
    duration: findDuration(corpus),
    sourceUrl: page.finalUrl,
    method: 'RULES'
  };

  return { ...draft, fieldsExtracted: countExtracted(draft) };
}
