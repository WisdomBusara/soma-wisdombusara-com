// scholarshipClassifier.ts
//
// Deliberately mirrors the shape of the existing services/classifier.ts:
// word-boundary matching via wb(), hard vetoes that run before scoring, and a
// three-class verdict rather than a boolean. That file's lessons (a bare
// keyword match is almost always a false positive; landing pages must be
// crawl targets rather than results) apply identically here.
//
// Two entry points:
//   classifyScholarshipLink() — is this <a> worth enqueuing?      (cheap, §8)
//   classifyScholarshipPage() — is this page an actual award?     (§22, §46)

import { cleanText } from './normalize/text';

export const PAGE_THRESHOLD = 0.55;
export const LINK_THRESHOLD = 5;

// ── Learned weights (self-improvement loop) ─────────────────────────────────
//
// Each positive/negative scoring contribution below is tagged with the same
// string it pushes into `reasons`. services/scholarship/learning.ts nudges
// these multipliers based on how often admins approve vs reject pages that
// carried each reason, then calls setClassifierWeights() with the result.
// Bounded to +/-50% so a bad batch of feedback cannot invert the classifier's
// behaviour, and fully overridable/resettable by an operator since it is just
// a flat map, not a retrained model.

const WEIGHT_MIN = 0.5;
const WEIGHT_MAX = 1.5;
let weightOverrides: Record<string, number> = {};

export function setClassifierWeights(weights: Record<string, number>): void {
  weightOverrides = { ...weights };
}

export function getClassifierWeights(): Record<string, number> {
  return { ...weightOverrides };
}

function w(reasonKey: string): number {
  const v = weightOverrides[reasonKey];
  return typeof v === 'number' ? Math.min(WEIGHT_MAX, Math.max(WEIGHT_MIN, v)) : 1;
}

