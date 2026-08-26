import axios, { type AxiosResponse } from 'axios';
import * as cheerio from 'cheerio';
import { env } from '../../config/env';
import { logger } from '../../config/logger';
import { contentHash, cleanText, resolveUrl, canonicalUrl } from './normalize/text';
import { isAllowedByRobots, withDomainPoliteness, penalizeDomain, rewardDomain } from './politeness';

/**
 * Fetch layer (§10, §11, §28).
 *
 * Order of operations, and why:
 *
 *   robots check → HTTP GET → content-quality gate → (Playwright only if the
 *   gate fails and rendering is enabled) → parse
 *
 * Playwright is a fallback, never the default: it costs ~50–100× an HTTP
 * request. The quality gate is what keeps it rare — most university pages are
 * server-rendered and never touch it.
 *
 * Both Playwright and the PDF parser are loaded with a lazy `require` inside a
 * try/catch. That is intentional: neither is a hard dependency, so the service
 * builds, boots and crawls HTML correctly on a machine where they are not
 * installed. Missing optional deps degrade a capability, they do not crash the
 * process.
 */

export type FetchMethod = 'HTTP' | 'BROWSER' | 'PDF' | 'CACHED';

export interface FetchResult {
  ok: boolean;
  url: string;
  finalUrl: string;
  status?: number;
  contentType: string;
  method: FetchMethod;
  html?: string;
  /** Extracted, readable text — the input to classification and extraction */
  text: string;
  title?: string;
  metaDescription?: string;
  headings: string[];
  links: { text: string; href: string; context: string }[];
  structuredDataTypes: string[];
  contentHash?: string;
  bytes: number;
  durationMs: number;
  error?: string;
  blocked?: boolean;
  blockedReason?: string;
}

const HTTP = axios.create({
  timeout: env.SCHOLARSHIP_REQUEST_TIMEOUT,
  maxRedirects: 5,
  maxContentLength: env.SCHOLARSHIP_MAX_PAGE_BYTES,
  headers: {
    'User-Agent': env.SCHOLARSHIP_USER_AGENT,
    Accept: 'text/html,application/xhtml+xml,application/pdf,application/json;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en'
  },
  // We want to inspect 4xx ourselves rather than throw
  validateStatus: (s) => s >= 200 && s < 500
});

const failed = (url: string, error: string, extra: Partial<FetchResult> = {}): FetchResult => ({
  ok: false, url, finalUrl: url, contentType: '', method: 'HTTP', text: '',
  headings: [], links: [], structuredDataTypes: [], bytes: 0, durationMs: 0, error, ...extra
});

// ── Parsing ─────────────────────────────────────────────────────────────────

/**
 * Turn HTML into the structured shape the classifier needs.
 *
 * Nav/header/footer/script/style are dropped before text extraction — leaving
 * them in makes every page on a university site look ~40% identical, which
 * poisons both classification density checks and content hashing.
 */
export function parseHtml(html: string, baseUrl: string) {
  const $ = cheerio.load(html);

  $('script, style, noscript, svg, iframe, form input, template').remove();

  const title = cleanText($('title').first().text() || $('h1').first().text());
  const metaDescription = cleanText(
    $('meta[name="description"]').attr('content') ??
    $('meta[property="og:description"]').attr('content') ??
    ''
  );

  const structuredDataTypes: string[] = [];
  $('script[type="application/ld+json"]').each((_i, el) => {
    try {
      const parsed = JSON.parse($(el).contents().text());
      const walk = (node: any) => {
        if (!node || typeof node !== 'object') return;
        if (Array.isArray(node)) return node.forEach(walk);
        if (node['@type']) {
          const t = node['@type'];
          (Array.isArray(t) ? t : [t]).forEach((x: unknown) => structuredDataTypes.push(String(x)));
        }
        Object.values(node).forEach(walk);
      };
      walk(parsed);
    } catch {
      /* malformed JSON-LD is common and not worth logging */
    }
  });

  const headings: string[] = [];
  $('h1, h2, h3, h4').each((_i, el) => {
    const t = cleanText($(el).text());
    if (t && t.length < 250) headings.push(t);
  });

  const links: FetchResult['links'] = [];
  const seen = new Set<string>();
  $('a[href]').each((_i, el) => {
    const href = resolveUrl($(el).attr('href') ?? '', baseUrl);
    if (!href) return;
    const key = canonicalUrl(href);
    if (seen.has(key)) return;
    seen.add(key);
    const text = cleanText($(el).text());
    // Context = the surrounding block, which is where deadline/funding hints
    // live when the anchor text itself is just "Find out more"
    const context = cleanText($(el).closest('li, p, td, div, article, section').first().text()).slice(0, 400);
    links.push({ text, href, context });
  });

  // Prefer the main content region when the page marks one
  const mainSel = ['main', 'article', '[role="main"]', '#main-content', '#content', '.main-content'];
  let scope: cheerio.Cheerio<any> = $('body');
  for (const sel of mainSel) {
    const el = $(sel).first();
    if (el.length && cleanText(el.text()).length > 400) { scope = el; break; }
  }
  scope.find('nav, header, footer, aside, .nav, .navbar, .footer, .cookie, .breadcrumb').remove();

  const text = cleanText(scope.text());

  return { $, title, metaDescription, headings, links, structuredDataTypes, text };
}

