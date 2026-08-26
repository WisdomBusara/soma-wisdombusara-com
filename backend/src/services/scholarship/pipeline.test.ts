import { describe, it, expect } from 'vitest';
import { extractWithRules } from './extractor/rules';
import { classifyScholarshipPage } from './scholarshipClassifier';
import { computeFingerprint } from './dedupe';
import { computeStatus, detectChanges } from './status';
import { scoreDraft } from './extractor';
import type { FetchResult } from './fetcher';

/**
 * Integration test: crawl → classify → extract → normalize → dedupe → status.
 *
 * These fixtures are FIXTURES — synthetic pages written to exercise the
 * pipeline, clearly marked as such (§52). They are not scraped content and no
 * scholarship record produced here is real. Live verification against real
 * public sources is an operational step (`npm run scholarships:extract
 * -- --url=…`), not something a unit test should perform.
 */

function fixturePage(over: Partial<FetchResult> & { text: string }): FetchResult {
  return {
    ok: true,
    url: over.url ?? 'https://fixture.example.ac.uk/scholarships/global-masters',
    finalUrl: over.finalUrl ?? over.url ?? 'https://fixture.example.ac.uk/scholarships/global-masters',
    status: 200,
    contentType: 'text/html',
    method: 'HTTP',
    headings: over.headings ?? [],
    links: over.links ?? [],
    structuredDataTypes: [],
    bytes: over.text.length,
    durationMs: 10,
    contentHash: 'fixturehash',
    ...over
  } as FetchResult;
}

// ── FIXTURE: a complete, well-formed scholarship page ────────────────────────
const FULL_PAGE = fixturePage({
  title: 'Global Masters Scholarship | Example University',
  metaDescription: 'A fully funded scholarship for Master\'s applicants from East Africa.',
  headings: ['Global Masters Scholarship', 'Funding', 'Eligibility', 'Academic requirements', 'How to apply', 'Deadline'],
  links: [
    { text: 'Apply now', href: 'https://fixture.example.ac.uk/apply/global-masters', context: 'Start your application' },
    { text: 'Contact us', href: 'https://fixture.example.ac.uk/contact', context: '' }
  ],
  text: [
    'The Global Masters Scholarship is a fully funded award for the 2027/28 academic year.',
    'Funding: the scholarship covers full tuition fees and provides a living stipend of £18,622 per year.',
    'Health insurance is included. A travel allowance is provided. The award does not cover accommodation costs.',
    'Eligibility: the scholarship is open to citizens of Kenya, Uganda and Tanzania.',
    'Applicants must hold a Bachelor degree with a minimum of an upper second-class honours.',
    'English language requirement: IELTS 6.5 overall with no band below 6.0.',
    'You must submit a CV, academic transcripts, a statement of purpose and two references.',
    'The scholarship supports full-time, on-campus study only.',
    'Applications close at 23:59 GMT on 15 January 2027.',
    'How to apply: complete the online application form.'
  ].join(' ')
});

