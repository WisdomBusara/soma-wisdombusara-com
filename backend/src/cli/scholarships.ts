#!/usr/bin/env node
import 'dotenv/config';
import { connectMongo } from '../db/mongo';
import { logger } from '../config/logger';
import { env } from '../config/env';
import mongoose from 'mongoose';

import { UniversityModel } from '../models/scholarship/University';
import { ScholarshipModel } from '../models/scholarship/Scholarship';
import { CrawlTargetModel } from '../models/scholarship/operational';
import { PlanModel } from '../models/Plan';
import { discoverUniversities } from '../services/scholarship/discovery/universityDiscovery';
import { discoverScholarshipUrls, discoverForDueUniversities } from '../services/scholarship/discovery/scholarshipDiscovery';
import { runCrawl, processUrl } from '../services/scholarship/pipeline';
import { refreshStatuses } from '../services/scholarship/status';
import { runScholarshipCycle, engineMetrics } from '../services/scholarship/scholarshipScheduler';
import { closeBrowser } from '../services/scholarship/fetcher';
import { ensureScholarshipIndexes } from '../services/scholarship/indexes';
import { seedsForCountries } from '../services/scholarship/seeds/universities';
import { activeCountries } from '../services/scholarship/seeds/countries';
import { cleanupExpiredScholarships, reportNewDiscoveries } from '../services/scholarship/cleanup';

/**
 * Operations CLI (§50, §51).
 *
 * Every command supports --dry-run, which performs all the reading and
 * classification and writes nothing. That is what makes this safe to point at
 * production while developing.
 *
 * Usage:
 *   npm run scholarships:discover-universities -- --countries=KE,GB --limit=50
 *   npm run scholarships:discover             -- --university=<id>
 *   npm run scholarships:crawl                -- --limit=25 --dry-run
 *   npm run scholarships:extract              -- --url=https://…
 *   npm run scholarships:verify               -- --scholarship=<id>
 *   npm run scholarships:status
 *   npm run scholarships:seed                 -- --countries=KE
 */

interface Args {
  _: string[];
  [key: string]: string | boolean | string[];
}

function parseArgs(argv: string[]): Args {
  const args: Args = { _: [] };
  for (const raw of argv) {
    if (raw.startsWith('--')) {
      const [k, ...rest] = raw.slice(2).split('=');
      args[k] = rest.length > 0 ? rest.join('=') : true;
    } else {
      args._.push(raw);
    }
  }
  return args;
}

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const num = (v: unknown): number | undefined => {
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
};
const list = (v: unknown): string[] | undefined => {
  const s = str(v);
  return s ? s.split(',').map((x) => x.trim().toUpperCase()).filter(Boolean) : undefined;
};

function out(label: string, data: unknown): void {
  // eslint-disable-next-line no-console
  console.log(`\n── ${label} ${'─'.repeat(Math.max(0, 60 - label.length))}\n`);
  // eslint-disable-next-line no-console
  console.log(typeof data === 'string' ? data : JSON.stringify(data, null, 2));
}

// ── Commands ────────────────────────────────────────────────────────────────

async function cmdSeed(args: Args): Promise<void> {
  const codes = list(args.countries) ?? activeCountries().map((c) => c.code);
  const seeds = seedsForCountries(codes);
  const dryRun = Boolean(args['dry-run']);

  out('SEED', { countries: codes, seedCount: seeds.length, dryRun });
  if (dryRun) {
    out('WOULD SEED', seeds.map((s) => `${s.name} (${s.domain}) — ${s.country}`));
    return;
  }

  // Seeds are inserted UNVERIFIED. Nothing is crawled until discovery has
  // verified the domain — see §6.
  let created = 0;
  for (const s of seeds) {
    const res = await UniversityModel.updateOne(
      { domain: s.domain },
      {
        $setOnInsert: {
          domain: s.domain, name: s.name, website: `https://${s.domain}`,
          country: s.country, countryCode: s.countryCode, city: s.city, type: s.type,
          status: 'UNVERIFIED', discoverySource: 'cli:seed', discoveredAt: new Date()
        }
      },
      { upsert: true }
    );
    if (res.upsertedCount > 0) created += 1;
  }
  out('RESULT', { created, existing: seeds.length - created, note: 'run discover-universities to verify and activate' });
}

async function cmdDiscoverUniversities(args: Args): Promise<void> {
  const outcome = await discoverUniversities({
    countryCodes: list(args.countries),
    limit: num(args.limit) ?? 200,
    dryRun: Boolean(args['dry-run']),
    verify: args.verify !== 'false'
  });
  out('UNIVERSITY DISCOVERY', outcome);
  if (outcome.rejected.length > 0) out('REJECTED', outcome.rejected.slice(0, 30));
}

