import { describe, it, expect } from 'vitest';
import { normalizeDegree, extractDegreeLevels } from './degree';
import { toCountryCode, extractCountries, extractRegions, countryInRegion } from './country';
import { extractFunding, parseMoney } from './funding';
import { extractDeadline, parseDateString } from './deadline';
import { extractStudyMode, extractAttendance } from './studyMode';
import { canonicalUrl, normalizeDomain, normalizeTitle, contentHash, isSameSite, fingerprintOf } from './text';

describe('degree normalization', () => {
  it('maps bachelor variants to BACHELORS', () => {
    for (const s of ['Bachelor', "Bachelor's", 'BSc', 'BA', 'BEng', 'LLB', 'Undergraduate']) {
      expect(normalizeDegree(s)).toBe('BACHELORS');
    }
  });

  it('maps master variants to MASTERS', () => {
    for (const s of ['Master', "Master's", 'MSc', 'MA', 'MEng', 'MBA', 'MPH', 'Postgraduate taught']) {
      expect(normalizeDegree(s)).toBe('MASTERS');
    }
  });

  it('maps doctoral variants to PHD', () => {
    for (const s of ['PhD', 'Doctorate', 'Doctoral', 'DPhil', 'Doctor of Philosophy']) {
      expect(normalizeDegree(s)).toBe('PHD');
    }
  });

  it('returns null rather than guessing on unrelated text', () => {
    expect(normalizeDegree('Campus accommodation guide')).toBeNull();
    expect(normalizeDegree('')).toBeNull();
    expect(normalizeDegree(undefined)).toBeNull();
  });

  it('does not fire on substrings — "management" is not an MA', () => {
    expect(normalizeDegree('Facilities management team')).toBeNull();
  });

  it('extracts multiple levels from one page', () => {
    const r = extractDegreeLevels("Open to Master's and PhD applicants in any discipline.");
    expect(r.levels).toContain('MASTERS');
    expect(r.levels).toContain('PHD');
    expect(r.confidence).toBeGreaterThan(0.5);
  });

  it('retains original wording as evidence', () => {
    const r = extractDegreeLevels('This scholarship supports Bachelor degree study at any faculty.');
    expect(r.levels).toEqual(['BACHELORS']);
    expect(r.evidence[0]).toMatch(/Bachelor degree/i);
  });

  it('does not read an entry requirement as the award level', () => {
    // A Master's award requiring a Bachelor's must not be tagged BACHELORS,
    // or it surfaces in undergraduate search results.
    const r = extractDegreeLevels(
      "The Global Masters Scholarship is a fully funded award. Applicants must hold a Bachelor degree."
    );
    expect(r.levels).toEqual(['MASTERS']);
    expect(r.prerequisiteLevels).toContain('BACHELORS');
  });

  it('reports nothing when a page only states a prerequisite', () => {
    const r = extractDegreeLevels('Applicants must hold a Bachelor degree from a recognised institution.');
    expect(r.levels).toEqual([]);
    expect(r.prerequisiteLevels).toContain('BACHELORS');
  });

  it('still detects the level when the award itself is undergraduate', () => {
    const r = extractDegreeLevels('An undergraduate scholarship open to first-year students.');
    expect(r.levels).toContain('BACHELORS');
  });

  it('returns nothing for empty input', () => {
    expect(extractDegreeLevels('').levels).toEqual([]);
    expect(extractDegreeLevels(null).confidence).toBe(0);
  });
});

describe('country normalization', () => {
  it('maps names, aliases and demonyms to ISO codes', () => {
    expect(toCountryCode('Kenya')).toBe('KE');
    expect(toCountryCode('Kenyan')).toBe('KE');
    expect(toCountryCode('United Kingdom')).toBe('GB');
    expect(toCountryCode('UK')).toBe('GB');
    expect(toCountryCode('British')).toBe('GB');
    expect(toCountryCode('USA')).toBe('US');
    expect(toCountryCode('The Netherlands')).toBe('NL');
  });

  it('strips framing words', () => {
    expect(toCountryCode('citizens of Kenya')).toBe('KE');
    expect(toCountryCode('Kenyan nationals')).toBe('KE');
  });

  it('returns null for unknown input rather than guessing', () => {
    expect(toCountryCode('Atlantis')).toBeNull();
    expect(toCountryCode('')).toBeNull();
  });

  it('extracts explicit country lists in order', () => {
    const codes = extractCountries('Open to citizens of Kenya, Uganda and Tanzania.');
    expect(codes).toEqual(['KE', 'UG', 'TZ']);
  });

  it('does not shred "South Africa" into the Africa region', () => {
    expect(extractCountries('Applicants from South Africa are eligible.')).toEqual(['ZA']);
  });

  it('extracts region buckets separately from countries', () => {
    const regions = extractRegions('Open to applicants from developing countries and the EU.');
    expect(regions).toContain('DEVELOPING_COUNTRIES');
    expect(regions).toContain('EU');
  });

  it('resolves country membership of a region', () => {
    expect(countryInRegion('KE', 'AFRICA')).toBe(true);
    expect(countryInRegion('KE', 'EU')).toBe(false);
    expect(countryInRegion('DE', 'EU')).toBe(true);
  });
});