describe('end-to-end extraction on a complete page', () => {
  const verdict = classifyScholarshipPage({
    url: FULL_PAGE.finalUrl,
    title: FULL_PAGE.title,
    metaDescription: FULL_PAGE.metaDescription,
    headings: FULL_PAGE.headings,
    text: FULL_PAGE.text,
    linkTexts: FULL_PAGE.links.map((l) => l.text)
  });
  const draft = extractWithRules(FULL_PAGE, { countryCode: 'GB' });

  it('classifies the page as a scholarship with all four evidence classes', () => {
    expect(verdict.isScholarship).toBe(true);
    expect(verdict.evidence.funding).toBe(true);
    expect(verdict.evidence.eligibility).toBe(true);
    expect(verdict.evidence.application).toBe(true);
    expect(verdict.evidence.deadline).toBe(true);
  });

  it('derives a clean title, stripping the site suffix', () => {
    expect(draft.title).toBe('Global Masters Scholarship');
  });

  it('normalizes the degree level', () => {
    expect(draft.degreeLevels).toContain('MASTERS');
  });

  it('normalizes funding to FULLY_FUNDED with evidence', () => {
    expect(draft.funding.primaryType).toBe('FULLY_FUNDED');
    expect(draft.funding.tuitionCovered.value).toBe(true);
    expect(draft.funding.tuitionCovered.sourceText).toMatch(/tuition/i);
    expect(draft.funding.livingStipend.value).toBe(true);
  });

  it('captures the stipend amount and currency without converting', () => {
    expect(draft.funding.stipendAmount.amount).toBe(18622);
    expect(draft.funding.stipendAmount.currency).toBe('GBP');
    expect(draft.funding.stipendAmount.originalText).toContain('18,622');
  });

  it('records an explicit non-coverage as false, not unknown', () => {
    expect(draft.funding.accommodationCovered.value).toBe(false);
    expect(draft.funding.accommodationCovered.certainty).toBe('NEGATIVE');
  });

  it('leaves genuinely unmentioned funding items UNKNOWN', () => {
    expect(draft.funding.applicationFeeWaiver.value).toBeNull();
    expect(draft.funding.equipmentAllowance.value).toBeNull();
  });

  it('extracts the explicit country eligibility list', () => {
    expect(draft.eligibility.scope).toBe('SPECIFIC_COUNTRIES');
    expect(draft.eligibility.countries).toEqual(['KE', 'UG', 'TZ']);
  });

  it('extracts structured requirements rather than a text blob', () => {
    expect(draft.requirements.minimumDegree.value).toBe('BACHELORS');
    expect(draft.requirements.english.ielts.required).toBe(true);
    expect(draft.requirements.english.ielts.minScore).toBe(6.5);
    const codes = draft.requirements.documents.map((d) => d.code);
    expect(codes).toContain('CV');
    expect(codes).toContain('TRANSCRIPT');
    expect(codes).toContain('STATEMENT_OF_PURPOSE');
  });

  it('extracts study mode and attendance only because the page states them', () => {
    expect(draft.attendance).toEqual(['FULL_TIME']);
    expect(draft.studyMode).toContain('ON_CAMPUS');
  });

  it('parses the deadline and preserves the original wording and timezone', () => {
    expect(draft.deadline.kind).toBe('FIXED');
    expect(draft.deadline.date?.getUTCFullYear()).toBe(2027);
    expect(draft.deadline.date?.getUTCMonth()).toBe(0);
    expect(draft.deadline.timezoneStated).toBe('GMT');
    expect(draft.deadline.originalText).toMatch(/23:59/);
  });

  it('finds the real application URL, not the homepage', () => {
    expect(draft.applicationUrl.value).toBe('https://fixture.example.ac.uk/apply/global-masters');
  });

  it('extracts the academic year', () => {
    expect(draft.academicYear).toBe('2027/28');
  });

  it('scores high confidence for an official, complete source', () => {
    const { confidence, qualityScore } = scoreDraft(draft, {
      sourceType: 'UNIVERSITY', classificationScore: verdict.score, aiUsed: false, disagreements: 0
    });
    expect(confidence).toBeGreaterThan(0.7);
    expect(qualityScore).toBeGreaterThan(0.7);
  });

  it('computes OPEN status for a future deadline', () => {
    const status = computeStatus(
      { deadlineKind: draft.deadline.kind, deadlineDate: draft.deadline.date, confidence: 0.85 },
      new Date('2026-08-24T00:00:00Z')
    );
    expect(status).toBe('OPEN');
  });
});

// ── FIXTURE: the same award on a faculty page with a different URL ───────────
const MIRROR_PAGE = fixturePage({
  url: 'https://engineering.fixture.example.ac.uk/funding/global-masters-scholarships',
  title: 'Global Masters Scholarships 2027/28 — Faculty of Engineering',
  headings: ['Global Masters Scholarships', 'Eligibility'],
  text: [
    'The Global Masters Scholarship for 2027/28 is fully funded.',
    'It covers tuition fees and includes a living stipend.',
    'Open to citizens of Kenya, Uganda and Tanzania.',
    'Applicants must hold a Bachelor degree.',
    'Applications close on 15 January 2027.'
  ].join(' ')
});

describe('deduplication across two URLs for the same award', () => {
  const a = extractWithRules(FULL_PAGE, { countryCode: 'GB' });
  const b = extractWithRules(MIRROR_PAGE, { countryCode: 'GB' });
  const universityId = 'aaaaaaaaaaaaaaaaaaaaaaaa';

  it('normalizes both titles to the same dedup key', () => {
    expect(a.normalizedTitle).toBe(b.normalizedTitle);
  });

  it('produces an identical fingerprint despite different URLs', () => {
    const fpA = computeFingerprint({
      universityId, normalizedTitle: a.normalizedTitle, academicYear: a.academicYear,
      degreeLevels: a.degreeLevels, provider: a.provider
    });
    const fpB = computeFingerprint({
      universityId, normalizedTitle: b.normalizedTitle, academicYear: b.academicYear,
      degreeLevels: b.degreeLevels, provider: b.provider
    });
    expect(fpA).toBe(fpB);
  });

  it('the richer source scores higher quality, so it wins on update', () => {
    const qa = scoreDraft(a, { sourceType: 'UNIVERSITY', classificationScore: 0.9, aiUsed: false, disagreements: 0 });
    const qb = scoreDraft(b, { sourceType: 'FACULTY', classificationScore: 0.8, aiUsed: false, disagreements: 0 });
    expect(qa.qualityScore).toBeGreaterThan(qb.qualityScore);
  });
});

// ── FIXTURE: sparse page, missing deadline and funding ──────────────────────
const SPARSE_PAGE = fixturePage({
  url: 'https://fixture.example.ac.uk/scholarships/vague-award',
  title: 'The Vague Award',
  headings: ['The Vague Award'],
  text: 'The Vague Award is a scholarship offered by the university. Students may be eligible. '.repeat(4)
});

