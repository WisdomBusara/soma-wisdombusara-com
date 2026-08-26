import axios from 'axios';
import * as cheerio from 'cheerio';
import { logger } from '../config/logger';
import { ScrapeSourceModel } from '../models/ScrapeSource';
import { classify, classifyTender, type Candidate, type ClassifyResult } from './classifier';

type Vertical = 'jobs' | 'tenders';
type Clf = (c: Candidate) => ClassifyResult;
const clfFor = (v?: Vertical): Clf => (v === 'tenders' ? classifyTender : classify);
// the reason that must be present for heading/card extraction to accept a title
const anchorReasonFor = (v?: Vertical) => (v === 'tenders' ? 'tender word' : 'role noun');

export interface ScrapedJob {
  title: string;
  url: string;
  location?: string;
  deadline?: string;     // tender closing date (as found on the page)
  description?: string;  // short scope/description for tenders
}

export interface RejectedCandidate {
  title: string;
  url: string;
  score: number;
  reasons: string[];
}

export interface BankResult {
  bankName: string;
  jobs: ScrapedJob[];
  rejected?: RejectedCandidate[];
  sourceUrl?: string;
  error?: string;
  note?: string;
}

const HTTP = axios.create({
  timeout: 20_000,
  headers: {
    'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/json',
    'Accept-Language': 'en-KE,en;q=0.9',
  },
  validateStatus: (s) => s >= 200 && s < 400,
});

async function withRetry<T>(fn: () => Promise<T>, retries = 2, delayMs = 1500): Promise<T> {
  try { return await fn(); }
  catch (err) {
    if (retries === 0) throw err;
    await new Promise((r) => setTimeout(r, delayMs));
    return withRetry(fn, retries - 1, delayMs * 2);
  }
}