function wb(words: string[]): RegExp {
  const escaped = words.map((w) => w.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&'));
  return new RegExp('\\b(' + escaped.join('|') + ')\\b', 'i');
}

// ── Vocabulary ──────────────────────────────────────────────────────────────

const SCHOLARSHIP_WORDS = wb([
  'scholarship', 'scholarships', 'scholarship scheme',
  'fellowship', 'fellowships', 'studentship', 'studentships',
  'bursary', 'bursaries', 'grant', 'grants',
  'financial aid', 'financial support', 'financial assistance',
  'funding', 'funded', 'funding opportunities', 'funding opportunity',
  'tuition waiver', 'fee waiver', 'fee waivers', 'fees waiver',
  'award', 'awards', 'prize', 'prizes',
  'assistantship', 'assistantships', 'stipend'
]);

// Strong: these words alone justify treating a page as scholarship-ish
const STRONG_WORDS = wb([
  'scholarship', 'scholarships', 'studentship', 'studentships',
  'bursary', 'bursaries', 'fellowship', 'fellowships',
  'tuition waiver', 'fee waiver'
]);

const FUNDING_EVIDENCE = wb([
  'fully funded', 'partially funded', 'covers tuition', 'tuition fees',
  'living costs', 'living expenses', 'maintenance grant', 'stipend',
  'monthly allowance', 'travel allowance', 'accommodation', 'health insurance',
  'covers the cost', 'value of the award', 'award value', 'amount awarded',
  'per annum', 'per year', 'towards tuition'
]);

const ELIGIBILITY_EVIDENCE = wb([
  'eligibility', 'eligible', 'who can apply', 'entry requirements',
  'applicants must', 'you must be', 'open to', 'criteria',
  'international students', 'home students', 'nationality', 'citizens of',
  'academic requirements', 'minimum grade', 'minimum gpa'
]);

const APPLICATION_EVIDENCE = wb([
  'how to apply', 'application process', 'apply now', 'apply online',
  'application form', 'submit your application', 'application deadline',
  'to apply', 'selection process', 'shortlist', 'supporting documents',
  'application portal', 'make an application'
]);

const DEADLINE_EVIDENCE = wb([
  'deadline', 'closing date', 'applications close', 'apply by',
  'application deadline', 'submission deadline', 'closes on', 'due by',
  'rolling basis', 'open until'
]);

// ── Hard vetoes (§22 negative examples, §46) ────────────────────────────────

const VETO_TEXT = wb([
  // paying the university, not being paid by it
  'pay your fees', 'payment portal', 'make a payment', 'fee payment',
  'tuition fee payment', 'how to pay', 'payment methods', 'pay online',
  'fee schedule', 'tuition fee schedule', 'fees and funding calculator',
  // giving TO the university
  'donate', 'donation', 'give to', 'giving to', 'make a gift', 'philanthropy',
  'support our students by', 'leave a legacy', 'fundraising', 'endowment fund',
  'donor', 'donors', 'benefactor',
  // events and PR
  'alumni event', 'alumni reunion', 'graduation ceremony', 'awards ceremony',
  'congratulations to', 'winners announced', 'recipients announced',
  'has been awarded', 'was awarded to', 'celebrates', 'celebrating',
  // generic money advice, not an award
  'budgeting advice', 'money management', 'student loan repayment',
  'cost of living guide', 'managing your money', 'financial wellbeing',
  'hardship fund application form', 'council tax',
  // site furniture
  'privacy policy', 'terms and conditions', 'cookie policy', 'accessibility statement',
  'sitemap', 'contact us', 'log in', 'sign in', 'register your interest'
]);

const VETO_URL =
  /(\.(jpg|jpeg|png|gif|svg|webp|css|js|ico|mp4|zip|doc|docx|xls|xlsx))(\?|$)|\/(news|blog|press|media|events?|stories|alumni|donate|giving|shop|store|library|staff|research-groups?)([-/]|$)|\/(wp-content|wp-includes|assets|static)\//i;

// Archive / historical markers — a real award page rarely says these
const ARCHIVE_TEXT = wb([
  'this scholarship is no longer', 'no longer available', 'has now closed',
  'closed for applications', 'archive', 'archived', 'previous recipients',
  'past recipients', 'past winners', 'former scholars', 'discontinued',
  'we are no longer accepting', 'applications have closed'
]);

const NEWS_URL = /\/(news|blog|article|press-release|stories|post)\//i;

const SCHOLARSHIP_URL =
  /[/_-](scholarships?|studentships?|bursar(?:y|ies)|fellowships?|grants?|funding|financial-?(?:aid|support|assistance)|fees-?and-?funding|awards?|money)(\/|\?|$|[-_.])/i;

const LANDING_TEXT = wb([
  'scholarships', 'our scholarships', 'available scholarships',
  'scholarships and funding', 'fees and funding', 'funding your study',
  'funding opportunities', 'financial support', 'financial aid',
  'postgraduate funding', 'undergraduate funding', 'doctoral funding',
  'graduate funding', 'international scholarships', 'research funding',
  'search scholarships', 'scholarship finder', 'browse scholarships',
  'funding database'
]);

// ── Link classification (§8) ────────────────────────────────────────────────

export type LinkClass = 'scholarship' | 'landing' | 'reject';

export interface LinkCandidate {
  text: string;
  href: string;
  context?: string;
}

export interface LinkVerdict {
  type: LinkClass;
  score: number;
  reasons: string[];
}

/**
 * Should this link be enqueued as a crawl target?
 *
 * Note the §8 requirement: URL matching alone is insufficient. A link labelled
 * "Money and support" pointing at /students/money/ has no scholarship keyword
 * in either field, but the anchor context often does — which is why `context`
 * is scored too.
 */
export function classifyScholarshipLink({ text, href, context = '' }: LinkCandidate): LinkVerdict {
  const t = cleanText(text);
  const h = href || '';
  const ctx = cleanText(context);

  if (!t || t.length < 2) return { type: 'reject', score: 0, reasons: ['empty text'] };
  if (VETO_TEXT.test(t)) return { type: 'reject', score: 0, reasons: ['veto text'] };
  if (VETO_URL.test(h)) return { type: 'reject', score: 0, reasons: ['veto url'] };

  // Short generic hub titles ("Scholarships and funding", "Funding your study")
  // are crawl targets, not individual awards — decide before scoring pushes
  // them over the threshold. Same ordering fix that classifyTender applies to
  // "Current Tenders". An award-specific title survives this check because it
  // carries a distinguishing name, year or degree qualifier.
  const generic = t.length < 45 && LANDING_TEXT.test(t) && !/\d/.test(t);
  if (generic) {
    return { type: 'landing', score: 0, reasons: ['generic scholarship hub title'] };
  }

  let score = 0;
  const reasons: string[] = [];

  const isPdf = /\.pdf(\?|$)/i.test(h);
  if (SCHOLARSHIP_URL.test(h)) { score += 3; reasons.push('scholarship URL'); }
  if (STRONG_WORDS.test(t)) { score += 4; reasons.push('strong scholarship word in text'); }
  else if (SCHOLARSHIP_WORDS.test(t)) { score += 2; reasons.push('scholarship word in text'); }
  if (SCHOLARSHIP_WORDS.test(ctx)) { score += 1; reasons.push('scholarship word in context'); }
  if (FUNDING_EVIDENCE.test(t) || FUNDING_EVIDENCE.test(ctx)) { score += 1; reasons.push('funding language'); }
  if (DEADLINE_EVIDENCE.test(ctx)) { score += 1; reasons.push('deadline nearby'); }
  // PDFs are a first-class scholarship channel (§11), not noise
  if (isPdf && (SCHOLARSHIP_WORDS.test(t) || SCHOLARSHIP_URL.test(h))) {
    score += 2; reasons.push('scholarship PDF');
  }
  if (NEWS_URL.test(h)) { score -= 3; reasons.push('news path penalty'); }
  if (ARCHIVE_TEXT.test(t)) { score -= 4; reasons.push('archive language'); }

  if (score >= LINK_THRESHOLD) return { type: 'scholarship', score, reasons };

  // Landing pages get crawled one level deeper but never reported themselves
  const shortAndGeneric = t.length < 60 && LANDING_TEXT.test(t);
  if (shortAndGeneric || (SCHOLARSHIP_URL.test(h) && t.length < 50 && score > 0)) {
    return { type: 'landing', score, reasons: [...reasons, 'scholarship landing'] };
  }
  return { type: 'reject', score, reasons };
}

// ── Page classification (§22, §46) ──────────────────────────────────────────

export interface PageInput {
  url: string;
  title?: string;
  metaDescription?: string;
  headings?: string[];
  text: string;
  /** JSON-LD @type values found on the page, if any */
  structuredDataTypes?: string[];
  linkTexts?: string[];
}

export interface PageVerdict {
  isScholarship: boolean;
  /** 0–1 */
  score: number;
  reasons: string[];
  /** Which of the four §46 evidence classes were present */
  evidence: {
    funding: boolean;
    eligibility: boolean;
    application: boolean;
    deadline: boolean;
  };
  /** True when this looks like a hub page listing many awards */
  isLandingPage: boolean;
}

/**
 * Score a fetched page.
 *
 * §46 is the governing rule: the word "scholarship" is necessary but nowhere
 * near sufficient. A page must carry at least one of funding / eligibility /
 * application / deadline evidence, and two or more to clear the threshold
 * comfortably.
 */
export function classifyScholarshipPage(input: PageInput): PageVerdict {
  const title = cleanText(input.title ?? '');
  const meta = cleanText(input.metaDescription ?? '');
  const headings = (input.headings ?? []).map(cleanText).join(' \n ');
  const body = cleanText(input.text ?? '');
  const url = input.url ?? '';

  const all = [title, meta, headings, body].join(' \n ');
  const reasons: string[] = [];

  const evidence = {
    funding: FUNDING_EVIDENCE.test(all),
    eligibility: ELIGIBILITY_EVIDENCE.test(all),
    application: APPLICATION_EVIDENCE.test(all),
    deadline: DEADLINE_EVIDENCE.test(all)
  };

  const noEvidence = (why: string): PageVerdict => ({
    isScholarship: false, score: 0, reasons: [why], evidence, isLandingPage: false
  });

  if (!body || body.length < 120) return noEvidence('page too short to judge');
  if (VETO_URL.test(url)) return noEvidence('veto url');

  // Veto only fires on title/meta — the phrase "make a payment" appearing in a
  // footer must not kill a legitimate scholarship page.
  if (VETO_TEXT.test(title) || VETO_TEXT.test(meta)) return noEvidence('veto text in title/meta');

  if (!SCHOLARSHIP_WORDS.test(all)) return noEvidence('no scholarship vocabulary');

  // Archive detection: only decisive when it appears near the top of the page
  const head = body.slice(0, 1200);
  if (ARCHIVE_TEXT.test(title) || ARCHIVE_TEXT.test(head)) {
    return { isScholarship: false, score: 0.1, reasons: ['archived/closed award'], evidence, isLandingPage: false };
  }

  let score = 0;

  if (STRONG_WORDS.test(title)) { score += 0.25 * w('strong scholarship word in title'); reasons.push('strong scholarship word in title'); }
  else if (SCHOLARSHIP_WORDS.test(title)) { score += 0.12 * w('scholarship word in title'); reasons.push('scholarship word in title'); }
  if (SCHOLARSHIP_URL.test(url)) { score += 0.1 * w('scholarship URL'); reasons.push('scholarship URL'); }
  if (STRONG_WORDS.test(headings)) { score += 0.1 * w('scholarship heading'); reasons.push('scholarship heading'); }

  if (evidence.funding) { score += 0.2 * w('contains funding information'); reasons.push('contains funding information'); }
  if (evidence.eligibility) { score += 0.18 * w('contains eligibility criteria'); reasons.push('contains eligibility criteria'); }
  if (evidence.application) { score += 0.16 * w('contains application instructions'); reasons.push('contains application instructions'); }
  if (evidence.deadline) { score += 0.14 * w('contains application deadline'); reasons.push('contains application deadline'); }

  if (input.structuredDataTypes?.some((t) => /EducationalOccupationalProgram|Grant|MonetaryGrant|Course/i.test(t))) {
    score += 0.08 * w('structured data signals a funded programme'); reasons.push('structured data signals a funded programme');
  }

  // Density check — one passing mention in a 20k-word prospectus is not a page
  // about a scholarship.
  const mentions = (body.match(/scholarship|studentship|bursar|fellowship/gi) ?? []).length;
  const words = body.split(/\s+/).length;
  if (mentions >= 3 && words > 0 && mentions / words > 0.0015) {
    score += 0.08 * w('sustained scholarship focus'); reasons.push('sustained scholarship focus');
  } else if (mentions <= 1 && words > 1500) {
    score -= 0.2 * w('single passing mention in a long page'); reasons.push('single passing mention in a long page');
  }

  if (NEWS_URL.test(url)) { score -= 0.25 * w('news/blog path'); reasons.push('news/blog path'); }
  // Past-tense award announcements
  if (/\b(has been awarded|was awarded|received the .{0,40}scholarship|winners? (?:of|were)|recipients? (?:of|were))\b/i.test(head)) {
    score -= 0.2 * w('reads as an award announcement'); reasons.push('reads as an award announcement');
  }

  const evidenceCount = Object.values(evidence).filter(Boolean).length;
  if (evidenceCount === 0) { score = Math.min(score, 0.2); reasons.push('no funding/eligibility/application/deadline evidence'); }
  else if (evidenceCount === 1) { score -= 0.08; reasons.push('only one evidence class present'); }

  // Landing pages: many scholarship links, little award-specific detail
  const scholarshipLinks = (input.linkTexts ?? []).filter((t) => SCHOLARSHIP_WORDS.test(t)).length;
  const isLandingPage =
    scholarshipLinks >= 6 && evidenceCount <= 2 && !/\b(this scholarship|the award covers|applicants for this)\b/i.test(body);
  if (isLandingPage) reasons.push('looks like a scholarship index/landing page');

  score = Math.max(0, Math.min(1, score));

  return {
    isScholarship: score >= PAGE_THRESHOLD && !isLandingPage,
    score: Number(score.toFixed(3)),
    reasons,
    evidence,
    isLandingPage
  };
}

export const _vocab = {
  SCHOLARSHIP_WORDS, STRONG_WORDS, FUNDING_EVIDENCE, ELIGIBILITY_EVIDENCE,
  APPLICATION_EVIDENCE, DEADLINE_EVIDENCE, SCHOLARSHIP_URL, LANDING_TEXT
};
