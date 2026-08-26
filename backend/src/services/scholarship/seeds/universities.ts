/**
 * Seed universities (§52).
 *
 * These are real, well-known institutions with their real primary domains.
 * They are a *bootstrap*, not the registry: the discovery providers grow the
 * registry from here, and every seed is still put through live domain
 * verification before it is promoted from UNVERIFIED to ACTIVE (§6). A seed
 * whose domain does not resolve stays UNVERIFIED and is never crawled.
 *
 * No scholarships are seeded. Scholarship records only ever come from an
 * actual crawl of an actual page.
 */

export interface UniversitySeed {
  name: string;
  domain: string;
  country: string;
  countryCode: string;
  city?: string;
  type?: 'PUBLIC' | 'PRIVATE' | 'OTHER';
}

export const UNIVERSITY_SEEDS: UniversitySeed[] = [
  // ── Kenya ─────────────────────────────────────────────────────────────────
  { name: 'University of Nairobi', domain: 'uonbi.ac.ke', country: 'Kenya', countryCode: 'KE', city: 'Nairobi', type: 'PUBLIC' },
  { name: 'Kenyatta University', domain: 'ku.ac.ke', country: 'Kenya', countryCode: 'KE', city: 'Nairobi', type: 'PUBLIC' },
  { name: 'Strathmore University', domain: 'strathmore.edu', country: 'Kenya', countryCode: 'KE', city: 'Nairobi', type: 'PRIVATE' },
  { name: 'Jomo Kenyatta University of Agriculture and Technology', domain: 'jkuat.ac.ke', country: 'Kenya', countryCode: 'KE', city: 'Juja', type: 'PUBLIC' },
  { name: 'Moi University', domain: 'mu.ac.ke', country: 'Kenya', countryCode: 'KE', city: 'Eldoret', type: 'PUBLIC' },
  { name: 'Egerton University', domain: 'egerton.ac.ke', country: 'Kenya', countryCode: 'KE', city: 'Nakuru', type: 'PUBLIC' },
  { name: 'United States International University Africa', domain: 'usiu.ac.ke', country: 'Kenya', countryCode: 'KE', city: 'Nairobi', type: 'PRIVATE' },
  { name: 'Technical University of Kenya', domain: 'tukenya.ac.ke', country: 'Kenya', countryCode: 'KE', city: 'Nairobi', type: 'PUBLIC' },

  // ── United Kingdom ────────────────────────────────────────────────────────
  { name: 'University of Oxford', domain: 'ox.ac.uk', country: 'United Kingdom', countryCode: 'GB', city: 'Oxford', type: 'PUBLIC' },
  { name: 'University of Cambridge', domain: 'cam.ac.uk', country: 'United Kingdom', countryCode: 'GB', city: 'Cambridge', type: 'PUBLIC' },
  { name: 'Imperial College London', domain: 'imperial.ac.uk', country: 'United Kingdom', countryCode: 'GB', city: 'London', type: 'PUBLIC' },
  { name: 'University College London', domain: 'ucl.ac.uk', country: 'United Kingdom', countryCode: 'GB', city: 'London', type: 'PUBLIC' },
  { name: 'University of Edinburgh', domain: 'ed.ac.uk', country: 'United Kingdom', countryCode: 'GB', city: 'Edinburgh', type: 'PUBLIC' },
  { name: 'University of Manchester', domain: 'manchester.ac.uk', country: 'United Kingdom', countryCode: 'GB', city: 'Manchester', type: 'PUBLIC' },
  { name: 'University of Glasgow', domain: 'gla.ac.uk', country: 'United Kingdom', countryCode: 'GB', city: 'Glasgow', type: 'PUBLIC' },
  { name: 'University of Leeds', domain: 'leeds.ac.uk', country: 'United Kingdom', countryCode: 'GB', city: 'Leeds', type: 'PUBLIC' },
  { name: 'University of Bristol', domain: 'bristol.ac.uk', country: 'United Kingdom', countryCode: 'GB', city: 'Bristol', type: 'PUBLIC' },
  { name: 'University of Warwick', domain: 'warwick.ac.uk', country: 'United Kingdom', countryCode: 'GB', city: 'Coventry', type: 'PUBLIC' },
  { name: 'University of Sheffield', domain: 'sheffield.ac.uk', country: 'United Kingdom', countryCode: 'GB', city: 'Sheffield', type: 'PUBLIC' },
  { name: 'University of Birmingham', domain: 'birmingham.ac.uk', country: 'United Kingdom', countryCode: 'GB', city: 'Birmingham', type: 'PUBLIC' },
  { name: 'University of Nottingham', domain: 'nottingham.ac.uk', country: 'United Kingdom', countryCode: 'GB', city: 'Nottingham', type: 'PUBLIC' },
  { name: 'University of Southampton', domain: 'southampton.ac.uk', country: 'United Kingdom', countryCode: 'GB', city: 'Southampton', type: 'PUBLIC' },
  { name: 'Durham University', domain: 'durham.ac.uk', country: 'United Kingdom', countryCode: 'GB', city: 'Durham', type: 'PUBLIC' },
  { name: 'London School of Economics and Political Science', domain: 'lse.ac.uk', country: 'United Kingdom', countryCode: 'GB', city: 'London', type: 'PUBLIC' },

  // ── United States ─────────────────────────────────────────────────────────
  { name: 'Harvard University', domain: 'harvard.edu', country: 'United States', countryCode: 'US', city: 'Cambridge', type: 'PRIVATE' },
  { name: 'Stanford University', domain: 'stanford.edu', country: 'United States', countryCode: 'US', city: 'Stanford', type: 'PRIVATE' },
  { name: 'Massachusetts Institute of Technology', domain: 'mit.edu', country: 'United States', countryCode: 'US', city: 'Cambridge', type: 'PRIVATE' },
  { name: 'Yale University', domain: 'yale.edu', country: 'United States', countryCode: 'US', city: 'New Haven', type: 'PRIVATE' },
  { name: 'Princeton University', domain: 'princeton.edu', country: 'United States', countryCode: 'US', city: 'Princeton', type: 'PRIVATE' },
  { name: 'Columbia University', domain: 'columbia.edu', country: 'United States', countryCode: 'US', city: 'New York', type: 'PRIVATE' },
  { name: 'University of California, Berkeley', domain: 'berkeley.edu', country: 'United States', countryCode: 'US', city: 'Berkeley', type: 'PUBLIC' },
  { name: 'University of Michigan', domain: 'umich.edu', country: 'United States', countryCode: 'US', city: 'Ann Arbor', type: 'PUBLIC' },
  { name: 'Cornell University', domain: 'cornell.edu', country: 'United States', countryCode: 'US', city: 'Ithaca', type: 'PRIVATE' },
  { name: 'University of Chicago', domain: 'uchicago.edu', country: 'United States', countryCode: 'US', city: 'Chicago', type: 'PRIVATE' },

  // ── Canada ────────────────────────────────────────────────────────────────
  { name: 'University of Toronto', domain: 'utoronto.ca', country: 'Canada', countryCode: 'CA', city: 'Toronto', type: 'PUBLIC' },
  { name: 'University of British Columbia', domain: 'ubc.ca', country: 'Canada', countryCode: 'CA', city: 'Vancouver', type: 'PUBLIC' },
  { name: 'McGill University', domain: 'mcgill.ca', country: 'Canada', countryCode: 'CA', city: 'Montreal', type: 'PUBLIC' },
  { name: 'University of Alberta', domain: 'ualberta.ca', country: 'Canada', countryCode: 'CA', city: 'Edmonton', type: 'PUBLIC' },
  { name: 'University of Waterloo', domain: 'uwaterloo.ca', country: 'Canada', countryCode: 'CA', city: 'Waterloo', type: 'PUBLIC' },

  // ── Australia & New Zealand ───────────────────────────────────────────────
  { name: 'University of Melbourne', domain: 'unimelb.edu.au', country: 'Australia', countryCode: 'AU', city: 'Melbourne', type: 'PUBLIC' },
  { name: 'University of Sydney', domain: 'sydney.edu.au', country: 'Australia', countryCode: 'AU', city: 'Sydney', type: 'PUBLIC' },
  { name: 'Australian National University', domain: 'anu.edu.au', country: 'Australia', countryCode: 'AU', city: 'Canberra', type: 'PUBLIC' },
  { name: 'University of Queensland', domain: 'uq.edu.au', country: 'Australia', countryCode: 'AU', city: 'Brisbane', type: 'PUBLIC' },
  { name: 'Monash University', domain: 'monash.edu', country: 'Australia', countryCode: 'AU', city: 'Melbourne', type: 'PUBLIC' },
  { name: 'University of Auckland', domain: 'auckland.ac.nz', country: 'New Zealand', countryCode: 'NZ', city: 'Auckland', type: 'PUBLIC' },
  { name: 'University of Otago', domain: 'otago.ac.nz', country: 'New Zealand', countryCode: 'NZ', city: 'Dunedin', type: 'PUBLIC' },

  // ── Germany ───────────────────────────────────────────────────────────────
  { name: 'Technical University of Munich', domain: 'tum.de', country: 'Germany', countryCode: 'DE', city: 'Munich', type: 'PUBLIC' },
  { name: 'Ludwig Maximilian University of Munich', domain: 'lmu.de', country: 'Germany', countryCode: 'DE', city: 'Munich', type: 'PUBLIC' },
  { name: 'Heidelberg University', domain: 'uni-heidelberg.de', country: 'Germany', countryCode: 'DE', city: 'Heidelberg', type: 'PUBLIC' },
  { name: 'RWTH Aachen University', domain: 'rwth-aachen.de', country: 'Germany', countryCode: 'DE', city: 'Aachen', type: 'PUBLIC' },
  { name: 'Humboldt University of Berlin', domain: 'hu-berlin.de', country: 'Germany', countryCode: 'DE', city: 'Berlin', type: 'PUBLIC' },

  // ── Netherlands ───────────────────────────────────────────────────────────
  { name: 'Delft University of Technology', domain: 'tudelft.nl', country: 'Netherlands', countryCode: 'NL', city: 'Delft', type: 'PUBLIC' },
  { name: 'University of Amsterdam', domain: 'uva.nl', country: 'Netherlands', countryCode: 'NL', city: 'Amsterdam', type: 'PUBLIC' },
  { name: 'Wageningen University & Research', domain: 'wur.nl', country: 'Netherlands', countryCode: 'NL', city: 'Wageningen', type: 'PUBLIC' },
  { name: 'Leiden University', domain: 'universiteitleiden.nl', country: 'Netherlands', countryCode: 'NL', city: 'Leiden', type: 'PUBLIC' },
  { name: 'Utrecht University', domain: 'uu.nl', country: 'Netherlands', countryCode: 'NL', city: 'Utrecht', type: 'PUBLIC' },

  // ── Ireland ───────────────────────────────────────────────────────────────
  { name: 'Trinity College Dublin', domain: 'tcd.ie', country: 'Ireland', countryCode: 'IE', city: 'Dublin', type: 'PUBLIC' },
  { name: 'University College Dublin', domain: 'ucd.ie', country: 'Ireland', countryCode: 'IE', city: 'Dublin', type: 'PUBLIC' },
  { name: 'University College Cork', domain: 'ucc.ie', country: 'Ireland', countryCode: 'IE', city: 'Cork', type: 'PUBLIC' },

  // ── Nordics ───────────────────────────────────────────────────────────────
  { name: 'Karolinska Institutet', domain: 'ki.se', country: 'Sweden', countryCode: 'SE', city: 'Stockholm', type: 'PUBLIC' },
  { name: 'Lund University', domain: 'lu.se', country: 'Sweden', countryCode: 'SE', city: 'Lund', type: 'PUBLIC' },
  { name: 'Uppsala University', domain: 'uu.se', country: 'Sweden', countryCode: 'SE', city: 'Uppsala', type: 'PUBLIC' },
  { name: 'KTH Royal Institute of Technology', domain: 'kth.se', country: 'Sweden', countryCode: 'SE', city: 'Stockholm', type: 'PUBLIC' },
  { name: 'University of Oslo', domain: 'uio.no', country: 'Norway', countryCode: 'NO', city: 'Oslo', type: 'PUBLIC' },
  { name: 'Norwegian University of Science and Technology', domain: 'ntnu.edu', country: 'Norway', countryCode: 'NO', city: 'Trondheim', type: 'PUBLIC' },
  { name: 'University of Helsinki', domain: 'helsinki.fi', country: 'Finland', countryCode: 'FI', city: 'Helsinki', type: 'PUBLIC' },
  { name: 'Aalto University', domain: 'aalto.fi', country: 'Finland', countryCode: 'FI', city: 'Espoo', type: 'PUBLIC' },
  { name: 'University of Copenhagen', domain: 'ku.dk', country: 'Denmark', countryCode: 'DK', city: 'Copenhagen', type: 'PUBLIC' },
  { name: 'Technical University of Denmark', domain: 'dtu.dk', country: 'Denmark', countryCode: 'DK', city: 'Lyngby', type: 'PUBLIC' },
  { name: 'Aarhus University', domain: 'au.dk', country: 'Denmark', countryCode: 'DK', city: 'Aarhus', type: 'PUBLIC' },

  // ── Asia ──────────────────────────────────────────────────────────────────
  { name: 'University of Tokyo', domain: 'u-tokyo.ac.jp', country: 'Japan', countryCode: 'JP', city: 'Tokyo', type: 'PUBLIC' },
  { name: 'Kyoto University', domain: 'kyoto-u.ac.jp', country: 'Japan', countryCode: 'JP', city: 'Kyoto', type: 'PUBLIC' },
  { name: 'Seoul National University', domain: 'snu.ac.kr', country: 'South Korea', countryCode: 'KR', city: 'Seoul', type: 'PUBLIC' },
  { name: 'KAIST', domain: 'kaist.ac.kr', country: 'South Korea', countryCode: 'KR', city: 'Daejeon', type: 'PUBLIC' },
  { name: 'Tsinghua University', domain: 'tsinghua.edu.cn', country: 'China', countryCode: 'CN', city: 'Beijing', type: 'PUBLIC' },
  { name: 'Peking University', domain: 'pku.edu.cn', country: 'China', countryCode: 'CN', city: 'Beijing', type: 'PUBLIC' },
  { name: 'National University of Singapore', domain: 'nus.edu.sg', country: 'Singapore', countryCode: 'SG', city: 'Singapore', type: 'PUBLIC' },
  { name: 'Nanyang Technological University', domain: 'ntu.edu.sg', country: 'Singapore', countryCode: 'SG', city: 'Singapore', type: 'PUBLIC' }
];

export function seedsForCountries(codes: string[]): UniversitySeed[] {
  const want = new Set(codes.map((c) => c.toUpperCase()));
  return UNIVERSITY_SEEDS.filter((s) => want.has(s.countryCode));
}
