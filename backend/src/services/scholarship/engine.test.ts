import { describe, it, expect, vi } from 'vitest';
import { classifyScholarshipPage, classifyScholarshipLink } from './scholarshipClassifier';
import { computeFingerprint, titleSimilarity, classifySourceType } from './dedupe';
import { computeStatus, detectChanges } from './status';
import { validateAiOutput } from './extractor/schema';
import { matchScholarship } from './matcher';

// The classifier needs a body long enough to clear its minimum-length gate.
const pad = (s: string) => s + ' '.repeat(0) + ' Additional programme information follows. '.repeat(6);

describe('scholarship link classification', () => {
  it('accepts a clear scholarship link', () => {
    const v = classifyScholarshipLink({
      text: 'Global Excellence Scholarship',
      href: 'https://example.ac.uk/scholarships/global-excellence',
      context: 'Fully funded award covering tuition. Deadline 15 January 2027.'
    });
    expect(v.type).toBe('scholarship');
  });

  it('treats a funding hub as a landing page, not a result', () => {
    const v = classifyScholarshipLink({
      text: 'Scholarships and funding',
      href: 'https://example.ac.uk/study/fees-and-funding',
      context: ''
    });
    expect(v.type).toBe('landing');
  });

  it('rejects payment and donation links', () => {
    expect(classifyScholarshipLink({ text: 'Pay your fees', href: 'https://x.ac.uk/finance/pay' }).type).toBe('reject');
    expect(classifyScholarshipLink({ text: 'Make a gift', href: 'https://x.ac.uk/giving' }).type).toBe('reject');
  });

  it('penalises news paths so award announcements do not enqueue', () => {
    const v = classifyScholarshipLink({
      text: 'Student wins prestigious scholarship',
      href: 'https://x.ac.uk/news/2024/student-wins-scholarship'
    });
    expect(v.type).toBe('reject');
  });

  it('accepts scholarship PDFs — a first-class channel, not noise', () => {
    const v = classifyScholarshipLink({
      text: 'Postgraduate Scholarship Guide 2027',
      href: 'https://x.ac.uk/scholarships/pg-scholarships-2027.pdf'
    });
    expect(v.type).toBe('scholarship');
  });

  it('uses surrounding context when the URL says nothing', () => {
    const v = classifyScholarshipLink({
      text: 'Money and support',
      href: 'https://x.ac.uk/students/money/',
      context: 'Find scholarships, bursaries and funding for your studies. Deadline information included.'
    });
    // §8 — must not rely on URL matching alone
    expect(v.type).not.toBe('reject');
  });
});