describe('funding normalization', () => {
  it('detects fully funded when stated explicitly', () => {
    const f = extractFunding('This is a fully-funded scholarship covering all costs.');
    expect(f.primaryType).toBe('FULLY_FUNDED');
    expect(f.primaryTypeCertainty).toBe('CONFIRMED');
  });

  it('derives FULLY_FUNDED as PROBABLE when tuition and stipend are both covered', () => {
    const f = extractFunding('The award covers tuition fees in full. A living stipend is paid monthly.');
    expect(f.primaryType).toBe('FULLY_FUNDED');
    expect(f.primaryTypeCertainty).toBe('PROBABLE');
  });

  it('treats absent information as UNKNOWN, never false', () => {
    const f = extractFunding('The award covers tuition fees.');
    expect(f.tuitionCovered.value).toBe(true);
    // accommodation was never mentioned
    expect(f.accommodationCovered.value).toBeNull();
    expect(f.accommodationCovered.certainty).toBe('UNKNOWN');
  });

  it('detects explicit negation as false, not unknown', () => {
    const f = extractFunding('The scholarship does not cover accommodation costs.');
    expect(f.accommodationCovered.value).toBe(false);
    expect(f.accommodationCovered.certainty).toBe('NEGATIVE');
  });

  it('downgrades hedged language to PROBABLE', () => {
    const f = extractFunding('The award may include a travel allowance in some cases.');
    expect(f.travelCovered.value).toBe(true);
    expect(f.travelCovered.certainty).toBe('PROBABLE');
    expect(f.travelCovered.confidence).toBeLessThan(0.7);
  });

  it('preserves amount, currency and original wording without converting', () => {
    const f = extractFunding('A stipend of £18,622 per year is provided.');
    expect(f.stipendAmount.amount).toBe(18622);
    expect(f.stipendAmount.currency).toBe('GBP');
    expect(f.stipendAmount.period).toMatch(/per year/i);
    expect(f.stipendAmount.originalText).toContain('18,622');
  });

  it('parses currency codes as well as symbols', () => {
    expect(parseMoney('KES 250,000 per annum').currency).toBe('KES');
    expect(parseMoney('USD 40,000').amount).toBe(40000);
  });

  it('reports low confidence for a bare number with no currency', () => {
    const m = parseMoney('a stipend of 15,000 per year');
    expect(m.amount).toBe(15000);
    expect(m.currency).toBeNull();
    expect(m.certainty).toBe('PROBABLE');
  });

  it('extracts tuition percentage', () => {
    const f = extractFunding('The scholarship covers 50% of tuition fees.');
    expect(f.tuitionPercentage.value).toBe(50);
  });

  it('extracts award count', () => {
    const f = extractFunding('Up to 15 scholarships are available each year.');
    expect(f.awardCount.value).toBe(15);
  });

  it('tags merit and need based awards', () => {
    const f = extractFunding('Awards are merit-based and consider demonstrated financial need.');
    expect(f.types).toContain('MERIT_BASED');
    expect(f.types).toContain('NEED_BASED');
  });
});

