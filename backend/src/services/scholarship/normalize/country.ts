/**
 * Country / nationality normalization.
 *
 * Scoped deliberately: full ISO-3166 plus every demonym is a dataset, not
 * source code. This table covers the rollout countries (§7), the countries
 * that appear most often in scholarship eligibility clauses, and the demonym
 * forms ("Kenyan", "Nigerian") that eligibility text actually uses.
 *
 * Unrecognized input returns null. A null country code is never silently
 * dropped — callers keep the original string in `regions` or the raw text so
 * nothing is lost, and the gap shows up in admin review.
 */

interface CountryEntry {
  code: string;
  name: string;
  aliases: string[];
  demonyms: string[];
  regions: string[];
}

const COUNTRIES: CountryEntry[] = [
  { code: 'KE', name: 'Kenya', aliases: [], demonyms: ['kenyan', 'kenyans'], regions: ['AFRICA', 'EAST_AFRICA', 'SUB_SAHARAN_AFRICA', 'COMMONWEALTH', 'EAC'] },
  { code: 'UG', name: 'Uganda', aliases: [], demonyms: ['ugandan', 'ugandans'], regions: ['AFRICA', 'EAST_AFRICA', 'SUB_SAHARAN_AFRICA', 'COMMONWEALTH', 'EAC'] },
  { code: 'TZ', name: 'Tanzania', aliases: ['united republic of tanzania'], demonyms: ['tanzanian', 'tanzanians'], regions: ['AFRICA', 'EAST_AFRICA', 'SUB_SAHARAN_AFRICA', 'COMMONWEALTH', 'EAC'] },
  { code: 'RW', name: 'Rwanda', aliases: [], demonyms: ['rwandan', 'rwandans'], regions: ['AFRICA', 'EAST_AFRICA', 'SUB_SAHARAN_AFRICA', 'COMMONWEALTH', 'EAC'] },
  { code: 'ET', name: 'Ethiopia', aliases: [], demonyms: ['ethiopian', 'ethiopians'], regions: ['AFRICA', 'EAST_AFRICA', 'SUB_SAHARAN_AFRICA'] },
  { code: 'NG', name: 'Nigeria', aliases: [], demonyms: ['nigerian', 'nigerians'], regions: ['AFRICA', 'WEST_AFRICA', 'SUB_SAHARAN_AFRICA', 'COMMONWEALTH'] },
  { code: 'GH', name: 'Ghana', aliases: [], demonyms: ['ghanaian', 'ghanaians'], regions: ['AFRICA', 'WEST_AFRICA', 'SUB_SAHARAN_AFRICA', 'COMMONWEALTH'] },
  { code: 'ZA', name: 'South Africa', aliases: [], demonyms: ['south african', 'south africans'], regions: ['AFRICA', 'SOUTHERN_AFRICA', 'SUB_SAHARAN_AFRICA', 'COMMONWEALTH'] },
  { code: 'EG', name: 'Egypt', aliases: [], demonyms: ['egyptian', 'egyptians'], regions: ['AFRICA', 'NORTH_AFRICA', 'MENA'] },

  { code: 'GB', name: 'United Kingdom', aliases: ['uk', 'u.k.', 'great britain', 'britain', 'england', 'scotland', 'wales', 'northern ireland'], demonyms: ['british', 'uk national', 'uk nationals'], regions: ['EUROPE', 'COMMONWEALTH'] },
  { code: 'IE', name: 'Ireland', aliases: ['republic of ireland', 'eire'], demonyms: ['irish'], regions: ['EUROPE', 'EU', 'EEA'] },
  { code: 'US', name: 'United States', aliases: ['usa', 'u.s.a.', 'us', 'u.s.', 'united states of america', 'america'], demonyms: ['american', 'americans'], regions: ['NORTH_AMERICA'] },
  { code: 'CA', name: 'Canada', aliases: [], demonyms: ['canadian', 'canadians'], regions: ['NORTH_AMERICA', 'COMMONWEALTH'] },
  { code: 'AU', name: 'Australia', aliases: [], demonyms: ['australian', 'australians'], regions: ['OCEANIA', 'COMMONWEALTH'] },
  { code: 'NZ', name: 'New Zealand', aliases: ['aotearoa'], demonyms: ['new zealander', 'new zealanders', 'kiwi'], regions: ['OCEANIA', 'COMMONWEALTH'] },

  { code: 'DE', name: 'Germany', aliases: ['deutschland', 'federal republic of germany'], demonyms: ['german', 'germans'], regions: ['EUROPE', 'EU', 'EEA', 'SCHENGEN'] },
  { code: 'NL', name: 'Netherlands', aliases: ['the netherlands', 'holland'], demonyms: ['dutch'], regions: ['EUROPE', 'EU', 'EEA', 'SCHENGEN'] },
  { code: 'SE', name: 'Sweden', aliases: ['sverige'], demonyms: ['swedish', 'swede', 'swedes'], regions: ['EUROPE', 'EU', 'EEA', 'SCHENGEN', 'NORDIC'] },
  { code: 'NO', name: 'Norway', aliases: ['norge'], demonyms: ['norwegian', 'norwegians'], regions: ['EUROPE', 'EEA', 'SCHENGEN', 'NORDIC'] },
  { code: 'FI', name: 'Finland', aliases: ['suomi'], demonyms: ['finnish', 'finn', 'finns'], regions: ['EUROPE', 'EU', 'EEA', 'SCHENGEN', 'NORDIC'] },
  { code: 'DK', name: 'Denmark', aliases: ['danmark'], demonyms: ['danish', 'dane', 'danes'], regions: ['EUROPE', 'EU', 'EEA', 'SCHENGEN', 'NORDIC'] },
  { code: 'FR', name: 'France', aliases: [], demonyms: ['french'], regions: ['EUROPE', 'EU', 'EEA', 'SCHENGEN'] },
  { code: 'IT', name: 'Italy', aliases: ['italia'], demonyms: ['italian', 'italians'], regions: ['EUROPE', 'EU', 'EEA', 'SCHENGEN'] },
  { code: 'ES', name: 'Spain', aliases: ['espana', 'españa'], demonyms: ['spanish', 'spaniard', 'spaniards'], regions: ['EUROPE', 'EU', 'EEA', 'SCHENGEN'] },
  { code: 'BE', name: 'Belgium', aliases: [], demonyms: ['belgian', 'belgians'], regions: ['EUROPE', 'EU', 'EEA', 'SCHENGEN'] },
  { code: 'AT', name: 'Austria', aliases: ['osterreich', 'österreich'], demonyms: ['austrian', 'austrians'], regions: ['EUROPE', 'EU', 'EEA', 'SCHENGEN'] },
  { code: 'CH', name: 'Switzerland', aliases: [], demonyms: ['swiss'], regions: ['EUROPE', 'EFTA', 'SCHENGEN'] },
  { code: 'PT', name: 'Portugal', aliases: [], demonyms: ['portuguese'], regions: ['EUROPE', 'EU', 'EEA', 'SCHENGEN'] },
  { code: 'PL', name: 'Poland', aliases: ['polska'], demonyms: ['polish', 'pole', 'poles'], regions: ['EUROPE', 'EU', 'EEA', 'SCHENGEN'] },

  { code: 'JP', name: 'Japan', aliases: ['nippon'], demonyms: ['japanese'], regions: ['ASIA', 'EAST_ASIA'] },
  { code: 'KR', name: 'South Korea', aliases: ['korea', 'republic of korea', 'korea, republic of'], demonyms: ['korean', 'koreans', 'south korean'], regions: ['ASIA', 'EAST_ASIA'] },
  { code: 'CN', name: 'China', aliases: ["people's republic of china", 'prc', 'mainland china'], demonyms: ['chinese'], regions: ['ASIA', 'EAST_ASIA'] },
  { code: 'SG', name: 'Singapore', aliases: [], demonyms: ['singaporean', 'singaporeans'], regions: ['ASIA', 'SOUTHEAST_ASIA', 'COMMONWEALTH', 'ASEAN'] },
  { code: 'IN', name: 'India', aliases: [], demonyms: ['indian', 'indians'], regions: ['ASIA', 'SOUTH_ASIA', 'COMMONWEALTH'] },
  { code: 'PK', name: 'Pakistan', aliases: [], demonyms: ['pakistani', 'pakistanis'], regions: ['ASIA', 'SOUTH_ASIA', 'COMMONWEALTH'] },
  { code: 'BD', name: 'Bangladesh', aliases: [], demonyms: ['bangladeshi', 'bangladeshis'], regions: ['ASIA', 'SOUTH_ASIA', 'COMMONWEALTH'] },
  { code: 'MY', name: 'Malaysia', aliases: [], demonyms: ['malaysian', 'malaysians'], regions: ['ASIA', 'SOUTHEAST_ASIA', 'COMMONWEALTH', 'ASEAN'] },
  { code: 'ID', name: 'Indonesia', aliases: [], demonyms: ['indonesian', 'indonesians'], regions: ['ASIA', 'SOUTHEAST_ASIA', 'ASEAN'] },
  { code: 'BR', name: 'Brazil', aliases: ['brasil'], demonyms: ['brazilian', 'brazilians'], regions: ['SOUTH_AMERICA', 'LATIN_AMERICA'] },
  { code: 'MX', name: 'Mexico', aliases: [], demonyms: ['mexican', 'mexicans'], regions: ['NORTH_AMERICA', 'LATIN_AMERICA'] }
];