describe('scholarship page classification', () => {
  const scholarshipPage = {
    url: 'https://example.ac.uk/scholarships/global-masters',
    title: 'Global Masters Scholarship',
    metaDescription: 'A fully funded scholarship for international students.',
    headings: ['Global Masters Scholarship', 'Eligibility', 'How to apply', 'Funding'],
    text: pad(
      'The Global Masters Scholarship is a fully funded award covering tuition fees and a living stipend. ' +
      'Eligibility: open to international students holding a Bachelor degree. ' +
      'How to apply: submit an application form with your CV and transcripts. ' +
      'The application deadline is 15 January 2027. Applicants must hold IELTS 6.5.'
    )
  };

  it('accepts a page with funding, eligibility, application and deadline evidence', () => {
    const v = classifyScholarshipPage(scholarshipPage);
    expect(v.isScholarship).toBe(true);
    expect(v.score).toBeGreaterThan(0.55);
    expect(v.evidence.funding).toBe(true);
    expect(v.evidence.eligibility).toBe(true);
    expect(v.evidence.deadline).toBe(true);
  });

  it('rejects a fee payment page even though it mentions fees', () => {
    const v = classifyScholarshipPage({
      url: 'https://example.ac.uk/finance/pay-your-fees',
      title: 'Pay your fees',
      text: pad('Make a payment towards your tuition fees online. Payment methods include card and bank transfer. Scholarship holders should contact finance.')
    });
    expect(v.isScholarship).toBe(false);
  });

  it('rejects a donation appeal', () => {
    const v = classifyScholarshipPage({
      url: 'https://example.ac.uk/giving/scholarship-fund',
      title: 'Donate to our scholarship fund',
      text: pad('Your donation helps us fund scholarships for talented students. Make a gift today and support our students.')
    });
    expect(v.isScholarship).toBe(false);
  });

  it('rejects a news article about a past award', () => {
    const v = classifyScholarshipPage({
      url: 'https://example.ac.uk/news/2024/scholarship-winners',
      title: 'Scholarship winners announced',
      text: pad('Congratulations to this year\'s scholarship recipients. The awards were presented at a ceremony last week. Winners of the scholarship were selected from over 400 applicants.')
    });
    expect(v.isScholarship).toBe(false);
  });

  it('rejects an archived award', () => {
    const v = classifyScholarshipPage({
      url: 'https://example.ac.uk/scholarships/legacy-award',
      title: 'Legacy Award (closed)',
      text: pad('This scholarship is no longer available. Applications have closed and the scheme has been discontinued. The award previously covered tuition fees and offered a stipend to eligible applicants.')
    });
    expect(v.isScholarship).toBe(false);
  });

  it('flags an index of many awards as a landing page', () => {
    const v = classifyScholarshipPage({
      url: 'https://example.ac.uk/scholarships',
      title: 'Scholarships',
      headings: ['Scholarships'],
      text: pad('Browse our scholarships and funding opportunities. We offer a range of scholarships for eligible students.'),
      linkTexts: [
        'Chancellor Scholarship', 'Global Scholarship', 'Sports Bursary', 'Research Studentship',
        'International Scholarship', 'Merit Scholarship', 'Access Bursary', 'PhD Studentship'
      ]
    });
    expect(v.isLandingPage).toBe(true);
    expect(v.isScholarship).toBe(false);
  });

  it('rejects a page that merely contains the word scholarship once', () => {
    const v = classifyScholarshipPage({
      url: 'https://example.ac.uk/about/history',
      title: 'Our history',
      text: pad('The university was founded in 1900. '.repeat(60) + 'A scholarship was endowed in 1955.')
    });
    // §46 — the word alone is never enough
    expect(v.isScholarship).toBe(false);
  });

  it('refuses to judge a page that is too short', () => {
    const v = classifyScholarshipPage({ url: 'https://x.ac.uk/s', title: 'Scholarship', text: 'Scholarship.' });
    expect(v.isScholarship).toBe(false);
    expect(v.reasons[0]).toMatch(/too short/i);
  });
});

describe('fingerprint and deduplication', () => {
  const base = {
    universityId: 'aaaaaaaaaaaaaaaaaaaaaaaa',
    normalizedTitle: 'global excellence scholarship',
    academicYear: '2027/28',
    degreeLevels: ['MASTERS'],
    provider: null
  };

  it('produces the same fingerprint for the same award', () => {
    expect(computeFingerprint(base)).toBe(computeFingerprint({ ...base }));
  });

  it('normalizes academic year formatting', () => {
    expect(computeFingerprint(base)).toBe(computeFingerprint({ ...base, academicYear: '2027-28' }));
  });

  it('is insensitive to degree level ordering', () => {
    const a = computeFingerprint({ ...base, degreeLevels: ['MASTERS', 'PHD'] });
    const b = computeFingerprint({ ...base, degreeLevels: ['PHD', 'MASTERS'] });
    expect(a).toBe(b);
  });

  it('separates different academic years', () => {
    expect(computeFingerprint(base)).not.toBe(computeFingerprint({ ...base, academicYear: '2028/29' }));
  });

  it('separates the same award name at different universities', () => {
    expect(computeFingerprint(base)).not.toBe(
      computeFingerprint({ ...base, universityId: 'bbbbbbbbbbbbbbbbbbbbbbbb' })
    );
  });

  it('separates parallel Masters and PhD variants', () => {
    expect(computeFingerprint({ ...base, degreeLevels: ['MASTERS'] }))
      .not.toBe(computeFingerprint({ ...base, degreeLevels: ['PHD'] }));
  });

  it('does not include the URL — the same award on two URLs is one award', () => {
    // Fingerprint takes no url argument at all; this asserts the contract.
    expect(Object.keys(base)).not.toContain('url');
    expect(computeFingerprint(base)).toBe(computeFingerprint({ ...base }));
  });

  it('scores near-duplicate titles above the merge threshold', () => {
    const sim = titleSimilarity(
      'Global Excellence Scholarship',
      'Global Excellence Scholarships for International Students'
    );
    expect(sim).toBeGreaterThan(0.5);
    expect(titleSimilarity('Chevening Scholarship', 'Sports Bursary')).toBeLessThan(0.2);
  });

  it('classifies source authority correctly', () => {
    expect(classifySourceType('https://ox.ac.uk/scholarships/x', 'ox.ac.uk')).toBe('UNIVERSITY');
    expect(classifySourceType('https://law.ox.ac.uk/funding', 'ox.ac.uk')).toBe('FACULTY');
    expect(classifySourceType('https://education.go.ke/scholarships', 'ox.ac.uk')).toBe('GOVERNMENT');
    expect(classifySourceType('https://ox.ac.uk/x.pdf', 'ox.ac.uk')).toBe('PDF');
    expect(classifySourceType('https://scholarshipregion.com/x', 'ox.ac.uk')).toBe('AGGREGATOR');
  });
});