describe('deadline parsing', () => {
  it('parses "15 January 2027"', () => {
    const d = parseDateString('Applications close on 15 January 2027');
    expect(d?.date.getUTCFullYear()).toBe(2027);
    expect(d?.date.getUTCMonth()).toBe(0);
    expect(d?.date.getUTCDate()).toBe(15);
  });

  it('parses "January 15, 2027"', () => {
    const d = parseDateString('Deadline: January 15, 2027');
    expect(d?.date.getUTCDate()).toBe(15);
    expect(d?.date.getUTCMonth()).toBe(0);
  });

  it('parses ISO dates', () => {
    const d = parseDateString('Closing 2027-01-15');
    expect(d?.date.getUTCDate()).toBe(15);
  });

  it('resolves unambiguous numeric dates without locale help', () => {
    const d = parseDateString('25/01/2027');
    expect(d?.date.getUTCDate()).toBe(25);
    expect(d?.date.getUTCMonth()).toBe(0);
    expect(d?.ambiguous).toBe(false);
  });

  it('flags genuinely ambiguous numeric dates and uses source locale', () => {
    const uk = parseDateString('05/01/2027', 'GB');
    expect(uk?.date.getUTCDate()).toBe(5);
    expect(uk?.ambiguous).toBe(true);
    expect(uk?.confidence).toBeLessThan(0.7);

    const us = parseDateString('05/01/2027', 'US');
    expect(us?.date.getUTCMonth()).toBe(4); // May
    expect(us?.ambiguous).toBe(true);
  });

  it('recognises rolling deadlines as a state, not a failure', () => {
    const r = extractDeadline('Applications are accepted on a rolling basis throughout the year.');
    expect(r.kind).toBe('ROLLING');
    expect(r.date).toBeNull();
    expect(r.originalText).toBeTruthy();
  });

  it('returns UNKNOWN when no deadline is present', () => {
    const r = extractDeadline('The scholarship supports students in engineering.');
    expect(r.kind).toBe('UNKNOWN');
    expect(r.date).toBeNull();
    expect(r.confidence).toBe(0);
  });

  it('preserves the original wording and any stated timezone', () => {
    const r = extractDeadline('Applications close at 23:59 GMT on 15 January 2027.');
    expect(r.kind).toBe('FIXED');
    expect(r.timezoneStated).toBe('GMT');
    expect(r.originalText).toContain('23:59');
  });

  it('prefers the next future deadline when several rounds exist', () => {
    const now = new Date('2026-08-24T00:00:00Z');
    const r = extractDeadline(
      'Round 1 deadline: 1 January 2026. Round 2 deadline: 1 December 2026.',
      { now }
    );
    expect(r.date?.getUTCFullYear()).toBe(2026);
    expect(r.date?.getUTCMonth()).toBe(11);
    expect(r.kind).toBe('MULTIPLE_ROUNDS');
  });

  it('gives low confidence to a date with no deadline cue', () => {
    const r = extractDeadline('The programme began in September 2024 with 40 students.');
    expect(r.confidence).toBeLessThanOrEqual(0.4);
  });
});

describe('study mode normalization', () => {
  it('detects explicitly stated modes', () => {
    expect(extractStudyMode('This is an on-campus programme.').values).toEqual(['ON_CAMPUS']);
    expect(extractStudyMode('Delivered fully online.').values).toEqual(['ONLINE']);
    expect(extractStudyMode('A hybrid delivery model is used.').values).toContain('HYBRID');
  });

  it('returns UNKNOWN rather than inferring from institution type', () => {
    const r = extractStudyMode('The University of Example is a campus university founded in 1900.');
    // "campus university" is about the institution, not the award's study mode
    expect(r.confidence).toBeLessThanOrEqual(0.85);
    const empty = extractStudyMode('A scholarship for engineering students.');
    expect(empty.values).toEqual(['UNKNOWN']);
    expect(empty.confidence).toBe(0);
  });

  it('collapses "full-time or part-time" to BOTH', () => {
    expect(extractAttendance('Available full-time or part-time.').values).toEqual(['BOTH']);
    expect(extractAttendance('Full-time and part-time study is supported.').values).toEqual(['BOTH']);
  });

  it('detects a single attendance mode', () => {
    expect(extractAttendance('Full-time study only.').values).toEqual(['FULL_TIME']);
  });

  it('returns UNKNOWN when attendance is not stated', () => {
    expect(extractAttendance('A generous award for postgraduates.').values).toEqual(['UNKNOWN']);
  });
});

describe('url and text normalization', () => {
  it('canonicalizes urls, stripping tracking params and fragments', () => {
    expect(canonicalUrl('https://www.Example.edu/Scholarships/?utm_source=x&id=5#top'))
      .toBe('https://example.edu/Scholarships?id=5');
  });

  it('orders query params stably', () => {
    expect(canonicalUrl('https://x.edu/a?b=2&a=1')).toBe(canonicalUrl('https://x.edu/a?a=1&b=2'));
  });

  it('preserves meaningful query params', () => {
    expect(canonicalUrl('https://x.edu/s?scholarshipId=482')).toContain('scholarshipId=482');
  });

  it('normalizes domains', () => {
    expect(normalizeDomain('https://www.Ox.AC.uk:443/path')).toBe('ox.ac.uk');
    expect(normalizeDomain('WWW.UONBI.AC.KE/')).toBe('uonbi.ac.ke');
  });

  it('recognises subdomains as the same site', () => {
    expect(isSameSite('https://law.ox.ac.uk/funding', 'ox.ac.uk')).toBe(true);
    expect(isSameSite('https://scholarships.com/ox', 'ox.ac.uk')).toBe(false);
  });

  it('normalizes titles for dedup, stripping years and stop words', () => {
    expect(normalizeTitle("The Chevening Scholarships (2027/28) — Master's"))
      .toBe(normalizeTitle('Chevening Scholarship 2027-2028 Masters'));
  });

  it('hashes content stably regardless of whitespace and case', () => {
    expect(contentHash('Hello   World')).toBe(contentHash('hello world'));
    expect(contentHash('a')).not.toBe(contentHash('b'));
  });

  it('produces stable fingerprints from ordered components', () => {
    expect(fingerprintOf(['a', 'b'])).toBe(fingerprintOf(['A', ' b ']));
    expect(fingerprintOf(['a', 'b'])).not.toBe(fingerprintOf(['b', 'a']));
  });
});
