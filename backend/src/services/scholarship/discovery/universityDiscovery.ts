import { env } from '../../../config/env';
import { logger } from '../../../config/logger';
import { UniversityModel } from '../../../models/scholarship/University';
import { normalizeDomain, cleanText, resolveUrl, domainOf } from '../normalize/text';
import { toCountryCode, toCountryName } from '../normalize/country';
import { fetchPage } from '../fetcher';
import { activeCountries } from '../seeds/countries';
import { seedsForCountries, type UniversitySeed } from '../seeds/universities';

/**
 * University discovery (§6).
 *
 * A provider proposes *candidates*. Nothing a provider returns is trusted:
 * every candidate goes through verifyUniversity() — a live fetch of its own
 * domain, checking that the site actually presents itself as a higher-education
 * institution — before it is promoted from UNVERIFIED to ACTIVE.
 *
 * This is what stops the registry filling up with essay mills, agency sites and
 * "top 10 universities" blogs, which is the failure mode of every naive
 * university crawler.
 */

export interface UniversityCandidate {
  name: string;
  domain: string;
  website?: string;
  country?: string;
  countryCode?: string;
  city?: string;
  type?: 'PUBLIC' | 'PRIVATE' | 'OTHER';
  discoverySource: string;
}

export interface DiscoveryContext {
  countryCodes: string[];
  limit: number;
  dryRun: boolean;
}

export interface UniversityDiscoveryProvider {
  readonly id: string;
  readonly description: string;
  isEnabled(): boolean;
  discover(ctx: DiscoveryContext): Promise<UniversityCandidate[]>;
}

// ── Provider 1: curated seed dataset ────────────────────────────────────────

export const DatasetProvider: UniversityDiscoveryProvider = {
  id: 'dataset:seed',
  description: 'Curated seed list of known institutions, used to bootstrap a country',
  isEnabled: () => true,
  async discover(ctx) {
    return seedsForCountries(ctx.countryCodes)
      .slice(0, ctx.limit)
      .map((s: UniversitySeed) => ({
        name: s.name,
        domain: s.domain,
        website: `https://${s.domain}`,
        country: s.country,
        countryCode: s.countryCode,
        city: s.city,
        type: s.type,
        discoverySource: 'dataset:seed'
      }));
  }
};

// ── Provider 2: remote dataset over HTTP ────────────────────────────────────

/**
 * Reads an external JSON dataset (e.g. a self-hosted copy of a public
 * university list). Disabled unless UNIVERSITY_DATASET_URL is configured, so
 * no third-party endpoint is contacted by default.
 *
 * Expected shape — permissive, since public datasets vary:
 *   [{ name, domains: ["x.edu"], country: "Kenya", "state-province": "Nairobi" }]
 */
export const RemoteDatasetProvider: UniversityDiscoveryProvider = {
  id: 'dataset:remote',
  description: 'External JSON dataset configured via UNIVERSITY_DATASET_URL',
  isEnabled: () => Boolean(env.UNIVERSITY_DATASET_URL),
  async discover(ctx) {
    const url = env.UNIVERSITY_DATASET_URL;
    if (!url) return [];
    let rows: any[] = [];
    try {
      const response = await fetch(url);
      if (!response.ok) {
        logger.warn({ url, status: response.status }, 'scholarship: remote university dataset unreachable');
        return [];
      }
      rows = await response.json();
    } catch (err) {
      logger.warn({ url, err }, 'scholarship: remote university dataset fetch/parse failed');
      return [];
    }
    if (!Array.isArray(rows)) return [];

    const wanted = new Set(ctx.countryCodes.map((c) => c.toUpperCase()));
    const out: UniversityCandidate[] = [];
    for (const row of rows) {
      const name = cleanText(String(row?.name ?? ''));
      const domainRaw = Array.isArray(row?.domains) ? row.domains[0] : (row?.domain ?? row?.website);
      if (!name || !domainRaw) continue;
      const code = toCountryCode(String(row?.country ?? row?.alpha_two_code ?? '')) ?? null;
      if (code && wanted.size > 0 && !wanted.has(code)) continue;
      out.push({
        name,
        domain: normalizeDomain(String(domainRaw)),
        website: Array.isArray(row?.web_pages) ? row.web_pages[0] : `https://${normalizeDomain(String(domainRaw))}`,
        country: toCountryName(code) ?? String(row?.country ?? ''),
        countryCode: code ?? undefined,
        city: row?.['state-province'] ? cleanText(String(row['state-province'])) : undefined,
        discoverySource: 'dataset:remote'
      });
      if (out.length >= ctx.limit) break;
    }
    return out;
  }
};

// ── Provider 3: link discovery from already-known institutions ──────────────

const UNIVERSITY_NAME_RE =
  /\b(university|universit[àéeya]|universidad|universidade|universiteit|universität|universitet|college|institute of technology|polytechnic|school of (?:medicine|law|business|engineering))\b/i;