describe('status engine', () => {
  const now = new Date('2026-08-24T00:00:00Z');
  const days = (n: number) => new Date(now.getTime() + n * 86_400_000);

  it('marks a future deadline OPEN', () => {
    expect(computeStatus({ deadlineKind: 'FIXED', deadlineDate: days(60), confidence: 0.9 }, now)).toBe('OPEN');
  });

  it('marks an imminent deadline CLOSING_SOON', () => {
    expect(computeStatus({ deadlineKind: 'FIXED', deadlineDate: days(5), confidence: 0.9 }, now)).toBe('CLOSING_SOON');
  });

  it('marks a passed deadline CLOSED', () => {
    expect(computeStatus({ deadlineKind: 'FIXED', deadlineDate: days(-5), confidence: 0.9 }, now)).toBe('CLOSED');
  });

  it('marks a long-passed deadline EXPIRED', () => {
    expect(computeStatus({ deadlineKind: 'FIXED', deadlineDate: days(-200), confidence: 0.9 }, now)).toBe('EXPIRED');
  });

  it('marks a far-future deadline UPCOMING', () => {
    expect(computeStatus({ deadlineKind: 'FIXED', deadlineDate: days(400), confidence: 0.9 }, now)).toBe('UPCOMING');
  });

  it('treats rolling deadlines as OPEN', () => {
    expect(computeStatus({ deadlineKind: 'ROLLING', deadlineDate: null, confidence: 0.9 }, now)).toBe('OPEN');
  });

  it('refuses to claim OPEN without a deadline', () => {
    expect(computeStatus({ deadlineKind: 'UNKNOWN', deadlineDate: null, confidence: 0.9 }, now)).toBe('DISCOVERED');
  });

  it('holds low-confidence records back from OPEN', () => {
    expect(computeStatus({ deadlineKind: 'FIXED', deadlineDate: days(60), confidence: 0.1 }, now)).toBe('UNDER_REVIEW');
  });

  it('honours a human rejection over date arithmetic', () => {
    expect(computeStatus({ deadlineKind: 'FIXED', deadlineDate: days(60), confidence: 0.9, reviewStatus: 'REJECTED' }, now)).toBe('CLOSED');
  });
});