async function withConcurrency<T>(tasks: (() => Promise<T>)[], limit: number): Promise<T[]> {
  const results: (T | undefined)[] = new Array(tasks.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (next < tasks.length) {
      const i = next++;
      results[i] = await tasks[i]();
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
  return results as T[];
}

// Strip date prefixes, trailing CTA noise, and Windows-style encoding artifacts.
function cleanTitle(raw: string): string {
  return raw
    .replace(/^\d{1,2}\/\d{1,2}\/\d{2,4}\s+/, '')           // "11/05/2026 Title" → "Title"
    .replace(/\s*(More Details|Apply Now|Apply Here|View Details|View Job|Read More|View More)\s*/gi, ' ')
    .replace(/\s*\(opens in new window\)\s*/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeUrl(u: string): string {
  try {
    const url = new URL(u);
    url.hash = '';
    ['utm_source', 'utm_medium', 'utm_campaign', 'ref', 'fbclid'].forEach((p) =>
      url.searchParams.delete(p));
    return url.href.replace(/\/$/, '').toLowerCase();
  } catch { return u.toLowerCase(); }
}

const LOCATION_RE = /\b(Nairobi|Mombasa|Kisumu|Nakuru|Eldoret|Thika|Kenya)\b/i;

// Match a date in the common Kenyan tender formats.
const DATE_RE = /(?:(\d{1,2})(?:st|nd|rd|th)?[\s./-]+([A-Za-z]{3,9})[\s./-]+(\d{4}))|(?:([A-Za-z]{3,9})[\s./-]+(\d{1,2})(?:st|nd|rd|th)?,?[\s./-]+(\d{4}))|(?:(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{4}))|(?:(\d{4})-(\d{2})-(\d{2}))/;
const MONTHS_MAP: Record<string, number> = { jan:0, feb:1, mar:2, apr:3, may:4, jun:5, jul:6, aug:7, sep:8, oct:9, nov:10, dec:11 };

function parseDateToken(s: string): Date | null {
  const m = s.match(DATE_RE);
  if (!m) return null;
  const mon = (x?: string) => (x ? MONTHS_MAP[x.slice(0, 3).toLowerCase()] : undefined);
  if (m[1]) { const mo = mon(m[2]); if (mo === undefined) return null; return new Date(+m[3], mo, +m[1]); }
  if (m[4]) { const mo = mon(m[4]); if (mo === undefined) return null; return new Date(+m[6], mo, +m[5]); }
  if (m[7]) return new Date(+m[9], +m[8] - 1, +m[7]);
  if (m[10]) return new Date(+m[10], +m[11] - 1, +m[12]);
  return null;
}

// Pull a closing/deadline date from tender listing text, returned as displayed.
function extractDeadline(text: string): string | undefined {
  const m = text.match(/(?:clos\w*(?:\s+on)?|deadline|submission|due|received?\s+(?:on\s+)?(?:or\s+)?before)\s*:?\s*((?:[A-Za-z]+day,?\s*)?(?:\d{1,2}(?:st|nd|rd|th)?[\s./-]+[A-Za-z]{3,9}[\s./-]+\d{2,4}|[A-Za-z]{3,9}[\s./-]+\d{1,2}(?:st|nd|rd|th)?,?[\s./-]+\d{2,4}|\d{1,2}[/.\-]\d{1,2}[/.\-]\d{2,4})(?:\s*(?:at\s*)?\d{1,2}[.:]\d{2}\s*(?:am|pm|hrs|hours)?)?)/i);
  if (m) return m[1].replace(/\s+/g, ' ').trim();
  return undefined;
}

function parseDeadline(deadline?: string): Date | null {
  if (!deadline) return null;
  const d = parseDateToken(deadline);
  if (!d || isNaN(d.getTime())) return null;
  d.setHours(23, 59, 59, 999);
  return d;
}

const MONTH_NAMES = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
function formatClosing(d: Date): string {
  return `${d.getDate()} ${MONTH_NAMES[d.getMonth()]} ${d.getFullYear()}`;
}

/** Find every date in the text and return the latest one (the closing date). */
function latestDeadline(text: string): Date | null {
  const re = new RegExp(DATE_RE.source, 'g');
  let m: RegExpExecArray | null;
  let latest: Date | null = null;
  const now = Date.now();
  while ((m = re.exec(text))) {
    const d = parseDateToken(m[0]);
    if (!d || isNaN(d.getTime())) continue;
    // ignore absurd dates (bad parses); keep within a sane window
    const yr = d.getFullYear();
    if (yr < 2020 || yr > 2035) continue;
    d.setHours(23, 59, 59, 999);
    // prefer the latest future-ish date as the closing date
    if (!latest || d.getTime() > latest.getTime()) latest = d;
  }
  return latest;
}
const MAX_CRAWL_TARGETS = 8;  // depth-1 crawl cap per bank
const MAX_JOBS_PER_BANK = 60;

async function discoverCareersUrl(homepage: string, vertical: Vertical = 'jobs'): Promise<string | null> {
  try {
    const res = await HTTP.get(homepage, { responseType: 'text' });
    const $ = cheerio.load(res.data as string);
    for (const el of $('a[href]').toArray()) {
      const text = ($(el).text() || '').toLowerCase().trim();
      const href = $(el).attr('href') ?? '';
      const rx = vertical === 'tenders'
        ? { t: /tender|procurement|rfp|rfq|eoi|bid|prequalif|opportunit/i, h: /tender|procurement|rfp|rfq|eoi|bids?|prequalif/i }
        : { t: /career|jobs|vacanc|join (us|our team)|work (with|for) us|opportunit/i, h: /\/(careers?|jobs?|vacanc)/i };
      if (rx.t.test(text) || rx.h.test(href)) {
        try { return new URL(href, homepage).href; } catch { continue; }
      }
    }
  } catch { /* silent */ }
  return null;
}

// Extract and classify all <a> anchors from an already-loaded cheerio doc.
function extractCandidates(
  $: cheerio.CheerioAPI,
  baseUrl: string,
  seenUrls: Set<string>,
  jobSelector?: string,
  debug = false,
  clf: Clf = classify,
): { jobs: ScrapedJob[]; rejected: RejectedCandidate[]; crawlQueue: string[] } {
  const jobs: ScrapedJob[] = [];
  const rejected: RejectedCandidate[] = [];
  const crawlQueue: string[] = [];

  const anchors = jobSelector ? $(jobSelector).find('a[href]') : $('a[href]');

  anchors.each((_i, el) => {
    const $el = $(el);
    const rawText = $el.text().replace(/\s+/g, ' ').trim();
    const text = cleanTitle(rawText);
    let href = $el.attr('href') ?? '';

    if (!href || href.startsWith('#') || href.startsWith('javascript:') || href.startsWith('mailto:')) return;
    try { href = new URL(href, baseUrl).href; } catch { return; }

    // Deduplicate by normalized URL — catches same link with different text case
    const norm = normalizeUrl(href);
    if (seenUrls.has(norm)) return;
    seenUrls.add(norm);

    const context = $el.closest('section,article,li,tr,div')
      .find('h1,h2,h3,h4').first().text().trim();

    const result = clf({ text, href, context });

    if (result.type === 'posting') {
      const rowText = $el.closest('li,tr,article,div').text().replace(/\s+/g, ' ').trim();
      const parentText = $el.parent().text().trim().replace(/\s+/g, ' ');
      const loc = parentText.match(LOCATION_RE)?.[0];
      const deadline = extractDeadline(rowText || parentText);
      let displayDeadline = deadline;
      if (clf === classifyTender) {
        // The prominent date in a tender row IS its closing date, even without
        // a "closing:" keyword (e.g. KPPF shows "…ALL 13/01/2026 AT 11:30 AM").
        // Take the latest date found and drop the tender if it's already past.
        const closing = latestDeadline(rowText || parentText) ?? parseDeadline(deadline);
        if (closing) {
          if (closing.getTime() < Date.now()) return;         // expired — skip
          if (!displayDeadline) displayDeadline = formatClosing(closing);
        }
      }
      // Tender reference number (e.g. "KPPF/PROC/2-A/04/2025") makes a better
      // one-line description than the submission-address boilerplate.
      let description: string | undefined;
      if (clf === classifyTender && rowText) {
        const refMatch = rowText.match(/[A-Z]{2,8}[/\-][A-Z0-9][A-Z0-9/.\-]{4,}/);
        if (refMatch) description = `Ref: ${refMatch[0].replace(/\s+/g, '')}`;
      }
      jobs.push({ title: text, url: href, location: loc, deadline: displayDeadline, description });
    } else if (result.type === 'careers_page') {
      crawlQueue.push(href);
    } else if (debug) {
      rejected.push({ title: text, url: href, score: result.score, reasons: result.reasons });
    }
  });

  return { jobs, rejected, crawlQueue };
}

/**
 * Fallback for JS-rendered careers pages (Next.js/Nuxt): job data is embedded
 * in the page as escaped JSON (e.g. HFCB). Anchor extraction sees nothing, but
 * the payload has {"title":"…", …, "status":true,"id":150,"createdAt":…}.
 * Detail URL convention: <careersUrl>/<id>.
 */
function extractEmbeddedJobs(html: string, pageUrl: string, clf: Clf = classify): ScrapedJob[] {
  const un = html
    .replace(/\\"/g, '"')
    .replace(/\\u003c/gi, '<').replace(/\\u003e/gi, '>').replace(/\\u0026/gi, '&');
  const jobs: ScrapedJob[] = [];
  const seen = new Set<string>();
  const base = pageUrl.replace(/[?#].*$/, '').replace(/\/$/, '');
  const now = Date.now();

  // Locate every "title" and treat the span up to the next "title" as one job
  // object (descriptions are huge, so a fixed small window misses the id).
  const titleIdx: Array<{ index: number; title: string }> = [];
  const re = /"title":"([^"]{4,140})"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(un))) titleIdx.push({ index: m.index, title: m[1] });

  for (let i = 0; i < titleIdx.length && jobs.length < 40; i++) {
    const span = un.slice(titleIdx[i].index, titleIdx[i + 1]?.index ?? titleIdx[i].index + 40000);
    // must look like a job object, not arbitrary page data — includes
    // schema.org JobPosting markers (validThrough, hiringOrganization)
    if (!/"(applicationDeadline|reportingTo|subsidiary|jobType|vacancy|validThrough|hiringOrganization|employmentType|closingDate|datePosted)"/.test(span.slice(0, 1500))) continue;
    const title = titleIdx[i].title.replace(/\s+/g, ' ').trim();
    if (seen.has(title.toLowerCase())) continue;

    // skip closed roles — payloads often include past positions. Sites name
    // the field differently: HFCB applicationDeadline, schema.org validThrough…
    const dl = span.match(/"(applicationDeadline|validThrough|valid_through|closingDate|closing_date|deadline|expiryDate|expiry_date)":"([^"]+)"/i);
    if (dl) {
      const t = Date.parse(dl[2]);
      if (!isNaN(t) && t < now) continue;
    }

    // prefer the object's own job URL when the payload carries one
    const urlMatch = span.match(/"(url|jobUrl|applyUrl|link)":"(https?:\/\/[^"]{10,300})"/i);
    // the object's own id sits in `"status":true,"id":150,"createdAt"` — bare
    // "id" keys belong to nested objects (category etc.), so anchor on that shape
    const idMatch = span.match(/"status":(?:true|false),"id":(\d{1,8}),"createdAt"/);
    const href = urlMatch ? urlMatch[2] : idMatch ? `${base}/${idMatch[1]}` : base;
    if (clf({ text: title, href }).type !== 'posting') continue;
    seen.add(title.toLowerCase());
    jobs.push({ title, url: href });
  }
  return jobs;
}

async function scrapeHtml(
  url: string,
  homepage: string,
  jobSelector?: string,
  debug = false,
  urlFilter?: string,
  vertical: Vertical = 'jobs',
): Promise<{ jobs: ScrapedJob[]; rejected: RejectedCandidate[]; sourceUrl: string }> {
  let html: string;
  let sourceUrl = url;

  try {
    const res = await withRetry(() => HTTP.get(url, { responseType: 'text' }));
    html = res.data as string;
  } catch {
    const discovered = await discoverCareersUrl(homepage, vertical);
    if (!discovered) throw new Error(`${vertical === 'tenders' ? 'tender' : 'careers'} page not found; homepage discovery failed`);
    sourceUrl = discovered;
    const res = await withRetry(() => HTTP.get(discovered, { responseType: 'text' }));
    html = res.data as string;
  }

  const $ = cheerio.load(html);
  const seenUrls = new Set<string>();
  const allJobs: ScrapedJob[] = [];
  const allRejected: RejectedCandidate[] = [];

  // Phase 1: extract from main careers page
  const clf = clfFor(vertical);
  const { jobs, rejected, crawlQueue } = extractCandidates($, sourceUrl, seenUrls, jobSelector, debug, clf);
  allJobs.push(...jobs);
  allRejected.push(...rejected);

  // Phase 2: depth-1 crawl of careers landing pages found on main page.
  // These are "Career Opportunities", "Work With Us", ATS portal roots, etc.
  const targets = [...new Set(crawlQueue)].slice(0, MAX_CRAWL_TARGETS);
  for (const targetUrl of targets) {
    try {
      // Small delay — be polite
      await new Promise((r) => setTimeout(r, 300 + Math.random() * 500));
      const res = await HTTP.get(targetUrl, { responseType: 'text' });
      const $c = cheerio.load(res.data as string);
      const { jobs: deepJobs, rejected: deepRejected } = extractCandidates($c, targetUrl, seenUrls, undefined, debug, clf);
      allJobs.push(...deepJobs);
      allRejected.push(...deepRejected);
    } catch { /* one bank's depth-1 failure never aborts the run */ }
  }

  // Phase 3: anchors gave nothing — try embedded JSON (JS-rendered pages)
  if (allJobs.length === 0) {
    const embedded = extractEmbeddedJobs(html, sourceUrl, clf);
    if (embedded.length > 0) {
      logger.info({ url: sourceUrl, count: embedded.length }, 'Jobs recovered from embedded JSON payload');
      allJobs.push(...embedded);
    }
  }

  // Phase 4: still nothing — jobs may be plain-text headings ("apply by
  // email", e.g. ABC Bank) or link-less JS card divs (e.g. Co-op Bank's
  // career_tax pages, where the title only exists as an img alt / text node).
  if (allJobs.length === 0) {
    const seen = new Set<string>();

    // Walk up from a title element to its enclosing "card" — the smallest
    // ancestor that contains a link, capped so we never grab whole sections.
    const cardOf = (el: any): cheerio.Cheerio<any> | null => {
      let $c = $(el);
      for (let i = 0; i < 4; i++) {
        const $p = $c.parent();
        if (!$p.length) break;
        $c = $p;
        if ($c.text().length > 1200) break;
        if ($c.find('a[href]').length > 0) return $c;
      }
      return null;
    };

    // "Closes on 12th May 2026" / "Deadline: Jul 8, 2026" → epoch or null
    const cardDeadline = (text: string): number | null => {
      const dmy = text.match(/(?:clos\w*(?:\s+on)?|deadline)\s*:?\s*(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]{3,9}),?\s+(\d{4})/i);
      if (dmy) { const t = Date.parse(`${dmy[1]} ${dmy[2]} ${dmy[3]}`); if (!isNaN(t)) return t; }
      const mdy = text.match(/(?:clos\w*(?:\s+on)?|deadline)\s*:?\s*([A-Za-z]{3,9})\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})/i);
      if (mdy) { const t = Date.parse(`${mdy[1]} ${mdy[2]} ${mdy[3]}`); if (!isNaN(t)) return t; }
      return null;
    };

    const addCandidate = (t: string, el?: any) => {
      t = t.replace(/\s+/g, ' ').trim();
      if (t.length < 6 || t.length > 90 || seen.has(t.toLowerCase())) return;
      // job titles are noun phrases, not sentences — kill marketing headlines
      if (/[.!…]$/.test(t)) return;                       // "…steering our vision forward."
      if (t.split(/\s+/).length > 10) return;             // real titles are short
      if (/\b(our|we|you|your)\b/i.test(t)) return;       // "enabling our business"

      let cardHref: string | null = null;
      if (el) {
        const card = cardOf(el);
        if (card) {
          // skip roles whose card advertises a past closing date
          const dl = cardDeadline(card.text());
          if (dl !== null && dl < Date.now()) return;
          const a = card.find('a[href]').first().attr('href');
          if (a && !/^(mailto:|tel:|#)/i.test(a)) {
            try { cardHref = new URL(a, sourceUrl).toString(); } catch { /* ignore */ }
          }
        }
      }

      // classify against the card link first (best URL), but a random in-card
      // link must not sink an otherwise valid title — fall back to page URL
      const isPosting = (href: string) => {
        const r = clf({ text: t, href });
        // require the vertical's anchor signal (role noun / tender word) —
        // "Application deadline: …" scores via hiring words alone otherwise
        return r.type === 'posting' && r.reasons.includes(anchorReasonFor(vertical));
      };
      let href: string | null = null;
      if (cardHref && isPosting(cardHref)) href = cardHref;
      else if (isPosting(sourceUrl)) href = sourceUrl;
      if (!href) return;
      seen.add(t.toLowerCase());
      allJobs.push({ title: t, url: href });
    };
    $('h1, h2, h3, h4, h5, strong, b').each((_, el) => addCandidate($(el).text(), el));
    $('img[alt]').each((_, el) => addCandidate(String($(el).attr('alt') ?? ''), el));
    // leaf elements only — card titles and vacancy-table cells are short
    // text-only nodes (td: DIB Kenya lists jobs in a table with mailto apply)
    $('p, span, div, td, li').each((_, el) => {
      const $el = $(el);
      if ($el.children().length > 0) return;
      addCandidate($el.text(), el);
    });
    if (allJobs.length > 0) {
      logger.info({ url: sourceUrl, count: allJobs.length }, 'Jobs recovered from headings/cards');
    }
  }

  // Optional per-source location/path filter — e.g. Citi's Kenya search page
  // links "related" roles in other countries; keep only /job/nairobi/ URLs.
  let finalJobs = allJobs;
  if (urlFilter) {
    try {
      const re = new RegExp(urlFilter, 'i');
      finalJobs = allJobs.filter((j) => re.test(j.url));
    } catch { /* invalid regex in source config — ignore filter */ }
  }

  return {
    jobs: finalJobs.slice(0, MAX_JOBS_PER_BANK),
    rejected: allRejected,
    sourceUrl,
  };
}

/**
 * Workday ATS. Careersite URL example:
 *   https://absa.wd3.myworkdayjobs.com/ABSAcareersite?locationCountry=<guid>
 * → POST https://absa.wd3.myworkdayjobs.com/wday/cxs/absa/ABSAcareersite/jobs
 */
async function scrapeWorkday(careersiteUrl: string): Promise<ScrapedJob[]> {
  const u = new URL(careersiteUrl);
  const host = u.hostname;                          // absa.wd3.myworkdayjobs.com
  const tenant = host.split('.')[0];                // absa
  const site = u.pathname.split('/').filter(Boolean)[0]; // ABSAcareersite
  if (!site) throw new Error('workday url missing careersite path segment');
  const country = u.searchParams.get('locationCountry');

  const body: Record<string, unknown> = {
    appliedFacets: country ? { locationCountry: [country] } : {},
    limit: 20, offset: 0, searchText: ''
  };
  const resp = await withRetry(() => HTTP.post(
    `https://${host}/wday/cxs/${tenant}/${site}/jobs`,
    body,
    { headers: { 'Content-Type': 'application/json', Accept: 'application/json' } }
  ));
  const postings: any[] = resp.data?.jobPostings ?? [];
  return postings
    .map((p) => ({
      title: String(p.title ?? '').trim(),
      url: `https://${host}/${site}${String(p.externalPath ?? '')}`,
      location: String(p.locationsText ?? '') || undefined
    }))
    .filter((j) => j.title);
}

async function scrapeOracle(
  tenant: string,
  siteNumber: string,
  locationId: number,
  domain = 'fa.em3.oraclecloud.com',
): Promise<ScrapedJob[]> {
  const resp = await withRetry(() => HTTP.get(
    `https://${tenant}.${domain}/hcmRestApi/resources/latest/recruitingCEJobRequisitions`,
    {
      params: {
        onlyData: true,
        expand: 'requisitionList.secondaryLocations',
        // locationId=0 means "no location filter" — single-country tenants
        // (e.g. Safaricom) list everything without one
        finder: `findReqs;siteNumber=${siteNumber},limit=50,${locationId ? `locationId=${locationId},` : ''}selectedFlexFieldsFacets=null`,
      },
      headers: { Accept: 'application/json' },
    }
  ));
  const reqs: any[] = resp.data?.items?.[0]?.requisitionList ?? [];
  return reqs
    .map((r) => ({
      title: String(r.Title ?? '').trim(),
      url: `https://${tenant}.${domain.replace('fa.', 'fa.')}/hcmUI/CandidateExperience/en/sites/${siteNumber}/job/${r.Id}`,
      location: 'Kenya',
    }))
    .filter((j) => j.title);
}

// ── Bank definitions ──────────────────────────────────────────────────────────
type HtmlBank = {
  name: string; kind: 'html';
  vertical?: Vertical;
  url: string; homepage: string;
  jobSelector?: string; dynamic?: boolean;
  urlFilter?: string;   // regex — keep only matching job URLs
};
type OracleBank = {
  name: string; kind: 'oracle';
  vertical?: Vertical;
  homepage: string; tenant: string; siteNumber: string; locationId: number;
  domain?: string;  // defaults to fa.em3.oraclecloud.com
};
// Workday needs only the public careersite URL — tenant, site and the optional
// locationCountry facet are all parsed out of it.
type WorkdayBank = {
  name: string; kind: 'workday';
  vertical?: Vertical;
  homepage: string; url: string;
};
type BankDef = HtmlBank | OracleBank | WorkdayBank;

// Seed data only — after first run these live in the scrape_sources
// collection and are managed from the admin portal (Sources page).
const SEED_SOURCES: BankDef[] = [
  // ── Tier-1 & major ──────────────────────────────────────────────────────────
  { name: 'KCB Group',                 kind: 'oracle', homepage: 'https://kcbgroup.com',                      tenant: 'eoin',               siteNumber: 'CX_3001', locationId: 300000000385420 },
  { name: 'Equity Bank',               kind: 'html',   homepage: 'https://equitygroupholdings.com',           url: 'https://equitygroupholdings.com/careers/',            dynamic: true },
  { name: 'NCBA Group',                kind: 'html',   homepage: 'https://ke.ncbagroup.com',                  url: 'https://ke.ncbagroup.com/careers/' },
  { name: 'Co-operative Bank',         kind: 'html',   homepage: 'https://co-opbank.co.ke',                   url: 'https://co-opbank.co.ke/careers/' },
  { name: 'Absa Kenya',                kind: 'html',   homepage: 'https://www.absa.co.ke',                    url: 'https://www.absa.africa/absaafrica/careers/' },
  { name: 'Standard Chartered Kenya',  kind: 'html',   homepage: 'https://www.sc.com/ke',                     url: 'https://www.sc.com/en/careers/',                      dynamic: true },
  { name: 'Stanbic Bank Kenya',        kind: 'html',   homepage: 'https://www.stanbicbank.co.ke',             url: 'https://www.standardbank.com/sbg/standard-bank-group/careers', dynamic: true },
  { name: 'I&M Bank',                  kind: 'html',   homepage: 'https://www.imbankgroup.com/ke',            url: 'https://www.imbankgroup.com/ke/about-us/careers/' },
  { name: 'DTB',                       kind: 'html',   homepage: 'https://dtbafrica.com',                     url: 'https://dtbafrica.com/careers' },
  { name: 'Family Bank',               kind: 'html',   homepage: 'https://familybank.co.ke',                  url: 'https://familybank.co.ke/?page_id=2696' },
  { name: 'Sidian Bank',               kind: 'html',   homepage: 'https://sidianbank.co.ke',                  url: 'https://www.sidianbank.co.ke/careers/' },
  { name: 'HF Group',                  kind: 'html',   homepage: 'https://hfgroup.co.ke',                     url: 'https://hfgroup.co.ke/careers/' },
  { name: 'Prime Bank',                kind: 'html',   homepage: 'https://www.primebank.co.ke',               url: 'https://www.primebank.co.ke/careers/' },
  { name: 'Bank of Africa Kenya',      kind: 'html',   homepage: 'https://www.boakenya.com',                  url: 'https://www.boakenya.com/careers/' },
  // ── Mid-tier & regional ─────────────────────────────────────────────────────
  { name: 'Access Bank Kenya',         kind: 'html',   homepage: 'https://kenya.accessbankplc.com',           url: 'https://www.accessbankplc.com/Kenya-Careers' },
  { name: 'ABC Bank Kenya',            kind: 'html',   homepage: 'https://abcthebank.com',                    url: 'https://abcthebank.com/careers/' },
  { name: 'Bank of Baroda Kenya',      kind: 'html',   homepage: 'https://www.bankofbarodakenya.co.ke',       url: 'https://www.bankofbarodakenya.com/careers/' },
  { name: 'Consolidated Bank Kenya',   kind: 'html',   homepage: 'https://www.consolidated-bank.com',         url: 'https://www.consolidated-bank.com/career-opportunities.php' },
  { name: 'Ecobank Kenya',             kind: 'html',   homepage: 'https://ecobank.com',                       url: 'https://ecobank.com/group/careers' },
  { name: 'Gulf African Bank',         kind: 'html',   homepage: 'https://gulfafricanbank.com',               url: 'https://gulfafricanbank.com/careers/' },
  { name: 'M-Oriental Bank',           kind: 'html',   homepage: 'https://morientalbank.co.ke',               url: 'https://www.moriental.co.ke/careers/' },
  { name: 'Paramount Bank Kenya',      kind: 'html',   homepage: 'https://paramountbank.co.ke',               url: 'https://paramountbank.co.ke/careers/' },
  { name: 'SBM Bank Kenya',            kind: 'html',   homepage: 'https://www.sbmbank.co.ke',                 url: 'https://www.sbmbank.co.ke/careers/' },
  { name: 'UBA Kenya',                 kind: 'html',   homepage: 'https://www.ubakenya.com',                  url: 'https://www.ubakenya.com/careers/' },
  // ── Additional licensed banks ────────────────────────────────────────────────
  { name: 'Citibank Kenya',            kind: 'html',   homepage: 'https://www.citigroup.com',                 url: 'https://jobs.citi.com/search-jobs/Kenya',             dynamic: true },
  { name: 'CIB Kenya',                 kind: 'html',   homepage: 'https://cibkenya.com',                      url: 'https://cibkenya.com/careers/' },
  { name: 'Credit Bank',               kind: 'html',   homepage: 'https://www.creditbank.co.ke',              url: 'https://www.creditbank.co.ke/careers/' },
  { name: 'Development Bank of Kenya', kind: 'html',   homepage: 'https://devbank.co.ke',                     url: 'https://devbank.co.ke/careers/' },
  { name: 'DIB Bank Kenya',            kind: 'html',   homepage: 'https://dibkenya.co.ke',                    url: 'https://dibkenya.co.ke/careers/' },
  { name: 'GTBank Kenya',              kind: 'html',   homepage: 'https://www.gtbank.co.ke',                  url: 'https://www.gtbank.co.ke/careers/' },
  { name: 'Guardian Bank',             kind: 'html',   homepage: 'https://guardian-bank.com',                 url: 'https://guardian-bank.com/careers/' },
  { name: 'Habib Bank Kenya',          kind: 'html',   homepage: 'https://habibbank.com',                     url: 'https://habibbank.com/careers/' },
  { name: 'Kingdom Bank',              kind: 'html',   homepage: 'https://kingdombankltd.co.ke',              url: 'https://kingdombankltd.co.ke/careers/' },
  { name: 'Middle East Bank Kenya',    kind: 'html',   homepage: 'https://mebkenya.com',                      url: 'https://mebkenya.com/careers/' },
  { name: 'National Bank of Kenya',    kind: 'html',   homepage: 'https://www.nationalbank.co.ke',            url: 'https://www.nationalbank.co.ke/careers' },
  { name: 'Premier Bank Kenya',        kind: 'html',   homepage: 'https://premierbank.co.ke',                 url: 'https://premierbank.co.ke/careers/' },
  { name: 'Victoria Commercial Bank',  kind: 'html',   homepage: 'https://victoriabank.co.ke',               url: 'https://victoriabank.co.ke/careers/' },
];

export interface ScrapeOptions {
  debug?: boolean;
  only?: string;
  industry?: string;
  sourceId?: string;   // scrape exactly one source by id (includes inactive — used by the Test button)
  vertical?: Vertical; // full runs scrape one vertical at a time (default jobs)
  onProgress?: (done: number, total: number, bankName: string) => void;
}

/** One-time migration: copy the hardcoded seed list into Mongo. */
export async function seedSourcesIfEmpty(): Promise<void> {
  const count = await ScrapeSourceModel.estimatedDocumentCount();
  if (count > 0) return;
  await ScrapeSourceModel.insertMany(
    SEED_SOURCES.map((s) => ({ ...s, industry: 'banking', isActive: true }))
  );
  logger.info({ count: SEED_SOURCES.length }, 'Seeded scrape sources from built-in list');
}

async function loadSources(industry?: string, sourceId?: string, vertical?: Vertical): Promise<BankDef[]> {
  await seedSourcesIfEmpty();
  const query: Record<string, unknown> = sourceId
    ? { _id: sourceId }  // explicit test — active or not
    : { isActive: true };
  if (!sourceId && industry) query.industry = industry.toLowerCase();
  if (!sourceId) query.vertical = vertical ?? 'jobs';
  const docs = await ScrapeSourceModel.find(query).lean();
  return docs.map((d): BankDef => {
    const v = ((d as any).vertical ?? 'jobs') as Vertical;
    if (d.kind === 'oracle') return { name: d.name, kind: 'oracle', vertical: v, homepage: d.homepage, tenant: d.tenant ?? '', siteNumber: d.siteNumber ?? '', locationId: d.locationId ?? 0, domain: d.domain || undefined };
    if (d.kind === 'workday') return { name: d.name, kind: 'workday', vertical: v, homepage: d.homepage, url: d.url ?? '' };
    return { name: d.name, kind: 'html', vertical: v, homepage: d.homepage, url: d.url ?? '', jobSelector: d.jobSelector || undefined, dynamic: d.dynamic ?? false, urlFilter: (d as any).urlFilter || undefined };
  });
}

export async function scrapeAllBanks(opts: ScrapeOptions = {}): Promise<BankResult[]> {
  const { debug = false, only, industry, sourceId, vertical, onProgress } = opts;
  const sources = await loadSources(industry, sourceId, vertical);
  const banks = only
    ? sources.filter((b) => b.name.toLowerCase().includes(only.toLowerCase()))
    : sources;
  let doneCount = 0;
  const progress = (bankName: string) => {
    doneCount += 1;
    try { onProgress?.(doneCount, banks.length, bankName); } catch { /* status only */ }
  };

  const tasks = banks.map((bank) => async (): Promise<BankResult> => {
    await new Promise((r) => setTimeout(r, 500 + Math.random() * 1000));
    try {
      if (bank.kind === 'oracle') {
        const jobs = await scrapeOracle(bank.tenant, bank.siteNumber, bank.locationId, bank.domain);
        logger.info({ bank: bank.name, count: jobs.length }, 'Scraped bank jobs (oracle)');
        progress(bank.name);
        return { bankName: bank.name, jobs };
      }
      if (bank.kind === 'workday') {
        const jobs = await scrapeWorkday(bank.url);
        logger.info({ bank: bank.name, count: jobs.length }, 'Scraped bank jobs (workday)');
        progress(bank.name);
        return { bankName: bank.name, jobs };
      }
      const { jobs, rejected, sourceUrl } = await scrapeHtml(
        bank.url, bank.homepage, bank.jobSelector, debug, bank.urlFilter, bank.vertical
      );
      const note = bank.dynamic && jobs.length === 0
        ? 'dynamic portal — needs ATS JSON endpoint or Playwright'
        : undefined;
      logger.info({ bank: bank.name, count: jobs.length, note }, 'Scraped bank jobs');
      progress(bank.name);
      return { bankName: bank.name, jobs, rejected: debug ? rejected : undefined, sourceUrl, note };
    } catch (err: any) {
      logger.warn({ bank: bank.name, err: err?.message }, 'Failed to scrape bank');
      progress(bank.name);
      return { bankName: bank.name, jobs: [], error: err?.message ?? 'Unknown error' };
    }
  });

  // 3 parallel sources — cheerio parsing is CPU-bound and the shared core also
  // has to keep serving HTTP (health checks, webhooks) during the scrape
  return withConcurrency(tasks, 3);
}