/**
 * Harvests outbound links from pages of universities we already trust —
 * consortium members, partner institutions, exchange programme lists.
 *
 * Deliberately conservative: only links whose anchor text looks like an
 * institution name, only to domains we do not already have, and every result
 * still goes through verification.
 */
export const LinkDiscoveryProvider: UniversityDiscoveryProvider = {
  id: 'link:partners',
  description: 'Institution links harvested from verified university pages',
  isEnabled: () => true,
  async discover(ctx) {
    const seeds = await UniversityModel.find({
      status: 'ACTIVE',
      countryCode: { $in: ctx.countryCodes }
    })
      .select('domain website countryCode country')
      .limit(10)
      .lean();

    const known = new Set(
      (await UniversityModel.find({}).select('domain').lean()).map((u) => u.domain)
    );
    const out: UniversityCandidate[] = [];

    for (const seed of seeds) {
      if (out.length >= ctx.limit) break;
      const page = await fetchPage(seed.website ?? `https://${seed.domain}`, { allowBrowser: false });
      if (!page.ok) continue;

      for (const link of page.links) {
        if (out.length >= ctx.limit) break;
        const text = cleanText(link.text);
        if (!text || text.length < 6 || text.length > 120) continue;
        if (!UNIVERSITY_NAME_RE.test(text)) continue;

        const d = domainOf(link.href);
        if (!d || d === seed.domain || known.has(d)) continue;
        // Must at least look like an institutional domain
        if (!/\.(edu|ac\.[a-z]{2}|edu\.[a-z]{2}|ac\.[a-z]{2,3}|university|uni-[a-z]+\.[a-z]{2})$|\.(edu|ac)\./i.test(d)) continue;

        known.add(d);
        out.push({
          name: text,
          domain: d,
          website: `https://${d}`,
          countryCode: undefined, // resolved during verification
          discoverySource: `link:${seed.domain}`
        });
      }
    }
    return out;
  }
};

// ── Provider registry ───────────────────────────────────────────────────────

export const PROVIDERS: UniversityDiscoveryProvider[] = [
  DatasetProvider,
  RemoteDatasetProvider,
  LinkDiscoveryProvider
];

// ── Verification (§6) ───────────────────────────────────────────────────────

const HE_SIGNALS =
  /\b(university|college|institute|faculty|undergraduate|postgraduate|admissions?|campus|academic|students?|degree programmes?|degree programs?|research)\b/gi;

export interface VerificationResult {
  verified: boolean;
  httpStatus?: number;
  resolvedUrl?: string;
  titleMatch: boolean;
  reason: string;
  detectedName?: string;
  detectedCountryCode?: string;
}

/**
 * Confirm a candidate really is the institution it claims to be.
 *
 * Checks, in order:
 *   1. The domain resolves and returns a 2xx.
 *   2. The landing page reads like a higher-education site (signal density).
 *   3. The claimed name overlaps the site title, when we have a claimed name.
 *
 * Failing (3) alone does not reject — university sites often title themselves
 * "Home | UoN" — but it does lower confidence and is recorded.
 */
export async function verifyUniversity(candidate: UniversityCandidate): Promise<VerificationResult> {
  const url = candidate.website ?? `https://${candidate.domain}`;
  const page = await fetchPage(url, { allowBrowser: false });

  if (!page.ok) {
    return {
      verified: false,
      httpStatus: page.status,
      titleMatch: false,
      reason: page.blocked ? `blocked: ${page.blockedReason}` : `unreachable: ${page.error}`
    };
  }

  const haystack = `${page.title ?? ''} ${page.metaDescription ?? ''} ${page.text.slice(0, 6000)}`;
  const signals = (haystack.match(HE_SIGNALS) ?? []).length;
  if (signals < 5) {
    return {
      verified: false,
      httpStatus: page.status,
      resolvedUrl: page.finalUrl,
      titleMatch: false,
      reason: `insufficient higher-education signals (${signals})`
    };
  }

  // The final URL must still be on the claimed domain — a redirect to a
  // marketing aggregator is a rejection, not a pass.
  const finalDomain = domainOf(page.finalUrl);
  const claimed = normalizeDomain(candidate.domain);
  if (finalDomain !== claimed && !finalDomain.endsWith(`.${claimed}`) && !claimed.endsWith(`.${finalDomain}`)) {
    return {
      verified: false,
      httpStatus: page.status,
      resolvedUrl: page.finalUrl,
      titleMatch: false,
      reason: `redirects off-domain to ${finalDomain}`
    };
  }

  const title = (page.title ?? '').toLowerCase();
  const nameTokens = candidate.name.toLowerCase().split(/\s+/).filter((t) => t.length > 3);
  const titleMatch = nameTokens.length === 0 || nameTokens.some((t) => title.includes(t));

  return {
    verified: true,
    httpStatus: page.status,
    resolvedUrl: page.finalUrl,
    titleMatch,
    reason: titleMatch ? 'verified' : 'verified (title does not echo the claimed name)',
    detectedName: page.title ? cleanText(page.title).slice(0, 200) : undefined
  };
}