async function cmdDiscover(args: Args): Promise<void> {
  const dryRun = Boolean(args['dry-run']);
  const universityId = str(args.university);

  if (universityId) {
    const result = await discoverScholarshipUrls(universityId, { dryRun });
    out('SCHOLARSHIP URL DISCOVERY', {
      university: result.universityName,
      probed: result.probed,
      found: result.hits.length,
      created: result.targetsCreated,
      existing: result.targetsExisting,
      errors: result.errors.slice(0, 5)
    });
    out('URLS', result.hits);
    return;
  }

  const r = await discoverForDueUniversities({
    limit: num(args.limit) ?? 10,
    dryRun,
    countryCodes: list(args.countries)
  });
  out('SCHOLARSHIP URL DISCOVERY', {
    processed: r.processed,
    totalFound: r.results.reduce((s, x) => s + x.hits.length, 0),
    totalCreated: r.results.reduce((s, x) => s + x.targetsCreated, 0),
    perUniversity: r.results.map((x) => ({ university: x.universityName, found: x.hits.length, created: x.targetsCreated }))
  });
}

async function cmdCrawl(args: Args): Promise<void> {
  const dryRun = Boolean(args['dry-run']);
  const summary = await runCrawl({
    limit: num(args.limit) ?? 25,
    dryRun,
    trigger: 'CLI',
    universityId: str(args.university),
    allowAi: args['no-ai'] ? false : undefined,
    onProgress: (done, total, url) => logger.info({ done, total, url }, 'crawl progress')
  });

  out(dryRun ? 'CRAWL (DRY RUN)' : 'CRAWL', { runId: summary.runId, processed: summary.processed, ...summary.metrics });

  const grouped: Record<string, number> = {};
  for (const r of summary.results) grouped[r.status] = (grouped[r.status] ?? 0) + 1;
  out('OUTCOMES', grouped);
  out('DETAIL', summary.results.slice(0, 40).map((r) =>
    `[${r.status}] ${r.title ? `${r.title} — ` : ''}${r.url}${r.reason ? `\n         ${r.reason}` : ''}`
  ).join('\n'));
}

async function cmdExtract(args: Args): Promise<void> {
  const url = str(args.url);
  if (!url) throw new Error('--url is required');

  const result = await processUrl(url, {
    universityId: str(args.university),
    dryRun: Boolean(args['dry-run']),
    allowAi: args['no-ai'] ? false : true
  });
  out('EXTRACTION', result);
}

async function cmdVerify(args: Args): Promise<void> {
  const id = str(args.scholarship);
  if (id) {
    const s = await ScholarshipModel.findById(id).select('sourceUrl universityId title').lean();
    if (!s) throw new Error(`Scholarship not found: ${id}`);
    out('RECRAWLING', { title: s.title, url: s.sourceUrl });
    const result = await processUrl(s.sourceUrl, { universityId: s.universityId, allowAi: true });
    out('RESULT', result);
    return;
  }
  const r = await refreshStatuses({ dryRun: Boolean(args['dry-run']) });
  out('STATUS REFRESH', r);
}

async function cmdStatus(): Promise<void> {
  const metrics = await engineMetrics();
  out('ENGINE STATUS', metrics);

  const byStatus = await ScholarshipModel.aggregate([
    { $group: { _id: '$status', count: { $sum: 1 } } },
    { $sort: { count: -1 } }
  ]);
  out('SCHOLARSHIPS BY STATUS', Object.fromEntries(byStatus.map((r) => [r._id, r.count])));

  const byCountry = await ScholarshipModel.aggregate([
    { $group: { _id: '$country', count: { $sum: 1 } } },
    { $sort: { count: -1 } },
    { $limit: 15 }
  ]);
  out('BY COUNTRY', Object.fromEntries(byCountry.map((r) => [r._id, r.count])));

  const queue = await CrawlTargetModel.aggregate([
    { $group: { _id: '$status', count: { $sum: 1 } } }
  ]);
  out('CRAWL QUEUE', Object.fromEntries(queue.map((r) => [r._id, r.count])));
}

async function cmdRun(args: Args): Promise<void> {
  const summary = await runScholarshipCycle({
    trigger: 'CLI',
    dryRun: Boolean(args['dry-run']),
    crawlLimit: num(args.limit)
  });
  out('FULL CYCLE', summary);
}

async function cmdReprocessFailed(args: Args): Promise<void> {
  const limit = num(args.limit) ?? 50;
  const res = await CrawlTargetModel.updateMany(
    { status: 'FAILED' },
    { $set: { status: 'PENDING', attempts: 0, nextCrawlAt: new Date(), leaseUntil: null } }
  );
  out('RESET FAILED TARGETS', { reset: res.modifiedCount });
  if (!args['no-crawl']) await cmdCrawl({ ...args, limit: String(limit) } as Args);
}