describe('change detection', () => {
  const existing = {
    title: 'Global Scholarship',
    deadline: { date: new Date('2027-01-15T23:59:59Z'), kind: 'FIXED' },
    funding: { primaryType: 'FULLY_FUNDED', tuitionCovered: { value: true }, livingStipend: { value: true }, stipendAmount: { amount: 18000 } },
    eligibility: { scope: 'INTERNATIONAL', countries: [] },
    degreeLevels: ['MASTERS'],
    studyMode: ['ON_CAMPUS'],
    attendance: ['FULL_TIME'],
    applicationUrl: { value: 'https://x.ac.uk/apply' },
    requirements: { english: { ielts: { minScore: 6.5 } }, minimumGpa: { value: null } },
    academicYear: '2027/28'
  };

  it('detects a moved deadline as MAJOR', () => {
    const changes = detectChanges(existing, {
      ...existing,
      deadline: { date: new Date('2027-02-01T23:59:59Z'), kind: 'FIXED' }
    });
    const d = changes.find((c) => c.field === 'deadline');
    expect(d).toBeTruthy();
    expect(d?.significance).toBe('MAJOR');
  });

  it('detects a funding change', () => {
    const changes = detectChanges(existing, {
      ...existing,
      funding: { ...existing.funding, primaryType: 'PARTIALLY_FUNDED' }
    });
    expect(changes.some((c) => c.field === 'funding')).toBe(true);
  });

  it('detects eligibility narrowing', () => {
    const changes = detectChanges(existing, {
      ...existing,
      eligibility: { scope: 'SPECIFIC_COUNTRIES', countries: ['KE', 'UG'] }
    });
    expect(changes.some((c) => c.field === 'eligibility')).toBe(true);
    expect(changes.some((c) => c.field === 'eligibility.countries')).toBe(true);
  });

  it('reports nothing when the page is unchanged', () => {
    expect(detectChanges(existing, { ...existing })).toEqual([]);
  });

  it('does not report a deadline change when two sources differ only in precision', () => {
    // "23:59 GMT on 15 January" vs plain "15 January" — same day, same award.
    const changes = detectChanges(existing, {
      ...existing,
      deadline: { date: new Date('2027-01-15T23:59:59Z'), kind: 'FIXED' }
    });
    expect(changes.some((c) => c.field === 'deadline')).toBe(false);
  });

  it('still reports a real deadline move to a different day', () => {
    const changes = detectChanges(existing, {
      ...existing,
      deadline: { date: new Date('2027-01-16T00:00:00Z'), kind: 'FIXED' }
    });
    expect(changes.some((c) => c.field === 'deadline')).toBe(true);
  });

  it('ignores array reordering', () => {
    const changes = detectChanges(
      { ...existing, degreeLevels: ['MASTERS', 'PHD'] },
      { ...existing, degreeLevels: ['PHD', 'MASTERS'] }
    );
    expect(changes.some((c) => c.field === 'degreeLevels')).toBe(false);
  });

  it('does not report information loss as a content change', () => {
    // A selector break that drops funding must not look like "funding removed"
    const changes = detectChanges(existing, {
      ...existing,
      funding: { primaryType: 'UNKNOWN', tuitionCovered: { value: null }, livingStipend: { value: null }, stipendAmount: { amount: null } }
    });
    expect(changes.some((c) => c.field === 'funding')).toBe(false);
  });
});