const BY_CODE = new Map<string, CountryEntry>();
const LOOKUP = new Map<string, CountryEntry>();

for (const c of COUNTRIES) {
  BY_CODE.set(c.code, c);
  const keys = [c.code.toLowerCase(), c.name.toLowerCase(), ...c.aliases, ...c.demonyms];
  for (const k of keys) {
    // First registration wins — 'us' must resolve to United States, and
    // ambiguous aliases registered later must not clobber it.
    if (!LOOKUP.has(k)) LOOKUP.set(k, c);
  }
}

/** Region keywords that are NOT countries but appear constantly in eligibility text. */
export const REGION_KEYWORDS: Record<string, string> = {
  eu: 'EU',
  'european union': 'EU',
  eea: 'EEA',
  'european economic area': 'EEA',
  schengen: 'SCHENGEN',
  nordic: 'NORDIC',
  commonwealth: 'COMMONWEALTH',
  africa: 'AFRICA',
  african: 'AFRICA',
  'sub-saharan africa': 'SUB_SAHARAN_AFRICA',
  'sub saharan africa': 'SUB_SAHARAN_AFRICA',
  'east africa': 'EAST_AFRICA',
  'west africa': 'WEST_AFRICA',
  'southern africa': 'SOUTHERN_AFRICA',
  asia: 'ASIA',
  asean: 'ASEAN',
  'latin america': 'LATIN_AMERICA',
  caribbean: 'CARIBBEAN',
  'middle east': 'MENA',
  mena: 'MENA',
  'developing countries': 'DEVELOPING_COUNTRIES',
  'developing country': 'DEVELOPING_COUNTRIES',
  'low income countries': 'DEVELOPING_COUNTRIES',
  'least developed countries': 'LDC',
  oda: 'ODA_ELIGIBLE',
  'oda-eligible': 'ODA_ELIGIBLE'
};