// ── Orchestration ───────────────────────────────────────────────────────────

export interface DiscoveryOutcome {
  candidates: number;
  created: number;
  updated: number;
  verified: number;
  rejected: { domain: string; reason: string }[];
}

/**
 * Run every enabled provider, dedupe by canonical domain, verify, upsert.
 *
 * Dedup happens twice on purpose: once in-memory across providers (two
 * providers proposing Oxford), once against the database (unique index on
 * `domain` is the final backstop).
 */
export async function discoverUniversities(
  opts: { countryCodes?: string[]; limit?: number; dryRun?: boolean; verify?: boolean } = {}
): Promise<DiscoveryOutcome> {
  const countryCodes = opts.countryCodes?.length
    ? opts.countryCodes.map((c) => c.toUpperCase())
    : activeCountries().map((c) => c.code);
  const limit = opts.limit ?? 200;
  const dryRun = opts.dryRun ?? false;
  const shouldVerify = opts.verify ?? true;

  const ctx: DiscoveryContext = { countryCodes, limit, dryRun };
  const outcome: DiscoveryOutcome = { candidates: 0, created: 0, updated: 0, verified: 0, rejected: [] };

  const byDomain = new Map<string, UniversityCandidate>();
  for (const provider of PROVIDERS) {
    if (!provider.isEnabled()) continue;
    try {
      const found = await provider.discover(ctx);
      for (const c of found) {
        const d = normalizeDomain(c.domain);
        if (!d || !d.includes('.')) continue;
        if (!byDomain.has(d)) byDomain.set(d, { ...c, domain: d });
      }
      logger.info({ provider: provider.id, found: found.length }, 'scholarship: discovery provider finished');
    } catch (err) {
      // One bad provider must never abort discovery (§37)
      logger.error({ err, provider: provider.id }, 'scholarship: discovery provider failed');
    }
  }

  outcome.candidates = byDomain.size;
  if (dryRun) return outcome;

  for (const candidate of byDomain.values()) {
    try {
      const existing = await UniversityModel.findOne({ domain: candidate.domain }).lean();

      // Already ACTIVE and verified recently — skip the network round trip
      if (existing && existing.status === 'ACTIVE' && existing.lastVerifiedAt) {
        const ageDays = (Date.now() - new Date(existing.lastVerifiedAt).getTime()) / 86_400_000;
        if (ageDays < 30) continue;
      }

      let verification: VerificationResult | null = null;
      if (shouldVerify) {
        verification = await verifyUniversity(candidate);
        if (!verification.verified) {
          outcome.rejected.push({ domain: candidate.domain, reason: verification.reason });
          await UniversityModel.updateOne(
            { domain: candidate.domain },
            {
              $set: {
                status: 'UNVERIFIED',
                verification: {
                  httpStatus: verification.httpStatus,
                  resolvedUrl: verification.resolvedUrl,
                  titleMatch: verification.titleMatch,
                  checkedAt: new Date(),
                  reason: verification.reason
                }
              },
              $setOnInsert: {
                name: candidate.name,
                website: candidate.website ?? `https://${candidate.domain}`,
                country: candidate.country ?? 'Unknown',
                countryCode: candidate.countryCode,
                discoverySource: candidate.discoverySource,
                discoveredAt: new Date()
              }
            },
            { upsert: true }
          );
          continue;
        }
        outcome.verified += 1;
      }

      const set: Record<string, unknown> = {
        name: candidate.name,
        website: candidate.website ?? `https://${candidate.domain}`,
        country: candidate.country ?? toCountryName(candidate.countryCode ?? '') ?? 'Unknown',
        status: shouldVerify ? 'ACTIVE' : 'UNVERIFIED',
        discoverySource: candidate.discoverySource
      };
      if (candidate.countryCode) set.countryCode = candidate.countryCode;
      if (candidate.city) set.city = candidate.city;
      if (candidate.type) set.type = candidate.type;
      if (verification) {
        set.lastVerifiedAt = new Date();
        set.verification = {
          httpStatus: verification.httpStatus,
          resolvedUrl: verification.resolvedUrl,
          titleMatch: verification.titleMatch,
          checkedAt: new Date(),
          reason: verification.reason
        };
      }

      const res = await UniversityModel.updateOne(
        { domain: candidate.domain },
        { $set: set, $setOnInsert: { domain: candidate.domain, discoveredAt: new Date() } },
        { upsert: true }
      );
      if (res.upsertedCount > 0) outcome.created += 1;
      else if (res.modifiedCount > 0) outcome.updated += 1;
    } catch (err) {
      logger.error({ err, domain: candidate.domain }, 'scholarship: failed to persist university candidate');
    }
  }

  return outcome;
}
