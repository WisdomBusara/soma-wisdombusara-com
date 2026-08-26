// classifier.ts — v2
//
// Fixes over v1 (root-caused from 2026-07-04 digest false positives):
//
//  1. WORD-BOUNDARY matching via wb() — "lead" no longer fires on "Leadership",
//     "analyst" no longer fires on "Analyst's Reports".
//
//  2. HARD VETOES that run before scoring — governance (Board of Directors,
//     Leadership), e-banking portals (Internet Banking, ib. subdomains, :port),
//     investor/media pages, login/help/feedback. These cannot be overridden.
//
//  3. THREE CLASSES instead of binary:
//       'posting'      → a real job listing, include in report
//       'careers_page' → a careers landing or ATS portal root — crawl one
//                        level deeper, never report the link itself
//       'reject'       → drop
//
//  4. Title-case bonus only counts when a role noun is also present —
//     "Board of Directors" can no longer stack its way to the threshold.
//
//  NOTE: .pdf URLs are intentionally NOT vetoed — Kenyan banks (UBA etc.)
//  publish real job descriptions as PDFs. "Relationship Manager, Personal
//  Banking" at a /JOB-DESCRIPTION-.../pdf URL is a true positive.

export const POSTING_THRESHOLD = 5;
// Alias so old code still compiles
export const THRESHOLD = POSTING_THRESHOLD;