function key(input: string): string {
  return String(input || '')
    .toLowerCase()
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[^a-z0-9'\s.,-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Country name / alias / demonym / ISO code → ISO-3166 alpha-2, or null. */
export function toCountryCode(input: string | null | undefined): string | null {
  if (!input) return null;
  const k = key(input);
  if (!k) return null;
  const direct = LOOKUP.get(k);
  if (direct) return direct.code;
  // "citizens of Kenya", "Kenyan nationals" → strip framing words and retry
  const stripped = k
    .replace(/\b(citizens?|nationals?|residents?|students?|applicants?|passport holders?|of|from)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (stripped && stripped !== k) {
    const hit = LOOKUP.get(stripped);
    if (hit) return hit.code;
  }
  return null;
}

export function toCountryName(code: string | null | undefined): string | null {
  if (!code) return null;
  return BY_CODE.get(String(code).toUpperCase())?.name ?? null;
}

export function regionsForCountry(code: string): string[] {
  return BY_CODE.get(String(code).toUpperCase())?.regions ?? [];
}

/** True if a country belongs to a region bucket ("KE" ∈ "AFRICA"). */
export function countryInRegion(code: string, region: string): boolean {
  return regionsForCountry(code).includes(String(region).toUpperCase());
}

/**
 * Pull every explicitly-named country out of a block of eligibility text.
 *
 * Longest-alias-first so "South Africa" is not shredded into "Africa" the
 * region, and word-boundary anchored so "Chinese" inside "Chineseness" cannot
 * fire. Returns codes in first-appearance order.
 */
export function extractCountries(text: string): string[] {
  const haystack = key(text);
  if (!haystack) return [];
  const found: { code: string; at: number }[] = [];

  const terms: { term: string; code: string }[] = [];
  for (const c of COUNTRIES) {
    for (const t of [c.name.toLowerCase(), ...c.aliases, ...c.demonyms]) {
      if (t.length >= 4) terms.push({ term: t, code: c.code });
    }
  }
  terms.sort((a, b) => b.term.length - a.term.length);

  const claimed: [number, number][] = [];
  const overlaps = (s: number, e: number) => claimed.some(([cs, ce]) => s < ce && e > cs);

  for (const { term, code } of terms) {
    const re = new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g');
    let m: RegExpExecArray | null;
    while ((m = re.exec(haystack))) {
      const s = m.index;
      const e = s + m[0].length;
      if (overlaps(s, e)) continue;
      claimed.push([s, e]);
      if (!found.some((f) => f.code === code)) found.push({ code, at: s });
    }
  }
  return found.sort((a, b) => a.at - b.at).map((f) => f.code);
}

/** Pull region buckets ("EU", "SUB_SAHARAN_AFRICA") out of eligibility text. */
export function extractRegions(text: string): string[] {
  const haystack = key(text);
  const out = new Set<string>();
  for (const [term, region] of Object.entries(REGION_KEYWORDS)) {
    const re = new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
    if (re.test(haystack)) out.add(region);
  }
  return [...out];
}

export function allCountryCodes(): string[] {
  return COUNTRIES.map((c) => c.code);
}