/**
 * Content-quality gate (§10).
 *
 * Returns true when the HTML looks like it needs JS to render. The heuristics
 * are deliberately conservative — a false "needs browser" is expensive, while
 * a false "good enough" only costs us one page.
 */
export function needsBrowserRender(html: string, parsedText: string): boolean {
  if (!html) return true;
  const textLength = parsedText.length;

  // Plenty of readable text — no reason to render
  if (textLength > 900) return false;

  // Classic SPA shells
  if (/<div[^>]+id=["'](root|app|__next|__nuxt)["'][^>]*>\s*<\/div>/i.test(html)) return true;
  if (/window\.__(INITIAL_STATE|NUXT|NEXT_DATA)__/.test(html)) return true;
  if (/<noscript>[^<]*(enable\s+javascript|requires\s+javascript)/i.test(html)) return true;

  // Lots of markup, almost no text = client-rendered
  const ratio = textLength / Math.max(html.length, 1);
  if (html.length > 6_000 && ratio < 0.03) return true;

  return textLength < 250;
}

// ── PDF (§11) ───────────────────────────────────────────────────────────────

let pdfParseFn: ((buf: Buffer) => Promise<{ text: string; info?: any }>) | null | undefined;

function loadPdfParser() {
  if (pdfParseFn !== undefined) return pdfParseFn;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require('pdf-parse');
    pdfParseFn = (mod.default ?? mod) as typeof pdfParseFn;
  } catch {
    logger.warn('scholarship: pdf-parse not installed — PDF sources will be skipped. Run: npm i pdf-parse');
    pdfParseFn = null;
  }
  return pdfParseFn;
}

export async function extractPdfText(buffer: Buffer): Promise<{ text: string; title?: string } | null> {
  const parse = loadPdfParser();
  if (!parse) return null;
  try {
    const data = await parse(buffer);
    const text = cleanText(String(data.text ?? ''));
    const title = data.info?.Title ? cleanText(String(data.info.Title)) : undefined;
    return { text, title };
  } catch (err) {
    logger.warn({ err }, 'scholarship: PDF parse failed');
    return null;
  }
}

// ── Browser (§10) ───────────────────────────────────────────────────────────

let browserPromise: Promise<any> | null = null;

async function getBrowser(): Promise<any | null> {
  if (!env.PLAYWRIGHT_ENABLED) return null;
  if (browserPromise) return browserPromise;
  browserPromise = (async () => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { chromium } = require('playwright');
      return await chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] });
    } catch (err) {
      logger.warn({ err }, 'scholarship: Playwright unavailable — JS pages will be skipped. Run: npm i playwright && npx playwright install chromium');
      return null;
    }
  })();
  return browserPromise;
}

export async function closeBrowser(): Promise<void> {
  if (!browserPromise) return;
  try {
    const b = await browserPromise;
    if (b) await b.close();
  } catch { /* shutdown path */ }
  browserPromise = null;
}

async function renderWithBrowser(url: string): Promise<{ html: string; finalUrl: string } | null> {
  const browser = await getBrowser();
  if (!browser) return null;
  let context: any;
  try {
    context = await browser.newContext({
      userAgent: env.SCHOLARSHIP_USER_AGENT,
      // Block heavy assets — we only ever want the DOM
      viewport: { width: 1280, height: 1600 }
    });
    const page = await context.newPage();
    await page.route('**/*', (route: any) => {
      const type = route.request().resourceType();
      if (type === 'image' || type === 'media' || type === 'font') return route.abort();
      return route.continue();
    });
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: env.PLAYWRIGHT_TIMEOUT });
    // Give client-side routers a moment, but never block the run on it
    await page.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => undefined);
    const html = await page.content();
    const finalUrl = page.url();
    return { html, finalUrl };
  } catch (err) {
    logger.warn({ err, url }, 'scholarship: browser render failed');
    return null;
  } finally {
    if (context) await context.close().catch(() => undefined);
  }
}

// ── Main entry point ────────────────────────────────────────────────────────

export interface FetchOptions {
  /** Skip work entirely when the content has not changed (§54) */
  knownContentHash?: string;
  allowBrowser?: boolean;
  timeoutMs?: number;
}