async function cmdSeedPlans(args: Args): Promise<void> {
  const defaults = [
    { name: '3-Day Trial', durationMinutes: 3 * 1440, amountKobo: 5800, currency: 'KES', description: 'Try full access for 3 days (includes 16% VAT)', isTrial: true },
    { name: '1 Month', durationMinutes: 30 * 1440, amountKobo: 58000, currency: 'KES', description: 'Full access for 30 days (includes 16% VAT)', isTrial: false }
  ];
  const force = Boolean(args.force);
  const results: Record<string, string> = {};
  for (const plan of defaults) {
    const existing = await PlanModel.findOne({ name: plan.name });
    if (existing && !force) {
      results[plan.name] = 'already exists — skipped (use --force to overwrite price/duration)';
      continue;
    }
    await PlanModel.findOneAndUpdate(
      { name: plan.name },
      { $set: { ...plan, isActive: true } },
      { upsert: true }
    );
    results[plan.name] = existing ? 'updated' : 'created';
  }
  out('SEED PLANS', results);
}

async function cmdCleanup(args: Args): Promise<void> {
  const adminEmail = str(args.email) || env.INITIAL_ADMIN_EMAIL;
  const result = await cleanupExpiredScholarships({
    adminEmail,
    dryRun: Boolean(args['dry-run'])
  });
  out('CLEANUP EXPIRED', result);
}

async function cmdDiscoveryReport(args: Args): Promise<void> {
  const adminEmail = str(args.email) || env.INITIAL_ADMIN_EMAIL;
  const sinceHours = num(args.since) ?? 24;
  const result = await reportNewDiscoveries({
    adminEmail,
    sinceHours
  });
  out('DISCOVERY REPORT', result);
}

const COMMANDS: Record<string, (args: Args) => Promise<void>> = {
  seed: cmdSeed,
  'discover-universities': cmdDiscoverUniversities,
  discover: cmdDiscover,
  crawl: cmdCrawl,
  extract: cmdExtract,
  verify: cmdVerify,
  status: cmdStatus,
  run: cmdRun,
  'reprocess-failed': cmdReprocessFailed,
  'seed-plans': cmdSeedPlans,
  cleanup: cmdCleanup,
  'discovery-report': cmdDiscoveryReport
};

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const command = argv[0];
  const args = parseArgs(argv.slice(1));

  if (!command || command === 'help' || !COMMANDS[command]) {
    // eslint-disable-next-line no-console
    console.log(`
Scholarship Intelligence Engine — CLI

Commands:
  seed                     Insert seed universities (UNVERIFIED) for the configured countries
  discover-universities    Run discovery providers, verify domains, activate institutions
  discover                 Find scholarship/funding URLs for due universities
  crawl                    Drain the crawl queue: fetch → classify → extract → save
  extract                  Process a single URL end to end
  verify                   Recrawl one scholarship, or refresh all statuses
  status                   Print engine metrics
  run                      Full cycle: discover → crawl → statuses → reprioritise
  reprocess-failed         Reset FAILED crawl targets and re-run them
  cleanup                  Remove expired scholarships and send admin alert
  discovery-report         Alert admin of newly discovered scholarships

Flags:
  --dry-run                Read and classify, write nothing
  --countries=KE,GB        Restrict to country codes
  --university=<id>        Restrict to one institution
  --url=<url>              Target URL (extract)
  --scholarship=<id>       Target scholarship (verify)
  --limit=<n>              Cap the number of items processed
  --no-ai                  Force rule-based extraction even if AI is enabled
  --email=<addr>           Admin email for alerts (cleanup, discovery-report)
  --since=<hours>          Hours back for discovery report (default: 24)

Engine currently: crawler=${env.SCHOLARSHIP_CRAWLER_ENABLED} discovery=${env.UNIVERSITY_DISCOVERY_ENABLED} ai=${env.AI_EXTRACTION_ENABLED} playwright=${env.PLAYWRIGHT_ENABLED}
`);
    process.exit(command && command !== 'help' ? 1 : 0);
  }

  await connectMongo();
  // Every CLI command either reads or writes the scholarship collections, and
  // several rely on unique-index enforcement for correctness.
  const idx = await ensureScholarshipIndexes();
  if (idx.failed.length > 0) out('INDEX WARNINGS', idx.failed);
  try {
    await COMMANDS[command](args);
  } finally {
    await closeBrowser();
    await mongoose.disconnect();
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('\nCLI failed:', err?.message ?? err);
  process.exit(1);
});