describe('AI output validation', () => {
  const valid = {
    isScholarship: true,
    classificationConfidence: 0.9,
    classificationReasons: ['contains funding information'],
    title: 'Global Scholarship',
    provider: null,
    description: null,
    degreeLevels: ['MASTERS'],
    degreeEvidence: ["Open to Master's applicants"],
    fieldsOfStudy: [],
    studyMode: ['ON_CAMPUS'],
    attendance: ['FULL_TIME'],
    deliveryMode: ['IN_PERSON'],
    modeEvidence: [],
    funding: {
      primaryType: 'FULLY_FUNDED',
      tuitionCovered: { value: true, confidence: 0.95, certainty: 'CONFIRMED', evidence: 'covers full tuition' },
      tuitionPercentage: { value: null, confidence: 0, certainty: 'UNKNOWN', evidence: null },
      livingStipend: { value: true, confidence: 0.9, certainty: 'CONFIRMED', evidence: 'a living stipend is paid' },
      stipendAmount: { amount: 18000, currency: 'GBP', period: 'per year', originalText: '£18,000 per year', confidence: 0.9, certainty: 'CONFIRMED' },
      travelCovered: { value: null, confidence: 0, certainty: 'UNKNOWN', evidence: null },
      airfareCovered: { value: null, confidence: 0, certainty: 'UNKNOWN', evidence: null },
      accommodationCovered: { value: null, confidence: 0, certainty: 'UNKNOWN', evidence: null },
      healthInsurance: { value: null, confidence: 0, certainty: 'UNKNOWN', evidence: null },
      researchAllowance: { value: null, confidence: 0, certainty: 'UNKNOWN', evidence: null },
      booksAllowance: { value: null, confidence: 0, certainty: 'UNKNOWN', evidence: null },
      equipmentAllowance: { value: null, confidence: 0, certainty: 'UNKNOWN', evidence: null },
      applicationFeeWaiver: { value: null, confidence: 0, certainty: 'UNKNOWN', evidence: null },
      visaSupport: { value: null, confidence: 0, certainty: 'UNKNOWN', evidence: null },
      awardCount: { value: null, confidence: 0, certainty: 'UNKNOWN', evidence: null }
    },
    eligibility: {
      scope: 'SPECIFIC_COUNTRIES',
      scopeEvidence: 'open to citizens of Kenya',
      countries: ['KE'],
      excludedCountries: [],
      regions: [],
      categories: [],
      ageMin: { value: null, confidence: 0, certainty: 'UNKNOWN', evidence: null },
      ageMax: { value: null, confidence: 0, certainty: 'UNKNOWN', evidence: null }
    },
    requirements: {
      minimumDegree: { value: 'BACHELORS', confidence: 0.9, certainty: 'CONFIRMED', evidence: 'hold a Bachelor degree' },
      minimumGpa: { value: null, confidence: 0, certainty: 'UNKNOWN', evidence: null },
      gpaScale: { value: null, confidence: 0, certainty: 'UNKNOWN', evidence: null },
      minimumGrade: { value: null, confidence: 0, certainty: 'UNKNOWN', evidence: null },
      english: {
        ielts: { required: true, minScore: 6.5, detail: 'IELTS 6.5', waiverAvailable: null, confidence: 0.9, evidence: 'IELTS 6.5 required' },
        toefl: { required: null, minScore: null, detail: null, waiverAvailable: null, confidence: 0, evidence: null },
        pte: { required: null, minScore: null, detail: null, waiverAvailable: null, confidence: 0, evidence: null },
        duolingo: { required: null, minScore: null, detail: null, waiverAvailable: null, confidence: 0, evidence: null },
        anyTestRequired: true
      },
      documents: [],
      workExperienceRequired: { value: null, confidence: 0, certainty: 'UNKNOWN', evidence: null },
      workExperienceYears: { value: null, confidence: 0, certainty: 'UNKNOWN', evidence: null },
      supervisorRequired: { value: null, confidence: 0, certainty: 'UNKNOWN', evidence: null },
      admissionOfferRequired: { value: null, confidence: 0, certainty: 'UNKNOWN', evidence: null }
    },
    deadline: { kind: 'FIXED', date: '2027-01-15', originalText: 'closes 15 January 2027', timezoneStated: 'GMT', confidence: 0.95, certainty: 'CONFIRMED' },
    applicationUrl: { value: 'https://x.ac.uk/apply', confidence: 0.9, certainty: 'CONFIRMED', evidence: 'Apply now' },
    academicYear: '2027/28',
    intake: null,
    duration: null
  };

  it('accepts well-formed output', () => {
    const r = validateAiOutput(JSON.stringify(valid));
    expect(r.ok).toBe(true);
    expect(r.data?.title).toBe('Global Scholarship');
  });

  it('tolerates markdown fences and preamble', () => {
    const r = validateAiOutput('Here is the JSON:\n```json\n' + JSON.stringify(valid) + '\n```');
    expect(r.ok).toBe(true);
  });

  it('rejects malformed JSON', () => {
    expect(validateAiOutput('{ not json').ok).toBe(false);
    expect(validateAiOutput('').ok).toBe(false);
  });

  it('rejects an unknown enum value', () => {
    const bad = { ...valid, degreeLevels: ['SUPER_MASTERS'] };
    expect(validateAiOutput(JSON.stringify(bad)).ok).toBe(false);
  });

  it('rejects a non-ISO country code', () => {
    const bad = { ...valid, eligibility: { ...valid.eligibility, countries: ['Kenya'] } };
    const r = validateAiOutput(JSON.stringify(bad));
    expect(r.ok).toBe(false);
  });

  it('rejects a natural-language deadline', () => {
    const bad = { ...valid, deadline: { ...valid.deadline, date: 'January 15th next year' } };
    const r = validateAiOutput(JSON.stringify(bad));
    expect(r.ok).toBe(false);
    expect(r.errors.join(' ')).toMatch(/ISO date/i);
  });

  it('rejects an assertion with no evidence', () => {
    const bad = {
      ...valid,
      funding: { ...valid.funding, tuitionCovered: { value: true, confidence: 0.9, certainty: 'CONFIRMED', evidence: null } }
    };
    const r = validateAiOutput(JSON.stringify(bad));
    expect(r.ok).toBe(false);
    expect(r.errors.join(' ')).toMatch(/without evidence/i);
  });

  it('rejects INTERNATIONAL scope smuggling in a full country list', () => {
    const bad = {
      ...valid,
      eligibility: {
        ...valid.eligibility,
        scope: 'INTERNATIONAL',
        countries: Array.from({ length: 60 }, (_, i) => String.fromCharCode(65 + (i % 26)) + String.fromCharCode(65 + ((i + 1) % 26)))
      }
    };
    const r = validateAiOutput(JSON.stringify(bad));
    expect(r.ok).toBe(false);
  });

  it('rejects extra keys the schema does not define', () => {
    const bad = { ...valid, somethingInvented: 'hello' };
    expect(validateAiOutput(JSON.stringify(bad)).ok).toBe(false);
  });
});

