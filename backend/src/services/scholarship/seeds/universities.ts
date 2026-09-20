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
  { name: 'Nanyang Technological University', domain: 'ntu.edu.sg', country: 'Singapore', countryCode: 'SG', city: 'Singapore', type: 'PUBLIC' },

  // ── Kenya (more) ──────────────────────────────────────────────────────────
  { name: 'Kenya Methodist University', domain: 'kemu.ac.ke', country: 'Kenya', countryCode: 'KE', city: 'Meru', type: 'PRIVATE' },
  { name: 'Kabarak University', domain: 'kabarak.ac.ke', country: 'Kenya', countryCode: 'KE', city: 'Nakuru', type: 'PRIVATE' },
  { name: 'Daystar University', domain: 'daystar.ac.ke', country: 'Kenya', countryCode: 'KE', city: 'Nairobi', type: 'PRIVATE' },
  { name: 'Catholic University of Eastern Africa', domain: 'cuea.edu', country: 'Kenya', countryCode: 'KE', city: 'Nairobi', type: 'PRIVATE' },
  { name: 'Africa Nazarene University', domain: 'anu.ac.ke', country: 'Kenya', countryCode: 'KE', city: 'Nairobi', type: 'PRIVATE' },
  { name: 'Multimedia University of Kenya', domain: 'mmu.ac.ke', country: 'Kenya', countryCode: 'KE', city: 'Nairobi', type: 'PUBLIC' },
  { name: 'Dedan Kimathi University of Technology', domain: 'dkut.ac.ke', country: 'Kenya', countryCode: 'KE', city: 'Nyeri', type: 'PUBLIC' },
  { name: 'Maseno University', domain: 'maseno.ac.ke', country: 'Kenya', countryCode: 'KE', city: 'Kisumu', type: 'PUBLIC' },
  { name: 'Masinde Muliro University of Science and Technology', domain: 'mmust.ac.ke', country: 'Kenya', countryCode: 'KE', city: 'Kakamega', type: 'PUBLIC' },
  { name: 'South Eastern Kenya University', domain: 'seku.ac.ke', country: 'Kenya', countryCode: 'KE', city: 'Kitui', type: 'PUBLIC' },
  { name: 'Pwani University', domain: 'pu.ac.ke', country: 'Kenya', countryCode: 'KE', city: 'Kilifi', type: 'PUBLIC' },
  { name: 'Kisii University', domain: 'kisiiuniversity.ac.ke', country: 'Kenya', countryCode: 'KE', city: 'Kisii', type: 'PUBLIC' },
  { name: 'Laikipia University', domain: 'laikipia.ac.ke', country: 'Kenya', countryCode: 'KE', city: 'Nyahururu', type: 'PUBLIC' },
  { name: 'Chuka University', domain: 'chuka.ac.ke', country: 'Kenya', countryCode: 'KE', city: 'Chuka', type: 'PUBLIC' },
  { name: 'Karatina University', domain: 'karu.ac.ke', country: 'Kenya', countryCode: 'KE', city: 'Karatina', type: 'PUBLIC' },
  { name: 'Machakos University', domain: 'mksu.ac.ke', country: 'Kenya', countryCode: 'KE', city: 'Machakos', type: 'PUBLIC' },
  { name: 'Meru University of Science and Technology', domain: 'must.ac.ke', country: 'Kenya', countryCode: 'KE', city: 'Meru', type: 'PUBLIC' },
  { name: "Murang'a University of Technology", domain: 'mut.ac.ke', country: 'Kenya', countryCode: 'KE', city: "Murang'a", type: 'PUBLIC' },
  { name: 'Taita Taveta University', domain: 'ttu.ac.ke', country: 'Kenya', countryCode: 'KE', city: 'Voi', type: 'PUBLIC' },
  { name: 'Technical University of Mombasa', domain: 'tum.ac.ke', country: 'Kenya', countryCode: 'KE', city: 'Mombasa', type: 'PUBLIC' },
  { name: 'Cooperative University of Kenya', domain: 'cuk.ac.ke', country: 'Kenya', countryCode: 'KE', city: 'Nairobi', type: 'PUBLIC' },
  { name: 'Kirinyaga University', domain: 'kyu.ac.ke', country: 'Kenya', countryCode: 'KE', city: 'Kerugoya', type: 'PUBLIC' },
  { name: 'Jaramogi Oginga Odinga University of Science and Technology', domain: 'jooust.ac.ke', country: 'Kenya', countryCode: 'KE', city: 'Bondo', type: 'PUBLIC' },
  { name: 'Riara University', domain: 'riarauniversity.ac.ke', country: 'Kenya', countryCode: 'KE', city: 'Nairobi', type: 'PRIVATE' },
  { name: 'KCA University', domain: 'kca.ac.ke', country: 'Kenya', countryCode: 'KE', city: 'Nairobi', type: 'PRIVATE' },
  { name: 'Mount Kenya University', domain: 'mku.ac.ke', country: 'Kenya', countryCode: 'KE', city: 'Thika', type: 'PRIVATE' },
  { name: 'Zetech University', domain: 'zetech.ac.ke', country: 'Kenya', countryCode: 'KE', city: 'Nairobi', type: 'PRIVATE' },

  // ── United Kingdom (more) ────────────────────────────────────────────────
  { name: "King's College London", domain: 'kcl.ac.uk', country: 'United Kingdom', countryCode: 'GB', city: 'London', type: 'PUBLIC' },
  { name: 'University of St Andrews', domain: 'st-andrews.ac.uk', country: 'United Kingdom', countryCode: 'GB', city: 'St Andrews', type: 'PUBLIC' },
  { name: 'University of York', domain: 'york.ac.uk', country: 'United Kingdom', countryCode: 'GB', city: 'York', type: 'PUBLIC' },
  { name: 'Queen Mary University of London', domain: 'qmul.ac.uk', country: 'United Kingdom', countryCode: 'GB', city: 'London', type: 'PUBLIC' },
  { name: 'University of Exeter', domain: 'exeter.ac.uk', country: 'United Kingdom', countryCode: 'GB', city: 'Exeter', type: 'PUBLIC' },
  { name: 'Cardiff University', domain: 'cardiff.ac.uk', country: 'United Kingdom', countryCode: 'GB', city: 'Cardiff', type: 'PUBLIC' },
  { name: "Queen's University Belfast", domain: 'qub.ac.uk', country: 'United Kingdom', countryCode: 'GB', city: 'Belfast', type: 'PUBLIC' },
  { name: 'University of Bath', domain: 'bath.ac.uk', country: 'United Kingdom', countryCode: 'GB', city: 'Bath', type: 'PUBLIC' },
  { name: 'Newcastle University', domain: 'ncl.ac.uk', country: 'United Kingdom', countryCode: 'GB', city: 'Newcastle', type: 'PUBLIC' },
  { name: 'Lancaster University', domain: 'lancaster.ac.uk', country: 'United Kingdom', countryCode: 'GB', city: 'Lancaster', type: 'PUBLIC' },

  // ── United States (more) ─────────────────────────────────────────────────
  { name: 'University of Pennsylvania', domain: 'upenn.edu', country: 'United States', countryCode: 'US', city: 'Philadelphia', type: 'PRIVATE' },
  { name: 'Duke University', domain: 'duke.edu', country: 'United States', countryCode: 'US', city: 'Durham', type: 'PRIVATE' },
  { name: 'Johns Hopkins University', domain: 'jhu.edu', country: 'United States', countryCode: 'US', city: 'Baltimore', type: 'PRIVATE' },
  { name: 'Northwestern University', domain: 'northwestern.edu', country: 'United States', countryCode: 'US', city: 'Evanston', type: 'PRIVATE' },
  { name: 'University of California, Los Angeles', domain: 'ucla.edu', country: 'United States', countryCode: 'US', city: 'Los Angeles', type: 'PUBLIC' },
  { name: 'New York University', domain: 'nyu.edu', country: 'United States', countryCode: 'US', city: 'New York', type: 'PRIVATE' },
  { name: 'University of Texas at Austin', domain: 'utexas.edu', country: 'United States', countryCode: 'US', city: 'Austin', type: 'PUBLIC' },
  { name: 'University of Washington', domain: 'washington.edu', country: 'United States', countryCode: 'US', city: 'Seattle', type: 'PUBLIC' },
  { name: 'Georgia Institute of Technology', domain: 'gatech.edu', country: 'United States', countryCode: 'US', city: 'Atlanta', type: 'PUBLIC' },
  { name: 'Carnegie Mellon University', domain: 'cmu.edu', country: 'United States', countryCode: 'US', city: 'Pittsburgh', type: 'PRIVATE' },
  { name: 'University of Wisconsin-Madison', domain: 'wisc.edu', country: 'United States', countryCode: 'US', city: 'Madison', type: 'PUBLIC' },
  { name: 'Boston University', domain: 'bu.edu', country: 'United States', countryCode: 'US', city: 'Boston', type: 'PRIVATE' },
  { name: 'Ohio State University', domain: 'osu.edu', country: 'United States', countryCode: 'US', city: 'Columbus', type: 'PUBLIC' },
  { name: 'Pennsylvania State University', domain: 'psu.edu', country: 'United States', countryCode: 'US', city: 'University Park', type: 'PUBLIC' },
  { name: 'Purdue University', domain: 'purdue.edu', country: 'United States', countryCode: 'US', city: 'West Lafayette', type: 'PUBLIC' },

  // ── Canada (more) ────────────────────────────────────────────────────────
  { name: 'University of Ottawa', domain: 'uottawa.ca', country: 'Canada', countryCode: 'CA', city: 'Ottawa', type: 'PUBLIC' },
  { name: "Queen's University", domain: 'queensu.ca', country: 'Canada', countryCode: 'CA', city: 'Kingston', type: 'PUBLIC' },
  { name: 'Simon Fraser University', domain: 'sfu.ca', country: 'Canada', countryCode: 'CA', city: 'Burnaby', type: 'PUBLIC' },
  { name: 'University of Calgary', domain: 'ucalgary.ca', country: 'Canada', countryCode: 'CA', city: 'Calgary', type: 'PUBLIC' },
  { name: 'Western University', domain: 'uwo.ca', country: 'Canada', countryCode: 'CA', city: 'London', type: 'PUBLIC' },

  // ── Australia (more) ─────────────────────────────────────────────────────
  { name: 'University of New South Wales', domain: 'unsw.edu.au', country: 'Australia', countryCode: 'AU', city: 'Sydney', type: 'PUBLIC' },
  { name: 'University of Western Australia', domain: 'uwa.edu.au', country: 'Australia', countryCode: 'AU', city: 'Perth', type: 'PUBLIC' },
  { name: 'University of Adelaide', domain: 'adelaide.edu.au', country: 'Australia', countryCode: 'AU', city: 'Adelaide', type: 'PUBLIC' },
  { name: 'Macquarie University', domain: 'mq.edu.au', country: 'Australia', countryCode: 'AU', city: 'Sydney', type: 'PUBLIC' },
  { name: 'RMIT University', domain: 'rmit.edu.au', country: 'Australia', countryCode: 'AU', city: 'Melbourne', type: 'PUBLIC' },

  // ── South Africa ─────────────────────────────────────────────────────────
  { name: 'University of Cape Town', domain: 'uct.ac.za', country: 'South Africa', countryCode: 'ZA', city: 'Cape Town', type: 'PUBLIC' },
  { name: 'University of the Witwatersrand', domain: 'wits.ac.za', country: 'South Africa', countryCode: 'ZA', city: 'Johannesburg', type: 'PUBLIC' },
  { name: 'Stellenbosch University', domain: 'sun.ac.za', country: 'South Africa', countryCode: 'ZA', city: 'Stellenbosch', type: 'PUBLIC' },
  { name: 'University of Pretoria', domain: 'up.ac.za', country: 'South Africa', countryCode: 'ZA', city: 'Pretoria', type: 'PUBLIC' },
  { name: 'Rhodes University', domain: 'ru.ac.za', country: 'South Africa', countryCode: 'ZA', city: 'Makhanda', type: 'PUBLIC' },
  { name: 'University of KwaZulu-Natal', domain: 'ukzn.ac.za', country: 'South Africa', countryCode: 'ZA', city: 'Durban', type: 'PUBLIC' },
  { name: 'University of Johannesburg', domain: 'uj.ac.za', country: 'South Africa', countryCode: 'ZA', city: 'Johannesburg', type: 'PUBLIC' },
  { name: 'North-West University', domain: 'nwu.ac.za', country: 'South Africa', countryCode: 'ZA', city: 'Potchefstroom', type: 'PUBLIC' },

  // ── Nigeria ──────────────────────────────────────────────────────────────
  { name: 'University of Lagos', domain: 'unilag.edu.ng', country: 'Nigeria', countryCode: 'NG', city: 'Lagos', type: 'PUBLIC' },
  { name: 'University of Ibadan', domain: 'ui.edu.ng', country: 'Nigeria', countryCode: 'NG', city: 'Ibadan', type: 'PUBLIC' },
  { name: 'Obafemi Awolowo University', domain: 'oauife.edu.ng', country: 'Nigeria', countryCode: 'NG', city: 'Ile-Ife', type: 'PUBLIC' },
  { name: 'Covenant University', domain: 'covenantuniversity.edu.ng', country: 'Nigeria', countryCode: 'NG', city: 'Ota', type: 'PRIVATE' },
  { name: 'Ahmadu Bello University', domain: 'abu.edu.ng', country: 'Nigeria', countryCode: 'NG', city: 'Zaria', type: 'PUBLIC' },
  { name: 'University of Nigeria, Nsukka', domain: 'unn.edu.ng', country: 'Nigeria', countryCode: 'NG', city: 'Nsukka', type: 'PUBLIC' },

  // ── Ghana ────────────────────────────────────────────────────────────────
  { name: 'University of Ghana', domain: 'ug.edu.gh', country: 'Ghana', countryCode: 'GH', city: 'Accra', type: 'PUBLIC' },
  { name: 'Kwame Nkrumah University of Science and Technology', domain: 'knust.edu.gh', country: 'Ghana', countryCode: 'GH', city: 'Kumasi', type: 'PUBLIC' },
  { name: 'Ashesi University', domain: 'ashesi.edu.gh', country: 'Ghana', countryCode: 'GH', city: 'Berekuso', type: 'PRIVATE' },

  // ── Uganda ───────────────────────────────────────────────────────────────
  { name: 'Makerere University', domain: 'mak.ac.ug', country: 'Uganda', countryCode: 'UG', city: 'Kampala', type: 'PUBLIC' },
  { name: 'Uganda Christian University', domain: 'ucu.ac.ug', country: 'Uganda', countryCode: 'UG', city: 'Mukono', type: 'PRIVATE' },
  { name: 'Kyambogo University', domain: 'kyu.ac.ug', country: 'Uganda', countryCode: 'UG', city: 'Kampala', type: 'PUBLIC' },

  // ── Tanzania ─────────────────────────────────────────────────────────────
  { name: 'University of Dar es Salaam', domain: 'udsm.ac.tz', country: 'Tanzania', countryCode: 'TZ', city: 'Dar es Salaam', type: 'PUBLIC' },
  { name: 'Sokoine University of Agriculture', domain: 'sua.ac.tz', country: 'Tanzania', countryCode: 'TZ', city: 'Morogoro', type: 'PUBLIC' },
  { name: 'Ardhi University', domain: 'aru.ac.tz', country: 'Tanzania', countryCode: 'TZ', city: 'Dar es Salaam', type: 'PUBLIC' },

  // ── France ───────────────────────────────────────────────────────────────
  { name: 'Sorbonne University', domain: 'sorbonne-universite.fr', country: 'France', countryCode: 'FR', city: 'Paris', type: 'PUBLIC' },
  { name: 'Sciences Po', domain: 'sciencespo.fr', country: 'France', countryCode: 'FR', city: 'Paris', type: 'PUBLIC' },
  { name: 'Université PSL', domain: 'psl.eu', country: 'France', countryCode: 'FR', city: 'Paris', type: 'PUBLIC' },
  { name: 'HEC Paris', domain: 'hec.edu', country: 'France', countryCode: 'FR', city: 'Jouy-en-Josas', type: 'PRIVATE' },
  { name: 'École Polytechnique', domain: 'polytechnique.edu', country: 'France', countryCode: 'FR', city: 'Palaiseau', type: 'PUBLIC' },

  // ── Switzerland ──────────────────────────────────────────────────────────
  { name: 'ETH Zurich', domain: 'ethz.ch', country: 'Switzerland', countryCode: 'CH', city: 'Zurich', type: 'PUBLIC' },
  { name: 'University of Zurich', domain: 'uzh.ch', country: 'Switzerland', countryCode: 'CH', city: 'Zurich', type: 'PUBLIC' },
  { name: 'EPFL', domain: 'epfl.ch', country: 'Switzerland', countryCode: 'CH', city: 'Lausanne', type: 'PUBLIC' },
  { name: 'University of Geneva', domain: 'unige.ch', country: 'Switzerland', countryCode: 'CH', city: 'Geneva', type: 'PUBLIC' },

  // ── Spain ────────────────────────────────────────────────────────────────
  { name: 'University of Barcelona', domain: 'ub.edu', country: 'Spain', countryCode: 'ES', city: 'Barcelona', type: 'PUBLIC' },
  { name: 'Complutense University of Madrid', domain: 'ucm.es', country: 'Spain', countryCode: 'ES', city: 'Madrid', type: 'PUBLIC' },
  { name: 'IE University', domain: 'ie.edu', country: 'Spain', countryCode: 'ES', city: 'Madrid', type: 'PRIVATE' },

  // ── Italy ────────────────────────────────────────────────────────────────
  { name: 'Sapienza University of Rome', domain: 'uniroma1.it', country: 'Italy', countryCode: 'IT', city: 'Rome', type: 'PUBLIC' },
  { name: 'Bocconi University', domain: 'unibocconi.it', country: 'Italy', countryCode: 'IT', city: 'Milan', type: 'PRIVATE' },
  { name: 'Politecnico di Milano', domain: 'polimi.it', country: 'Italy', countryCode: 'IT', city: 'Milan', type: 'PUBLIC' },

  // ── India ────────────────────────────────────────────────────────────────
  { name: 'Indian Institute of Technology Bombay', domain: 'iitb.ac.in', country: 'India', countryCode: 'IN', city: 'Mumbai', type: 'PUBLIC' },
  { name: 'Indian Institute of Technology Delhi', domain: 'iitd.ac.in', country: 'India', countryCode: 'IN', city: 'Delhi', type: 'PUBLIC' },
  { name: 'University of Delhi', domain: 'du.ac.in', country: 'India', countryCode: 'IN', city: 'Delhi', type: 'PUBLIC' },
  { name: 'Jawaharlal Nehru University', domain: 'jnu.ac.in', country: 'India', countryCode: 'IN', city: 'Delhi', type: 'PUBLIC' },
  { name: 'Indian Institute of Science', domain: 'iisc.ac.in', country: 'India', countryCode: 'IN', city: 'Bangalore', type: 'PUBLIC' },

  // ── Belgium ──────────────────────────────────────────────────────────────
  { name: 'KU Leuven', domain: 'kuleuven.be', country: 'Belgium', countryCode: 'BE', city: 'Leuven', type: 'PUBLIC' },
  { name: 'Ghent University', domain: 'ugent.be', country: 'Belgium', countryCode: 'BE', city: 'Ghent', type: 'PUBLIC' },

  // ── Malaysia ─────────────────────────────────────────────────────────────
  { name: 'University of Malaya', domain: 'um.edu.my', country: 'Malaysia', countryCode: 'MY', city: 'Kuala Lumpur', type: 'PUBLIC' },
  { name: 'Universiti Teknologi Malaysia', domain: 'utm.my', country: 'Malaysia', countryCode: 'MY', city: 'Johor Bahru', type: 'PUBLIC' },

  // ── United Arab Emirates ─────────────────────────────────────────────────
  { name: 'United Arab Emirates University', domain: 'uaeu.ac.ae', country: 'United Arab Emirates', countryCode: 'AE', city: 'Al Ain', type: 'PUBLIC' },
  { name: 'American University of Sharjah', domain: 'aus.edu', country: 'United Arab Emirates', countryCode: 'AE', city: 'Sharjah', type: 'PRIVATE' }
];

export function seedsForCountries(codes: string[]): UniversitySeed[] {
  const want = new Set(codes.map((c) => c.toUpperCase()));
  return UNIVERSITY_SEEDS.filter((s) => want.has(s.countryCode));
}