// Build a word-boundary regex from a list of literal phrases.
function wb(words: string[]): RegExp {
  const escaped = words.map((w) => w.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&'));
  return new RegExp('\\b(' + escaped.join('|') + ')\\b', 'i');
}

// ── Hard vetoes ─────────────────────────────────────────────────────────────
// Anything matching here is REJECTED before scoring. No positive signal wins.

const VETO_TEXT = wb([
  // governance
  'board of directors', 'board of director', 'directors profile',
  'leadership', 'management team', 'executive team', 'our team', 'our leadership',
  // banking products / portals
  'internet banking', 'mobile banking', 'online banking', 'e-banking',
  'corporate internet banking', 'agency banking', 'net banking',
  // feedback / help
  'customer feedback', 'feedback survey', 'help & feedback', 'help and feedback',
  // investor / media
  'investor relations', 'analyst report', 'analyst reports',
  "analyst's report", "analyst's reports", 'annual report', 'annual reports',
  'financial statements', 'shareholder',
  // recruiter UX noise
  'job simulations', 'manage application', 'manage your application',
  'sign in', 'log in', 'login', 'user home', 'register', 'create account',
  // known false-positive phrases seen in the wild
  'work environment', 'work enviroment',  // their typo preserved
  'appointment notice', 'press release', 'media centre', 'news release',
  'tariff', 'whistleblowing', 'privacy policy', 'terms and conditions',
  'rapidtransfer',
  // employee-testimonial / marketing headlines (2026-07-05 digest)
  'employee stories', 'employee story', 'speaks', 'journey', 'life as',
  'testimonial', 'testimonials', 'at the helm', 'our vision',
  // award headlines
  'of the year', 'award', 'awards',
  // portals & insurance products masquerading as roles
  'portal', 'directors & officers', 'directors and officers',
  'attachment cover',
]);

const VETO_URL = /(\.(jpg|jpeg|png|gif|svg|webp|css|js|ico|mp4|zip))(\?|$)|\/(board|leadership|investor|shareholder|financial|media|news|press)([-/]|$)|\/wp-content\/uploads\/.*\.(jpg|jpeg|png|gif)|\/(personal-banking|business-banking|digital-banking|internet-banking|mobile-banking|agency-banking|payments?-transfers?|trade-finance|asset-finance|insurance|forex)(\/|$)|\/(ebanking|netbanking|ibanking)(\/|$)|\/(employee-stories|our-employee-stories|our-people|life-at|testimonials?|stories|awards)([-/]|$)/i;

// e-banking subdomains (ib.bank.co.ke) or non-standard ports (:8443)
const VETO_HOST = /^(ib|ebank|e-bank|netbank|online|ibanking)\.|:\d{4,5}\//i;

// ── Careers landing pages (crawl deeper, never report directly) ──────────────

const CAREERS_LANDING_TEXT = wb([
  'careers', 'career opportunities', 'current vacancies', 'vacancies',
  'work with us', 'join our team', 'join us',
  'explore opportunities', 'explore programmes', 'explore programs',
  'job openings', 'opportunities',
]);

// ── Positive signals ─────────────────────────────────────────────────────────

const ROLE_NOUNS = wb([
  'officer', 'officers',
  'manager', 'managers',
  'analyst', 'analysts',
  'engineer', 'engineers',
  'developer', 'developers',
  'programmer', 'programmers',
  'specialist', 'specialists',
  'assistant', 'assistants',
  'associate', 'associates',
  'administrator', 'administrators',
  'accountant', 'accountants',
  'auditor', 'auditors',
  'teller', 'tellers',
  'cashier', 'cashiers',
  'clerk', 'clerks',
  'consultant', 'consultants',
  'representative', 'representatives',
  'advisor', 'advisors', 'adviser', 'advisers',
  'coordinator', 'coordinators',
  'supervisor', 'supervisors',
  'director', 'directors',
  'architect', 'architects',
  'designer', 'designers',
  'scientist', 'scientists',
  'intern', 'interns', 'internship',
  'attachment', 'trainee', 'trainees',
  'actuary', 'underwriter', 'underwriters',
  'dealer', 'head of', 'team lead', 'team leader',
  'lead', 'leader', 'leaders',
  'trainer', 'trainers',
  'agent', 'agents',
  'product owner',
  'graduate programme', 'graduate program',
  // tech / data — note: bare "cybersecurity" removed; real cyber roles carry
  // engineer/analyst/specialist, while "Cyber security solutions" is a product
  'devops', 'dba', 'database administrator',
  'scrum master', 'helpdesk', 'help desk', 'it support',
  // legal
  'paralegal', 'advocate', 'advocates', 'lawyer', 'lawyers',
]);

// A URL whose path identifies a specific job posting (not just the portal root)
const ATS_JOB_URL = /myworkdayjobs\.com\/.+\/job\/|jobs\.[a-z-]+\.com\/job\/|oraclecloud\.com\/.+\/(job|requisition)\/\d+|smartrecruiters\.com\/.+\/\d+|greenhouse\.io\/.+\/jobs\/\d+|lever\.co\/.+\/[0-9a-f-]{36}|successfactors\..+\/career\?career_ns=job_listing|brightermonday\.co\.ke\/.+\/job\/|fuzu\.com\/.+\/jobs?\/.+/i;

// An ATS host but maybe not a specific job URL — likely a portal root
const ATS_HOST = /myworkdayjobs|workday\.com|successfactors|taleo\.net|oraclecloud.*CandidateExperience|smartrecruiters|greenhouse\.io|lever\.co|bamboohr|brightermonday\.co\.ke|fuzu\.com|eightfold\.ai/i;

// keyword may sit mid-segment: /careers/, /career_tax/, /latest-vacancies, /job-listing
const CAREER_URL = /[/_-](careers?|jobs?|vacanc\w*|recruitment|opportunit\w*|positions?|openings?)(\/|\?|$|[-_])/i;

const HIRING_WORDS = wb([
  'apply by', 'closing date', 'deadline', 'job ref', 'ref no',
  'we are hiring', 'job opening', 'more details',
]);

const PRODUCT_WORDS = wb([
  'loan', 'loans', 'mortgage', 'account', 'accounts', 'savings', 'deposit',
  'card', 'cards', 'insurance', 'bancassurance', 'forex', 'money transfer',
  'remittance', 'mpesa', 'm-pesa', 'pesalink', 'overdraft', 'asset finance',
  'trade finance', 'financing', 'banking', 'invest', 'borrow',
]);

// ── Types ────────────────────────────────────────────────────────────────────

export type CandidateClass = 'posting' | 'careers_page' | 'reject';

export interface Candidate {
  text: string;
  href: string;
  context?: string;
}

export interface ClassifyResult {
  type: CandidateClass;
  score: number;
  reasons: string[];
}

// ── Main classifier ──────────────────────────────────────────────────────────

export function classify({ text, href, context = '' }: Candidate): ClassifyResult {
  const t = (text || '').replace(/\s+/g, ' ').trim();
  const h = href || '';

  if (!t || t.length < 3) return { type: 'reject', score: 0, reasons: ['empty text'] };

  // 1. Hard vetoes — nothing can override these.
  if (VETO_TEXT.test(t))
    return { type: 'reject', score: 0, reasons: ['veto text'] };
  const hostPart = h.replace(/^https?:\/\/[^/]*/, '');  // path only for VETO_URL
  const hostName = h.replace(/^https?:\/\//, '').split('/')[0];
  if (VETO_URL.test(h) || VETO_HOST.test(hostName))
    return { type: 'reject', score: 0, reasons: ['veto url/host'] };

  const hasRole = ROLE_NOUNS.test(t);
  const isProduct = PRODUCT_WORDS.test(t);

  // 2. Product word kills unless a role noun is also present.
  //    "Personal Loans" → reject. "Personal Loans Officer" → continue.
  if (isProduct && !hasRole)
    return { type: 'reject', score: 0, reasons: ['product word without role noun'] };

  let score = 0;
  const reasons: string[] = [];

  // 3. Score positive signals.
  if (ATS_JOB_URL.test(h)) {
    score += 6; reasons.push('ATS job-detail URL');
  } else if (ATS_HOST.test(h)) {
    // ATS portal root, not a specific job → crawl target unless text has a role noun
    if (!hasRole) return { type: 'careers_page', score: 0, reasons: ['ATS portal root'] };
    score += 4; reasons.push('ATS host + role noun');
  }

  if (CAREER_URL.test(h)) { score += 3; reasons.push('career URL'); }
  if (hasRole) { score += 3; reasons.push('role noun'); }
  if (HIRING_WORDS.test(t) || HIRING_WORDS.test(context)) { score += 2; reasons.push('hiring words'); }

  // Title-case bonus ONLY when role noun also present — prevents governance
  // phrases stacking their way to the threshold.
  const words = t.split(/\s+/);
  if (hasRole && words.length >= 2 && words.length <= 14 &&
      words.filter((w) => /^[A-Z0-9]/.test(w)).length / words.length >= 0.5) {
    score += 1; reasons.push('title-cased');
  }

  if (score >= POSTING_THRESHOLD) return { type: 'posting', score, reasons };

  // 4. Careers landing page → enqueue for depth-1 crawl.
  if (CAREERS_LANDING_TEXT.test(t) || (CAREER_URL.test(h) && t.length < 40))
    return { type: 'careers_page', score, reasons: [...reasons, 'careers landing'] };

  return { type: 'reject', score, reasons };
}

// ── Tender classifier ────────────────────────────────────────────────────────
// Same 3-class contract as classify(), tuned for procurement notices.

const TENDER_WORDS = wb([
  'tender', 'tenders', 'invitation to tender', 'itt',
  'rfp', 'request for proposal', 'request for proposals',
  'rfq', 'request for quotation', 'request for quotations',
  'eoi', 'expression of interest', 'expressions of interest',
  'prequalification', 'pre-qualification', 'registration of suppliers',
  'bid', 'bids', 'bidding', 'procurement notice', 'framework agreement',
  'supply of', 'provision of', 'supply and delivery', 'supply, delivery',
  'proposed', 'construction of', 'disposal of',
]);

const TENDER_URL = /[/_-](tenders?|procurement|rfp|rfq|eoi|bids?|prequalification|opportunit\w*|notices?)(\/|\?|$|[-_.])/i;

const TENDER_LANDING_TEXT = wb([
  'current tenders', 'open tenders', 'active tenders', 'tenders',
  'procurement opportunities', 'view tenders', 'tender notices',
  'opportunities',
]);

const TENDER_VETO_TEXT = wb([
  'tender results', 'awarded', 'award notice', 'contract award',
  'closed tenders', 'past tenders', 'archived',
  'tender committee', 'procurement policy', 'procurement plan',
  'disposal committee', 'code of ethics',
  // shared noise
  'privacy policy', 'terms and conditions', 'login', 'sign in', 'register',
  'faq', 'faqs', 'contact us', 'about us', 'downloads',
]);

export function classifyTender({ text, href, context = '' }: Candidate): ClassifyResult {
  const t = (text || '').replace(/\s+/g, ' ').trim();
  const h = href || '';
  if (!t || t.length < 4) return { type: 'reject', score: 0, reasons: ['empty text'] };

  if (TENDER_VETO_TEXT.test(t)) return { type: 'reject', score: 0, reasons: ['veto text'] };
  if (VETO_URL.test(h)) return { type: 'reject', score: 0, reasons: ['veto url'] };

  // Short generic landing titles ("Current Tenders", "Open Tenders") are crawl
  // targets, not individual notices — decide before scoring pushes them over.
  if (t.length < 24 && TENDER_LANDING_TEXT.test(t) && !/\d/.test(t))
    return { type: 'careers_page', score: 0, reasons: ['tender landing'] };

  let score = 0;
  const reasons: string[] = [];
  const hasTenderWord = TENDER_WORDS.test(t) || TENDER_WORDS.test(context);
  if (hasTenderWord) { score += 3; reasons.push('tender word'); }
  if (TENDER_URL.test(h)) { score += 3; reasons.push('tender URL'); }
  // reference numbers are a strong signal: "KPLC/9A.1/PT/2/24", "Tender No."
  if (/\b(no\.?|ref)\s*[:.]?\s*[A-Z0-9]{2,}[/\-][A-Z0-9/\-]{3,}/i.test(t) || /[A-Z]{2,6}\/[A-Z0-9/.\-]{4,}/.test(t)) {
    score += 2; reasons.push('reference number');
  }
  // deadlines are common in notice titles
  if (/\b(closing|deadline|closes?)\b/i.test(t) || /\b(closing|deadline)\b/i.test(context)) {
    score += 1; reasons.push('deadline mention');
  }
  // .pdf notices are the norm in procurement
  if (/\.pdf(\?|$)/i.test(h)) { score += 1; reasons.push('pdf notice'); }

  if (score >= 5) return { type: 'posting', score, reasons };
  if (TENDER_LANDING_TEXT.test(t) || (TENDER_URL.test(h) && t.length < 40))
    return { type: 'careers_page', score, reasons: [...reasons, 'tender landing'] };
  return { type: 'reject', score, reasons };
}

// ── Backward-compat shims for existing code ──────────────────────────────────

export function isJob(candidate: Candidate): boolean {
  return classify(candidate).type === 'posting';
}

export function scoreCandidate(candidate: Candidate): { score: number; reasons: string[] } {
  const r = classify(candidate);
  return { score: r.score, reasons: r.reasons };
}

export interface ScoreResult { score: number; reasons: string[] }