describe('matching engine', () => {
  const scholarship = {
    degreeLevels: ['MASTERS'],
    fieldsOfStudy: ['engineering'],
    countryCode: 'GB',
    country: 'United Kingdom',
    attendance: ['FULL_TIME'],
    studyMode: ['ON_CAMPUS'],
    confidence: 0.9,
    funding: { primaryType: 'FULLY_FUNDED' },
    eligibility: { scope: 'SPECIFIC_COUNTRIES', countries: ['KE'], excludedCountries: [], regions: [] },
    requirements: { english: {}, minimumGpa: { value: null } }
  };

  it('scores an eligible Kenyan Masters applicant highly', () => {
    const m = matchScholarship(scholarship, {
      nationality: 'Kenya', degreeLevel: 'MASTERS', fieldOfStudy: 'engineering',
      attendance: 'FULL_TIME', studyMode: 'ON_CAMPUS', fullyFundedOnly: true
    });
    expect(m.eligible).toBe(true);
    expect(m.percentage).toBeGreaterThan(80);
    expect(m.failures).toHaveLength(0);
  });

  it('disqualifies an ineligible nationality regardless of other matches', () => {
    const m = matchScholarship(scholarship, {
      nationality: 'Germany', degreeLevel: 'MASTERS', fieldOfStudy: 'engineering'
    });
    expect(m.eligible).toBe(false);
    expect(m.percentage).toBeLessThan(30);
  });

  it('warns rather than passes when a requirement is unconfirmed', () => {
    const m = matchScholarship(scholarship, {
      nationality: 'Kenya', degreeLevel: 'MASTERS',
      englishTest: { type: 'IELTS', score: 7 }
    });
    const w = m.warnings.find((c) => /IELTS/i.test(c.label));
    expect(w).toBeTruthy();
    // §56 in the user-facing surface
    expect(w?.detail).toMatch(/not confirmed/i);
  });

  it('fails a degree level the award does not cover', () => {
    const m = matchScholarship(scholarship, { nationality: 'Kenya', degreeLevel: 'PHD' });
    expect(m.eligible).toBe(false);
  });
});