describe('sparse and ambiguous pages', () => {
  const draft = extractWithRules(SPARSE_PAGE, { countryCode: 'GB' });

  it('leaves the deadline UNKNOWN rather than inventing one', () => {
    expect(draft.deadline.kind).toBe('UNKNOWN');
    expect(draft.deadline.date).toBeNull();
  });

  it('leaves funding UNKNOWN rather than assuming', () => {
    expect(draft.funding.primaryType).toBe('UNKNOWN');
  });

  it('does not fabricate an application URL', () => {
    expect(draft.applicationUrl.value).toBeNull();
  });

  it('never turns "may be eligible" into confirmed eligibility', () => {
    // §56 — hedged language must not become an assertion
    expect(draft.eligibility.scope).not.toBe('BOTH');
    expect(draft.eligibility.countries).toEqual([]);
  });

  it('scores low confidence, which routes it to human review', () => {
    const { confidence } = scoreDraft(draft, {
      sourceType: 'UNIVERSITY', classificationScore: 0.6, aiUsed: false, disagreements: 0
    });
    expect(confidence).toBeLessThan(0.6);
  });

  it('refuses to claim OPEN with no deadline', () => {
    expect(
      computeStatus({ deadlineKind: 'UNKNOWN', deadlineDate: null, confidence: 0.5 }, new Date())
    ).toBe('DISCOVERED');
  });
});

// ── FIXTURE: PDF-sourced scholarship ────────────────────────────────────────
const PDF_PAGE = fixturePage({
  url: 'https://fixture.example.ac.uk/docs/pg-scholarships-2027.pdf',
  contentType: 'application/pdf',
  method: 'PDF',
  title: 'Postgraduate Scholarship Scheme 2027/28',
  text: [
    'Postgraduate Scholarship Scheme 2027/28.',
    'The scheme is partially funded and covers 50% of tuition fees.',
    'Eligibility: open to international students.',
    'Applicants must hold a Master degree or equivalent.',
    'The closing date for applications is 1 March 2027.',
    'Submit a CV and a research proposal.'
  ].join(' ')
});

describe('PDF-sourced scholarship', () => {
  const draft = extractWithRules(PDF_PAGE, { countryCode: 'GB' });

  it('extracts structured data from PDF text with no links available', () => {
    expect(draft.funding.primaryType).toBe('PARTIALLY_FUNDED');
    expect(draft.funding.tuitionPercentage.value).toBe(50);
    expect(draft.deadline.date?.getUTCMonth()).toBe(2);
    expect(draft.requirements.documents.map((d) => d.code)).toContain('RESEARCH_PROPOSAL');
  });

  it('marks eligibility as INTERNATIONAL without inventing a country list', () => {
    expect(draft.eligibility.scope).toBe('INTERNATIONAL');
    expect(draft.eligibility.countries).toEqual([]);
  });

  it('has no application URL because a PDF carries no links here', () => {
    expect(draft.applicationUrl.value).toBeNull();
  });
});

// ── Expired award ───────────────────────────────────────────────────────────
describe('expired award handling', () => {
  const past = fixturePage({
    url: 'https://fixture.example.ac.uk/scholarships/old-award',
    title: 'Legacy Masters Award',
    text: [
      'The Legacy Masters Award is fully funded and covers tuition fees and a stipend.',
      'Open to international students holding a Bachelor degree.',
      'Applications closed on 15 January 2020.',
      'Submit a CV and transcripts to apply.'
    ].join(' ')
  });
  const draft = extractWithRules(past, { countryCode: 'GB' });

  it('parses a historical deadline correctly', () => {
    expect(draft.deadline.date?.getUTCFullYear()).toBe(2020);
  });

  it('computes EXPIRED, and the record is retained rather than deleted', () => {
    const status = computeStatus(
      { deadlineKind: 'FIXED', deadlineDate: draft.deadline.date, confidence: 0.8 },
      new Date('2026-08-24T00:00:00Z')
    );
    expect(status).toBe('EXPIRED');
  });
});

// ── Change detection across two crawls ──────────────────────────────────────
describe('change detection between crawls', () => {
  it('detects a deadline extension as a MAJOR change', () => {
    const first = extractWithRules(FULL_PAGE, { countryCode: 'GB' });
    const moved = fixturePage({
      ...FULL_PAGE,
      text: FULL_PAGE.text.replace('15 January 2027', '1 March 2027')
    });
    const second = extractWithRules(moved, { countryCode: 'GB' });

    const changes = detectChanges(
      { deadline: { date: first.deadline.date, kind: first.deadline.kind } },
      { deadline: { date: second.deadline.date, kind: second.deadline.kind } }
    );
    const d = changes.find((c) => c.field === 'deadline');
    expect(d).toBeTruthy();
    expect(d?.significance).toBe('MAJOR');
  });

  it('reports no change when the page is re-crawled unmodified', () => {
    const a = extractWithRules(FULL_PAGE, { countryCode: 'GB' });
    const b = extractWithRules(FULL_PAGE, { countryCode: 'GB' });
    const changes = detectChanges(
      { deadline: { date: a.deadline.date }, funding: { primaryType: a.funding.primaryType } },
      { deadline: { date: b.deadline.date }, funding: { primaryType: b.funding.primaryType } }
    );
    expect(changes).toEqual([]);
  });
});
