import crypto from 'crypto';

/**
 * URL / text canonicalization primitives.
 *
 * These are the dedup substrate: every "have I seen this before?" decision in
 * the pipeline bottoms out in canonicalUrl(), normalizeTitle() or
 * contentHash().
 */

const TRACKING_PARAMS = [
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'utm_id',
  'ref', 'referrer', 'source', 'fbclid', 'gclid', 'msclkid', 'mc_cid', 'mc_eid',
  '_ga', '_gl', 'igshid', 'spm', 'yclid'
];

/**
 * Canonical form used as the unique key on CrawlTarget and ScholarshipSource.
 *
 * Deliberately preserves query params that are not tracking noise — many
 * university systems address pages purely by query string
 * (`?scholarshipId=482`), so blanket-stripping the query would collapse
 * hundreds of distinct scholarships into one target.
 *
 * Path case IS preserved (some servers are case-sensitive); host is lowercased.
 */
export function canonicalUrl(raw: string, base?: string): string {
  try {
    const url = base ? new URL(raw, base) : new URL(raw);
    url.hash = '';
    url.hostname = url.hostname.toLowerCase().replace(/^www\./, '');
    url.protocol = url.protocol === 'http:' ? 'https:' : url.protocol;

    for (const p of TRACKING_PARAMS) url.searchParams.delete(p);
    // Stable param order so ?a=1&b=2 and ?b=2&a=1 are one target
    const entries = [...url.searchParams.entries()].sort(([a], [b]) => a.localeCompare(b));
    url.search = '';
    for (const [k, v] of entries) url.searchParams.append(k, v);

    // Drop a single trailing slash from the PATH, not the href — otherwise
    // "/scholarships/?id=5" keeps its slash because the href ends in "5".
    // Never turn "https://x.edu/" into "https://x.edu".
    if (url.pathname !== '/' && url.pathname.endsWith('/')) {
      url.pathname = url.pathname.slice(0, -1);
    }
    return url.href;
  } catch {
    return raw.trim();
  }
}

/** Registrable-ish domain: lowercase, no scheme, no www., no port, no path. */
export function normalizeDomain(input: string): string {
  let s = String(input || '').trim().toLowerCase();
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, '');
  s = s.split('/')[0].split('?')[0].split('#')[0];
  s = s.split('@').pop() ?? s; // strip any userinfo
  s = s.replace(/:\d+$/, '');
  s = s.replace(/^www\./, '');
  return s.replace(/\.$/, '');
}

export function domainOf(url: string): string {
  try {
    return normalizeDomain(new URL(url).hostname);
  } catch {
    return normalizeDomain(url);
  }
}

/** True when `url` lives on `domain` or a subdomain of it. */
export function isSameSite(url: string, domain: string): boolean {
  const d = normalizeDomain(domain);
  const h = domainOf(url);
  return h === d || h.endsWith(`.${d}`);
}

const TITLE_STOPWORDS = new Set([
  'the', 'a', 'an', 'of', 'for', 'in', 'at', 'to', 'and', 'on', 'by',
  'programme', 'program', 'scheme', 'award', 'awards'
]);

/**
 * Dedup-grade title normalization.
 *
 * "The Chevening Scholarships (2027/28) — Master's" and
 * "Chevening Scholarship 2027/28 Masters"  →  "chevening scholarship masters"
 *
 * Years are stripped here on purpose: the academic year is a *separate*
 * fingerprint component, so leaving it in the title would double-count it and
 * break dedup when one page writes "2027/28" and another writes "2027-2028".
 */
/**
 * Conservative singularization for dedup only.
 *
 * "scholarships" and "scholarship" must produce the same token, or one page's
 * plural heading forks a duplicate record. Deliberately naive — it only strips
 * a trailing "s", and skips words ending in "ss"/"us"/"is" so "business" and
 * "campus" survive intact. Never shown to a user.
 */
function singularize(word: string): string {
  if (word.length <= 3) return word;
  if (/(ss|us|is|as)$/.test(word)) return word;
  if (word.endsWith('ies')) return `${word.slice(0, -3)}y`;
  if (word.endsWith('s')) return word.slice(0, -1);
  return word;
}

export function normalizeTitle(raw: string): string {
  return String(raw || '')
    .toLowerCase()
    .replace(/[\u2018\u2019\u201c\u201d]/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\b(19|20)\d{2}\s*[/-]\s*(?:(19|20)?\d{2})\b/g, ' ') // 2027/28, 2027-2028
    .replace(/\b(19|20)\d{2}\b/g, ' ')
    .replace(/'s\b/g, 's') // master's → masters
    .replace(/[^a-z0-9]+/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 0 && !TITLE_STOPWORDS.has(w))
    .map(singularize)
    .join(' ')
    .trim();
}

/** Collapse whitespace and strip zero-width junk from scraped text. */
export function cleanText(raw: string): string {
  return String(raw || '')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Hash of *meaningful* content (§54).
 *
 * Whitespace and case are normalized away so that a CMS re-indenting its HTML
 * does not read as a content change and trigger a pointless AI re-extraction.
 */
export function contentHash(text: string): string {
  const normalized = String(text || '').toLowerCase().replace(/\s+/g, ' ').trim();
  return crypto.createHash('sha256').update(normalized).digest('hex').slice(0, 32);
}

/** Stable fingerprint from ordered components (§23). */
export function fingerprintOf(parts: (string | null | undefined)[]): string {
  const joined = parts.map((p) => (p ?? '').toString().trim().toLowerCase()).join('|');
  return crypto.createHash('sha256').update(joined).digest('hex').slice(0, 32);
}

/** Absolute-ise an href found on a page, or null if it is not fetchable. */
export function resolveUrl(href: string, base: string): string | null {
  const h = String(href || '').trim();
  if (!h) return null;
  if (/^(mailto:|tel:|javascript:|data:|#)/i.test(h)) return null;
  try {
    const u = new URL(h, base);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u.href;
  } catch {
    return null;
  }
}
