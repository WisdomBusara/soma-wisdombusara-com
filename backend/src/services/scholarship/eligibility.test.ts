import { describe, it, expect } from 'vitest';
import { extractEligibility, checkNationality } from './normalize/eligibility';
import { extractRequirements } from './normalize/requirements';

describe('eligibility extraction', () => {
  it('extracts an explicit country list', () => {
    const e = extractEligibility('This scholarship is open to citizens of Kenya, Uganda and Tanzania.');
    expect(e.scope).toBe('SPECIFIC_COUNTRIES');
    expect(e.countries).toEqual(['KE', 'UG', 'TZ']);
    expect(e.scopeCertainty).toBe('CONFIRMED');
  });

  it('does NOT expand "international students" into a country list', () => {
    const e = extractEligibility('The award is open to international students in any discipline.');
    expect(e.scope).toBe('INTERNATIONAL');
    // This is the §58 rule: international is a residency status, not 195 countries
    expect(e.countries).toEqual([]);
  });

  it('marks domestic-only awards', () => {
    const e = extractEligibility('Open to home students only. UK nationals may apply.');
    expect(e.scope).toBe('DOMESTIC');
  });

  it('recognises awards open to both', () => {
    const e = extractEligibility('We welcome applications from home and international students.');
    expect(e.scope).toBe('BOTH');
  });

  it('captures exclusions separately and removes them from the eligible list', () => {
    const e = extractEligibility(
      'Open to citizens of Kenya, Uganda and Nigeria. Applicants from Nigeria are not eligible this cycle.'
    );
    expect(e.excludedCountries).toContain('NG');
    expect(e.countries).not.toContain('NG');
    expect(e.countries).toContain('KE');
  });

  it('extracts regions when no specific countries are named', () => {
    const e = extractEligibility('Open to applicants from developing countries across Sub-Saharan Africa.');
    expect(e.regions).toContain('DEVELOPING_COUNTRIES');
    expect(e.developingCountriesOnly.value).toBe(true);
  });

  it('detects demographic categories', () => {
    const e = extractEligibility('This award supports women in STEM and applicants with a disability.');
    expect(e.categories).toContain('women_in_stem');
    expect(e.categories).toContain('disability');
  });

  it('extracts age limits when stated', () => {
    const e = extractEligibility('Applicants must be under 35 years old at the time of application.');
    expect(e.ageMax.value).toBe(35);
  });

  it('returns UNKNOWN when eligibility is not addressed', () => {
    const e = extractEligibility('The Faculty of Engineering was founded in 1962.');
    expect(e.scope).toBe('UNKNOWN');
    expect(e.countries).toEqual([]);
  });

  it('preserves verbatim eligibility sentences', () => {
    const e = extractEligibility('Eligibility: applicants must hold a first degree. Open to international students.');
    expect(e.rawEligibilityText.length).toBeGreaterThan(0);
    expect(e.rawEligibilityText.join(' ')).toMatch(/applicants must hold/i);
  });
});

describe('nationality matching', () => {
  const specific = { scope: 'SPECIFIC_COUNTRIES' as const, countries: ['KE', 'UG'], excludedCountries: [], regions: [] };
  const intl = { scope: 'INTERNATIONAL' as const, countries: [], excludedCountries: [], regions: [] };
  const region = { scope: 'SPECIFIC_REGIONS' as const, countries: [], excludedCountries: [], regions: ['AFRICA'] };

  it('confirms eligibility when the country is explicitly listed', () => {
    const r = checkNationality(specific, 'Kenya');
    expect(r.verdict).toBe('ELIGIBLE');
  });

  it('rules out a country absent from an explicit list', () => {
    const r = checkNationality(specific, 'Nigeria');
    expect(r.verdict).toBe('NOT_ELIGIBLE');
  });

  it('returns PROBABLY_ELIGIBLE for international scope — never a hard yes', () => {
    const r = checkNationality(intl, 'Kenya', 'GB');
    // §58 — "international students" does not confirm any specific nationality
    expect(r.verdict).toBe('PROBABLY_ELIGIBLE');
  });

  it('rules out the home country on an international-only award', () => {
    const r = checkNationality(intl, 'United Kingdom', 'GB');
    expect(r.verdict).toBe('NOT_ELIGIBLE');
  });

  it('resolves region membership', () => {
    expect(checkNationality(region, 'Kenya').verdict).toBe('ELIGIBLE');
    expect(checkNationality(region, 'Germany').verdict).toBe('NOT_ELIGIBLE');
  });

  it('honours exclusions over everything else', () => {
    const r = checkNationality({ ...intl, excludedCountries: ['KE'] }, 'Kenya', 'GB');
    expect(r.verdict).toBe('NOT_ELIGIBLE');
  });

  it('returns UNKNOWN when scope was never established', () => {
    const r = checkNationality({ scope: 'UNKNOWN', countries: [], excludedCountries: [], regions: [] }, 'Kenya');
    expect(r.verdict).toBe('UNKNOWN');
  });
});