export async function fetchPage(url: string, opts: FetchOptions = {}): Promise<FetchResult> {
  const started = Date.now();

  const robots = await isAllowedByRobots(url);
  if (!robots.allowed) {
    return failed(url, robots.reason ?? 'blocked by robots.txt', {
      blocked: true, blockedReason: 'ROBOTS', durationMs: Date.now() - started
    });
  }

  let res: AxiosResponse;
  try {
    res = await withDomainPoliteness(
      url,
      () => HTTP.get(url, {
        responseType: 'arraybuffer',
        timeout: opts.timeoutMs ?? env.SCHOLARSHIP_REQUEST_TIMEOUT
      }),
      { extraDelayMs: robots.crawlDelayMs ?? 0 }
    );
  } catch (err: any) {
    const status = err?.response?.status;
    if (status) penalizeDomain(url, status);
    return failed(url, err?.code ?? err?.message ?? 'request failed', {
      status, durationMs: Date.now() - started
    });
  }

  const status = res.status;
  const contentType = String(res.headers['content-type'] ?? '').toLowerCase();
  const finalUrl = (res.request?.res?.responseUrl as string) ?? url;
  const raw: Buffer = Buffer.isBuffer(res.data) ? res.data : Buffer.from(res.data ?? '');
  const bytes = raw.byteLength;

  if (status === 403 || status === 401 || status === 429) {
    penalizeDomain(url, status);
    // 401/403 means access-controlled. We stop; we do not attempt to work around it (§48).
    return failed(url, `HTTP ${status}`, {
      status, blocked: true, blockedReason: status === 429 ? 'RATE_LIMITED' : 'ACCESS_DENIED',
      durationMs: Date.now() - started, bytes
    });
  }
  if (status >= 400) {
    return failed(url, `HTTP ${status}`, { status, durationMs: Date.now() - started, bytes });
  }
  rewardDomain(url);

  if (bytes > env.SCHOLARSHIP_MAX_PAGE_BYTES) {
    return failed(url, 'response exceeds max page size', { status, bytes, durationMs: Date.now() - started });
  }

  // ── PDF path ──────────────────────────────────────────────────────────────
  if (contentType.includes('application/pdf') || /\.pdf(\?|$)/i.test(finalUrl)) {
    const pdf = await extractPdfText(raw);
    if (!pdf) {
      return failed(url, 'pdf-parse unavailable or failed', {
        status, contentType, bytes, method: 'PDF', durationMs: Date.now() - started
      });
    }
    const hash = contentHash(pdf.text);
    if (opts.knownContentHash && opts.knownContentHash === hash) {
      return {
        ok: true, url, finalUrl, status, contentType, method: 'CACHED', text: pdf.text,
        title: pdf.title, headings: [], links: [], structuredDataTypes: [],
        contentHash: hash, bytes, durationMs: Date.now() - started
      };
    }
    return {
      ok: true, url, finalUrl, status, contentType, method: 'PDF', text: pdf.text,
      title: pdf.title, headings: [], links: [], structuredDataTypes: [],
      contentHash: hash, bytes, durationMs: Date.now() - started
    };
  }

  // ── JSON / XML / RSS ──────────────────────────────────────────────────────
  if (contentType.includes('json') || contentType.includes('xml')) {
    const body = raw.toString('utf8');
    const text = contentType.includes('json')
      ? cleanText(body.replace(/[{}[\]",]/g, ' '))
      : cleanText(cheerio.load(body, { xml: true }).root().text());
    const hash = contentHash(text);
    return {
      ok: true, url, finalUrl, status, contentType,
      method: opts.knownContentHash === hash ? 'CACHED' : 'HTTP',
      text, headings: [], links: [], structuredDataTypes: [],
      contentHash: hash, bytes, durationMs: Date.now() - started
    };
  }

  if (!contentType.includes('html') && contentType && !contentType.includes('text/plain')) {
    return failed(url, `unsupported content-type: ${contentType}`, {
      status, contentType, bytes, durationMs: Date.now() - started
    });
  }

  // ── HTML path ─────────────────────────────────────────────────────────────
  let html = raw.toString('utf8');
  let parsed = parseHtml(html, finalUrl);
  let method: FetchMethod = 'HTTP';

  const allowBrowser = opts.allowBrowser !== false && env.PLAYWRIGHT_ENABLED;
  if (allowBrowser && needsBrowserRender(html, parsed.text)) {
    const rendered = await withDomainPoliteness(url, () => renderWithBrowser(url));
    if (rendered && rendered.html) {
      const reparsed = parseHtml(rendered.html, rendered.finalUrl);
      // Only accept the render if it actually produced more content
      if (reparsed.text.length > parsed.text.length) {
        html = rendered.html;
        parsed = reparsed;
        method = 'BROWSER';
      }
    }
  }

  const hash = contentHash(parsed.text);
  if (opts.knownContentHash && opts.knownContentHash === hash) method = 'CACHED';

  return {
    ok: true,
    url,
    finalUrl,
    status,
    contentType: contentType || 'text/html',
    method,
    html,
    text: parsed.text,
    title: parsed.title,
    metaDescription: parsed.metaDescription,
    headings: parsed.headings,
    links: parsed.links,
    structuredDataTypes: parsed.structuredDataTypes,
    contentHash: hash,
    bytes,
    durationMs: Date.now() - started
  };
}
