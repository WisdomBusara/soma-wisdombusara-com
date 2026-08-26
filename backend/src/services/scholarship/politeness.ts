import axios from 'axios';
import { env } from '../../config/env';
import { logger } from '../../config/logger';
import { domainOf } from './normalize/text';

/**
 * Crawl politeness (§28, §48).
 *
 * Three separate concerns, deliberately kept in one small module because they
 * all key off the same thing — the domain:
 *
 *   1. robots.txt: is this path allowed at all?
 *   2. per-domain concurrency: never more than N in flight to one host
 *   3. per-domain delay: minimum gap between requests to one host
 *
 * Nothing here attempts to defeat any protection. A disallowed path is simply
 * not fetched, and a 429/403 escalates the backoff for that domain.
 */

// ── robots.txt ──────────────────────────────────────────────────────────────

interface RobotsRules {
  /** Path prefixes disallowed for our agent (or *) */
  disallow: string[];
  allow: string[];
  crawlDelayMs: number | null;
  fetchedAt: number;
  /** True when robots.txt was unreachable — we then default to permissive
   *  for public pages, which is standard crawler behaviour. */
  unavailable: boolean;
}

const ROBOTS_TTL_MS = 12 * 60 * 60 * 1000;
const robotsCache = new Map<string, RobotsRules>();