describe('requirements extraction', () => {
  it('extracts IELTS with a minimum score', () => {
    const r = extractRequirements('Applicants require IELTS 6.5 overall with no band below 6.0.');
    expect(r.english.ielts.required).toBe(true);
    expect(r.english.ielts.minScore).toBe(6.5);
    expect(r.english.ielts.detail).toMatch(/no band below/i);
  });

  it('returns null — not false — when a test is never mentioned', () => {
    const r = extractRequirements('Applicants must hold a Bachelor degree.');
    // §56: unknown and false are different states
    expect(r.english.ielts.required).toBeNull();
    expect(r.english.toefl.required).toBeNull();
  });

  it('returns false only when the page explicitly waives the test', () => {
    const r = extractRequirements('No IELTS is required for applicants educated in English.');
    expect(r.english.ielts.required).toBe(false);
    expect(r.english.ielts.waiverAvailable).toBe(true);
  });

  it('extracts TOEFL on its own scale', () => {
    const r = extractRequirements('A TOEFL iBT score of 92 is required.');
    expect(r.english.toefl.required).toBe(true);
    expect(r.english.toefl.minScore).toBe(92);
  });

  it('extracts minimum degree and grade classification', () => {
    const r = extractRequirements(
      'Applicants must hold a Bachelor degree with a minimum of an upper second-class honours (2:1).'
    );
    expect(r.minimumDegree.value).toBe('BACHELORS');
    expect(r.minimumGrade.value).toMatch(/upper second|2:1/i);
  });

  it('extracts GPA with its scale', () => {
    const r = extractRequirements('A minimum GPA of 3.5 on a 4.0-point scale is required.');
    expect(r.minimumGpa.value).toBe(3.5);
    expect(r.gpaScale.value).toBe(4);
  });

  it('extracts required documents as structured items, not one blob', () => {
    const r = extractRequirements(
      'You must submit a CV, academic transcripts, a statement of purpose and two references.'
    );
    const codes = r.documents.map((d) => d.code);
    expect(codes).toContain('CV');
    expect(codes).toContain('TRANSCRIPT');
    expect(codes).toContain('STATEMENT_OF_PURPOSE');
    expect(codes).toContain('REFERENCES');
  });

  it('captures document counts where stated', () => {
    const r = extractRequirements('Please provide two recommendation letters with your application.');
    const refs = r.documents.find((d) => d.code === 'REFERENCES');
    expect(refs?.count).toBe(2);
  });

  it('extracts work experience requirements', () => {
    const r = extractRequirements('Applicants require at least 3 years of work experience.');
    expect(r.workExperienceRequired.value).toBe(true);
    expect(r.workExperienceYears.value).toBe(3);
  });

  it('detects explicit absence of a work experience requirement', () => {
    const r = extractRequirements('No prior work experience is required for this award.');
    expect(r.workExperienceRequired.value).toBe(false);
  });

  it('detects supervisor and admission-offer requirements', () => {
    const r = extractRequirements(
      'You must identify a supervisor before applying and hold an offer of admission.'
    );
    expect(r.supervisorRequired.value).toBe(true);
    expect(r.admissionOfferRequired.value).toBe(true);
  });

  it('preserves the exact source wording for every extracted requirement', () => {
    const r = extractRequirements('Applicants require IELTS 7.0 overall.');
    expect(r.english.ielts.sourceText).toContain('IELTS 7.0');
  });

  it('returns empty structures for text with no requirements', () => {
    const r = extractRequirements('The campus is located in central Nairobi.');
    expect(r.documents).toEqual([]);
    expect(r.minimumDegree.value).toBeNull();
    expect(r.english.anyTestRequired).toBeNull();
  });
});