function parseRobots(body: string, agent: string): RobotsRules {
  const lines = body.split(/\r?\n/);
  const groups: { agents: string[]; disallow: string[]; allow: string[]; delay: number | null }[] = [];
  let current: (typeof groups)[number] | null = null;
  let lastWasAgent = false;

  for (const raw of lines) {
    const line = raw.split('#')[0].trim();
    if (!line) continue;
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const field = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();

    if (field === 'user-agent') {
      if (!current || !lastWasAgent) {
        current = { agents: [], disallow: [], allow: [], delay: null };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (!current) continue;
    if (field === 'disallow') current.disallow.push(value);
    else if (field === 'allow') current.allow.push(value);
    else if (field === 'crawl-delay') {
      const n = Number(value);
      if (Number.isFinite(n) && n >= 0) current.delay = Math.min(n, 60) * 1000;
    }
  }

  const ua = agent.toLowerCase();
  // Most specific match wins: our token, then *, then nothing
  const named = groups.find((g) => g.agents.some((a) => a !== '*' && ua.includes(a)));
  const star = groups.find((g) => g.agents.includes('*'));
  const chosen = named ?? star;

  return {
    disallow: (chosen?.disallow ?? []).filter((d) => d !== ''),
    allow: chosen?.allow ?? [],
    crawlDelayMs: chosen?.delay ?? null,
    fetchedAt: Date.now(),
    unavailable: false
  };
}

async function getRobots(domain: string): Promise<RobotsRules> {
  const cached = robotsCache.get(domain);
  if (cached && Date.now() - cached.fetchedAt < ROBOTS_TTL_MS) return cached;

  const agentToken = env.SCHOLARSHIP_USER_AGENT.split('/')[0];
  let rules: RobotsRules;
  try {
    const res = await axios.get(`https://${domain}/robots.txt`, {
      timeout: 10_000,
      maxRedirects: 3,
      responseType: 'text',
      headers: { 'User-Agent': env.SCHOLARSHIP_USER_AGENT },
      validateStatus: (s) => s < 500
    });
    rules =
      res.status === 200 && typeof res.data === 'string'
        ? parseRobots(res.data, agentToken)
        : { disallow: [], allow: [], crawlDelayMs: null, fetchedAt: Date.now(), unavailable: true };
  } catch {
    rules = { disallow: [], allow: [], crawlDelayMs: null, fetchedAt: Date.now(), unavailable: true };
  }
  robotsCache.set(domain, rules);
  return rules;
}

function pathMatches(rule: string, path: string): boolean {
  if (!rule) return false;
  // Support the de-facto * wildcard and $ anchor
  if (rule.includes('*') || rule.endsWith('$')) {
    const pattern =
      '^' +
      rule
        .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
        .replace(/\*/g, '.*')
        .replace(/\\\$$/, '$');
    try {
      return new RegExp(pattern).test(path);
    } catch {
      return false;
    }
  }
  return path.startsWith(rule);
}

export interface RobotsVerdict {
  allowed: boolean;
  reason?: string;
  crawlDelayMs: number | null;
}

/** Is `url` fetchable under the site's robots.txt? */
export async function isAllowedByRobots(url: string): Promise<RobotsVerdict> {
  if (!env.SCHOLARSHIP_RESPECT_ROBOTS) return { allowed: true, crawlDelayMs: null };
  let path: string;
  let domain: string;
  try {
    const u = new URL(url);
    path = u.pathname + u.search;
    domain = u.hostname;
  } catch {
    return { allowed: false, reason: 'unparseable url', crawlDelayMs: null };
  }

  const rules = await getRobots(domain);
  if (rules.unavailable) return { allowed: true, crawlDelayMs: null };

  // Longest matching rule wins; Allow beats Disallow at equal length (RFC 9309)
  let bestDisallow = -1;
  let bestAllow = -1;
  for (const d of rules.disallow) if (pathMatches(d, path)) bestDisallow = Math.max(bestDisallow, d.length);
  for (const a of rules.allow) if (pathMatches(a, path)) bestAllow = Math.max(bestAllow, a.length);

  if (bestDisallow >= 0 && bestAllow >= bestDisallow) {
    return { allowed: true, crawlDelayMs: rules.crawlDelayMs };
  }
  if (bestDisallow >= 0) {
    return { allowed: false, reason: 'disallowed by robots.txt', crawlDelayMs: rules.crawlDelayMs };
  }
  return { allowed: true, crawlDelayMs: rules.crawlDelayMs };
}

export function clearRobotsCache(): void {
  robotsCache.clear();
}

// ── Per-domain gate: concurrency + delay + backoff ──────────────────────────

interface DomainState {
  inFlight: number;
  lastRequestAt: number;
  queue: (() => void)[];
  /** Extra delay imposed after 429/503, decays on success */
  penaltyMs: number;
  blockedUntil: number;
}

const domains = new Map<string, DomainState>();

function stateFor(domain: string): DomainState {
  let s = domains.get(domain);
  if (!s) {
    s = { inFlight: 0, lastRequestAt: 0, queue: [], penaltyMs: 0, blockedUntil: 0 };
    domains.set(domain, s);
  }
  return s;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Run `fn` under this domain's politeness budget.
 *
 * Serialises through a small queue rather than a semaphore library so there is
 * one less dependency and the behaviour is easy to reason about: at most
 * DOMAIN_CONCURRENCY in flight, and at least REQUEST_DELAY_MS between starts.
 */
export async function withDomainPoliteness<T>(
  url: string,
  fn: () => Promise<T>,
  opts: { extraDelayMs?: number } = {}
): Promise<T> {
  const domain = domainOf(url);
  const s = stateFor(domain);
  const limit = env.SCHOLARSHIP_DOMAIN_CONCURRENCY;

  if (s.inFlight >= limit) {
    await new Promise<void>((resolve) => s.queue.push(resolve));
  }
  s.inFlight += 1;

  try {
    if (s.blockedUntil > Date.now()) {
      const wait = s.blockedUntil - Date.now();
      logger.debug({ domain, wait }, 'scholarship: domain in backoff, waiting');
      await sleep(Math.min(wait, 60_000));
    }
    const minGap = Math.max(env.SCHOLARSHIP_REQUEST_DELAY_MS, opts.extraDelayMs ?? 0) + s.penaltyMs;
    const since = Date.now() - s.lastRequestAt;
    if (since < minGap) await sleep(minGap - since);
    s.lastRequestAt = Date.now();
    return await fn();
  } finally {
    s.inFlight -= 1;
    const next = s.queue.shift();
    if (next) next();
  }
}

/** Escalate backoff after a rate-limit or server error. */
export function penalizeDomain(url: string, status?: number): void {
  const s = stateFor(domainOf(url));
  if (status === 429 || status === 503) {
    s.penaltyMs = Math.min(s.penaltyMs === 0 ? 5_000 : s.penaltyMs * 2, 300_000);
    s.blockedUntil = Date.now() + s.penaltyMs;
  } else if (status && status >= 500) {
    s.penaltyMs = Math.min(s.penaltyMs === 0 ? 2_000 : s.penaltyMs * 1.5, 60_000);
  }
}

/** Decay backoff after a clean response. */
export function rewardDomain(url: string): void {
  const s = stateFor(domainOf(url));
  if (s.penaltyMs > 0) s.penaltyMs = Math.floor(s.penaltyMs / 2);
  if (s.penaltyMs < 500) s.penaltyMs = 0;
}

export function domainStats(): { domain: string; inFlight: number; penaltyMs: number; blockedUntil: number }[] {
  return [...domains.entries()].map(([domain, s]) => ({
    domain, inFlight: s.inFlight, penaltyMs: s.penaltyMs, blockedUntil: s.blockedUntil
  }));
}

export function resetPoliteness(): void {
  domains.clear();
}
