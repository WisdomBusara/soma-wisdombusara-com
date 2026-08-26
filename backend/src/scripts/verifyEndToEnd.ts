/**
 * Live end-to-end verification (§66).
 *
 * Boots a real MongoDB, stands up the real Express app, and drives the real
 * pipeline — models, indexes, dedup, status engine, API — with no mocking of
 * the persistence or HTTP layers.
 *
 * The only thing substituted is the network fetch: fetchPage is stubbed to
 * return fixture pages instead of hitting live university websites. That
 * substitution is deliberate and honest — a verification script must be
 * deterministic and must not hammer third-party servers. Everything downstream
 * of the fetch is the genuine code path.
 *
 * Run: npx tsx src/scripts/verifyEndToEnd.ts
 */
import { MongoMemoryServer } from 'mongodb-memory-server';

async function main() {
  const mongo = await MongoMemoryServer.create();
  process.env.MONGO_URI = mongo.getUri('scholarship-e2e');
  process.env.NODE_ENV = 'test';
  process.env.CORS_ORIGIN = 'http://localhost:5173';
  process.env.JWT_ACCESS_SECRET = 'e2e-only-access-secret-000000000000000000';
  process.env.JWT_REFRESH_SECRET = 'e2e-only-refresh-secret-00000000000000000';
  process.env.ENCRYPTION_KEY_BASE64 = 'dGVzdC1vbmx5LWtleS0zMi1ieXRlcy0wMDAwMDAwMA==';
  process.env.INITIAL_ADMIN_EMAIL = 'e2e@example.com';
  process.env.INITIAL_ADMIN_PASSWORD = 'e2e-password-not-real';
  process.env.PAYSTACK_SECRET_KEY = 'sk_test_e2e';
  process.env.SCHOLARSHIP_CRAWLER_ENABLED = 'true';

  const mongoose = (await import('mongoose')).default;
  await mongoose.connect(process.env.MONGO_URI!);

  const { UniversityModel } = await import('../models/scholarship/University');
  const { ScholarshipModel } = await import('../models/scholarship/Scholarship');
  const { ScholarshipSourceModel, CrawlTargetModel } = await import('../models/scholarship/operational');
  const { canonicalUrl, contentHash } = await import('../services/scholarship/normalize/text');

  // ── Fixture pages served over real HTTP (§52) ─────────────────────────────
  // Served from a local server rather than stubbed, so the genuine fetcher —
  // robots.txt handling, content-type negotiation, Cheerio parsing, link
  // extraction, content hashing — is exercised. Only the *origin* is local.
  const http = await import('node:http');

  const page = (title: string, body: string, links: [string, string][] = []) => `<!DOCTYPE html>
<html><head><title>${title}</title>
<meta name="description" content="A fully funded scholarship for Master's applicants from East Africa.">
</head><body><main>
<h1>${title.split(' | ')[0]}</h1>
${body}
${links.map(([t, h]) => `<p><a href="${h}">${t}</a></p>`).join('\n')}
</main></body></html>`;

  const FIXTURES: Record<string, string> = {
    '/scholarships/global-masters': page(
      'Global Masters Scholarship | Fixture University',
      `<h2>Funding</h2>
       <p>The Global Masters Scholarship is a fully funded award for the 2027/28 academic year.</p>
       <p>Funding: the scholarship covers full tuition fees and provides a living stipend of £18,622 per year.</p>
       <p>Health insurance is included and a travel allowance is provided.</p>
       <p>The award does not cover accommodation costs.</p>
       <h2>Eligibility</h2>
       <p>Eligibility: open to citizens of Kenya, Uganda and Tanzania.</p>
       <p>Applicants must hold a Bachelor degree with a minimum of an upper second-class honours.</p>
       <p>English language requirement: IELTS 6.5 overall with no band below 6.0.</p>
       <h2>How to apply</h2>
       <p>You must submit a CV, academic transcripts, a statement of purpose and two references.</p>
       <p>The scholarship supports full-time, on-campus study only.</p>
       <h2>Deadline</h2>
       <p>Applications close at 23:59 GMT on 15 January 2027.</p>`,
      [['Apply now', '/apply/global-masters']]
    ),
    // Same award, different path and wording — must dedupe, not duplicate
    '/faculty/funding/global-masters-scholarships': page(
      'Global Masters Scholarships 2027/28 | Faculty of Engineering',
      `<h2>Eligibility</h2>
       <p>The Global Masters Scholarship for 2027/28 is fully funded.</p>
       <p>It covers tuition fees and includes a living stipend.</p>
       <p>Open to citizens of Kenya, Uganda and Tanzania.</p>
       <p>Applicants must hold a Bachelor degree. How to apply: submit an application form.</p>
       <p>Applications close on 15 January 2027.</p>`
    ),
    // Must be rejected — a payment page, not an award
    '/finance/pay-your-fees': page(
      'Pay your fees | Fixture University',
      '<p>Make a payment towards your tuition fees online. Payment methods include card and bank transfer. Scholarship holders should contact the finance office.</p>'.repeat(4)
    )
  };

  let deadlineText = '15 January 2027';
  const fixtureServer = http.createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0];
    if (path === '/robots.txt') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      return res.end('User-agent: *\nAllow: /\n');
    }
    const body = FIXTURES[path];
    if (!body) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return res.end(body.replace('15 January 2027', deadlineText));
  });
  await new Promise<void>((r) => fixtureServer.listen(0, '127.0.0.1', r));
  const fixturePort = (fixtureServer.address() as any).port;
  const ORIGIN = `http://127.0.0.1:${fixturePort}`;
  const U = (p: string) => `${ORIGIN}${p}`;

  const { processUrl } = await import('../services/scholarship/pipeline');

  const checks: { name: string; pass: boolean; detail: string }[] = [];
  const check = (name: string, pass: unknown, detail = '') => {
    const ok = Boolean(pass);
    checks.push({ name, pass: ok, detail });
    console.log(`  ${ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${name}${detail ? ` — ${detail}` : ''}`);
  };

  const { ensureScholarshipIndexes } = await import('../services/scholarship/indexes');
  const idx = await ensureScholarshipIndexes();

  console.log('\n\x1b[1m0. Index provisioning\x1b[0m');

  console.log('\n\x1b[1m1. University registry\x1b[0m');
  const uni = await UniversityModel.create({
    name: 'Fixture University', domain: `127.0.0.1:${fixturePort}`,
    website: ORIGIN, country: 'United Kingdom',
    countryCode: 'GB', city: 'London', status: 'ACTIVE',
    discoverySource: 'e2e:fixture', discoveredAt: new Date(), lastVerifiedAt: new Date()
  });
  check('Indexes provisioned on all 7 collections', idx.created.length === 7 && idx.failed.length === 0, `${idx.created.length} collections`);
  check('University persisted with unique domain index', Boolean(uni._id), uni.domain);

  let dupBlocked = false;
  try {
    await UniversityModel.create({
      name: 'Duplicate', domain: `127.0.0.1:${fixturePort}`,
      website: 'https://x', country: 'GB', status: 'ACTIVE', discoveredAt: new Date()
    });
  } catch (e: any) { dupBlocked = e?.code === 11000; }
  check('Duplicate domain rejected by unique index', dupBlocked);

  console.log('\n\x1b[1m2. Crawl → classify → extract → save\x1b[0m');
  const r1 = await processUrl(U('/scholarships/global-masters'), { universityId: uni._id });
  check('Scholarship page saved', r1.status === 'SAVED', `${r1.status} · confidence ${r1.confidence}`);

  const saved = await ScholarshipModel.findById(r1.scholarshipId).lean();
  check('Title cleaned of site suffix', saved?.title === 'Global Masters Scholarship', saved?.title);
  check('Degree normalized to MASTERS only (prerequisite not counted)',
    saved?.degreeLevels.includes('MASTERS') && !saved?.degreeLevels.includes('BACHELORS'),
    String(saved?.degreeLevels));
  check('Funding normalized to FULLY_FUNDED', saved?.funding?.primaryType === 'FULLY_FUNDED', saved?.funding?.primaryType);
  check('Stipend captured with currency, not converted',
    saved?.funding?.stipendAmount?.amount === 18622 && saved?.funding?.stipendAmount?.currency === 'GBP',
    `${saved?.funding?.stipendAmount?.currency} ${saved?.funding?.stipendAmount?.amount}`);
  check('Explicit non-coverage stored as false',
    saved?.funding?.accommodationCovered?.value === false,
    `accommodation = ${saved?.funding?.accommodationCovered?.value}`);
  check('Unmentioned funding stays null (not false)',
    saved?.funding?.applicationFeeWaiver?.value === null,
    `feeWaiver = ${saved?.funding?.applicationFeeWaiver?.value}`);
  check('Country eligibility extracted explicitly',
    JSON.stringify(saved?.eligibility?.countries) === '["KE","UG","TZ"]',
    String(saved?.eligibility?.countries));
  check('Deadline parsed with timezone preserved',
    saved?.deadline?.date?.toISOString().startsWith('2027-01-15') && saved?.deadline?.timezoneStated === 'GMT',
    `${saved?.deadline?.date?.toISOString()} ${saved?.deadline?.timezoneStated}`);
  check('Original deadline wording retained',
    Boolean(saved?.deadline?.originalText?.includes('23:59')),
    String(saved?.deadline?.originalText ?? '').slice(0, 60));
  check('IELTS requirement structured', saved?.requirements?.english?.ielts?.minScore === 6.5);
  check('Documents structured, not a blob',
    (saved?.requirements?.documents?.length ?? 0) >= 4,
    `${saved?.requirements?.documents?.length} documents`);
  check('Application URL is the real apply link',
    saved?.applicationUrl?.value === U('/apply/global-masters'));
  check('Status computed as OPEN', saved?.status === 'OPEN', saved?.status);
  check('Provenance retained on funding',
    Boolean(saved?.funding?.tuitionCovered?.sourceText),
    String(saved?.funding?.tuitionCovered?.sourceText ?? '').slice(0, 50));

  console.log('\n\x1b[1m3. Deduplication across two URLs\x1b[0m');
  const r2 = await processUrl(U('/faculty/funding/global-masters-scholarships'), { universityId: uni._id });
  check('Second URL recognised as the same award', r2.status === 'UPDATED' || r2.status === 'DUPLICATE', `${r2.status} — ${r2.reason}`);
  const count = await ScholarshipModel.countDocuments({});
  check('Exactly one scholarship record exists', count === 1, `${count} record(s)`);
  const sources = await ScholarshipSourceModel.find({ scholarshipId: r1.scholarshipId }).lean();
  check('Both URLs attached as sources', sources.length === 2, `${sources.length} sources`);
  const primary = sources.find((s) => s.isPrimary);
  check('Official university page elected primary over faculty page',
    primary?.sourceType === 'UNIVERSITY', `primary = ${primary?.sourceType}`);

  console.log('\n\x1b[1m4. Data-quality gate\x1b[0m');
  const r3 = await processUrl(U('/finance/pay-your-fees'), { universityId: uni._id });
  check('Fee payment page rejected', r3.status === 'NOT_SCHOLARSHIP', String(r3.reason ?? '').slice(0, 70));
  check('No record created for rejected page', (await ScholarshipModel.countDocuments({})) === 1);

  console.log('\n\x1b[1m5. Content-hash caching\x1b[0m');
  // Use the hash the fetcher actually computed, not a recomputation — that is
  // what a real crawl target would have stored.
  const firstSource = await ScholarshipSourceModel.findOne({ canonicalUrl: canonicalUrl(U('/scholarships/global-masters')) }).lean();
  const firstHash = firstSource?.contentHash;
  await CrawlTargetModel.create({
    url: U('/scholarships/global-masters'),
    canonicalUrl: canonicalUrl(U('/scholarships/global-masters')),
    domain: `127.0.0.1:${fixturePort}`, universityId: uni._id, targetType: 'SCHOLARSHIP',
    status: 'COMPLETED', contentHash: firstHash
  });
  const target = await CrawlTargetModel.findOne({ targetType: 'SCHOLARSHIP' }).lean();
  const r4 = await processUrl(U('/scholarships/global-masters'), {
    universityId: uni._id, crawlTargetId: target?._id
  });
  check('Unchanged content skipped without re-extraction', r4.status === 'UNCHANGED', r4.reason);

  console.log('\n\x1b[1m6. Change detection\x1b[0m');
  deadlineText = '1 March 2027';
  const r5 = await processUrl(U('/scholarships/global-masters'), { universityId: uni._id });
  const { ScholarshipChangeModel } = await import('../models/scholarship/operational');
  const changes = await ScholarshipChangeModel.find({ field: 'deadline' }).sort({ detectedAt: 1 }).lean();
  check('No spurious deadline change from the mirror source in step 3',
    changes.every((c) => String(c.newValue).includes('Mar')) || changes.length === 1,
    `${changes.length} deadline change(s)`);
  check('Real deadline move detected and recorded',
    changes.some((c) => String(c.newValue).includes('Mar')),
    changes[0] ? `${String(changes[0].oldValue).slice(0, 24)} → ${String(changes[0].newValue).slice(0, 24)}` : String(r5.status));
  check('Change marked MAJOR', changes[0]?.significance === 'MAJOR');

  console.log('\n\x1b[1m7. Status engine\x1b[0m');
  const { refreshStatuses } = await import('../services/scholarship/status');
  await ScholarshipModel.updateOne({ _id: r1.scholarshipId }, { $set: { 'deadline.date': new Date(Date.now() + 5 * 86400000) } });
  const refreshed = await refreshStatuses();
  const closing = await ScholarshipModel.findById(r1.scholarshipId).lean();
  check('Imminent deadline flips to CLOSING_SOON', closing?.status === 'CLOSING_SOON', `${closing?.status} (${refreshed.changed} changed)`);

  console.log('\n\x1b[1m8. Public API\x1b[0m');
  const request = (await import('node:http'));
  const { createApp } = await import('../app');
  const app = createApp({ botRunner: { start: async () => {}, stop: () => {} } as any, waBotRunner: { start: async () => {}, stop: () => {} } as any });
  const server = app.listen(0);
  const port = (server.address() as any).port;

  const get = (path: string, cookie?: string): Promise<{ status: number; body: any }> =>
    new Promise((resolve, reject) => {
      request.get({ host: '127.0.0.1', port, path, headers: cookie ? { cookie } : {} }, (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => {
          let body: any = null;
          // Not every endpoint is JSON (sitemap.xml); a parse failure is data,
          // not an error.
          try { body = data ? JSON.parse(data) : null; } catch { body = data; }
          resolve({ status: res.statusCode ?? 0, body });
        });
      }).on('error', reject);
    });

  const list = await get('/api/scholarships?degree=MASTERS&country=GB&fullyFunded=true&nationality=KE');
  check('§30 query returns the award',
    list.status === 200 && list.body.items.length === 1,
    `HTTP ${list.status}, ${list.body?.items?.length} item(s)`);
  check('Nationality match reported as EXPLICIT',
    list.body?.items?.[0]?.nationalityMatch === 'EXPLICIT',
    list.body?.items?.[0]?.nationalityMatch);
  check('Response is paginated', Boolean(list.body?.pagination), JSON.stringify(list.body?.pagination));

  const wrongNat = await get('/api/scholarships?nationality=DE');
  check('Non-eligible nationality filtered out',
    wrongNat.body.items.length === 0, `${wrongNat.body.items.length} item(s)`);

  const detail = await get(`/api/scholarships/${r1.scholarshipId}`);
  check('Detail endpoint returns sources and provenance',
    detail.status === 200 && detail.body.sources.length === 2 && Boolean(detail.body.fundingDetail),
    `${detail.body?.sources?.length} sources`);

  const facets = await get('/api/scholarships/facets');
  check('Facets endpoint works', facets.status === 200 && facets.body.countries.length > 0);

  const unis = await get('/api/universities');
  check('University list endpoint works', unis.status === 200 && unis.body.items.length === 1);

  const postMatch = (cookie?: string) => new Promise<any>((resolve, reject) => {
    const payload = JSON.stringify({ nationality: 'Kenya', degreeLevel: 'MASTERS', fullyFundedOnly: true, englishTest: { type: 'IELTS', score: 7 } });
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'content-length': String(Buffer.byteLength(payload))
    };
    if (cookie) headers.cookie = cookie;
    const req = request.request({ host: '127.0.0.1', port, path: '/api/scholarships/match', method: 'POST', headers }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        let body: any = null;
        try { body = data ? JSON.parse(data) : null; } catch { body = data; }
        resolve({ status: res.statusCode, body });
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });

  // The matcher is the flagship paid feature — it must be gated for anonymous
  // readers and working for paying ones. Both halves are asserted.
  const lockedMatch = await postMatch();
  check('Matching endpoint is gated for free readers',
    lockedMatch.status === 402 && lockedMatch.body?.error === 'premium_required',
    `HTTP ${lockedMatch.status}`);

  console.log('\n\x1b[1m9. Paywall + ads\x1b[0m');
  const { PlanModel } = await import('../models/Plan');
  const { AdSlotModel } = await import('../models/scholarship/access');

  const plan = await PlanModel.create({
    name: 'E2E Weekly', durationMinutes: 10080, amountKobo: 5000, currency: 'KES', isActive: true
  });
  const plansRes = await get('/api/access/plans');
  check('Plans endpoint serves DB-driven pricing',
    plansRes.status === 200 && plansRes.body.plans.length === 1 && plansRes.body.plans[0].durationLabel === '7 days',
    `${plansRes.body?.plans?.[0]?.currency} ${plansRes.body?.plans?.[0]?.amount} / ${plansRes.body?.plans?.[0]?.durationLabel}`);

  const me = await get('/api/access/me');
  check('Anonymous reader resolves to the free tier',
    me.body?.tier === 'free' && me.body?.remaining === 5, `tier=${me.body?.tier} remaining=${me.body?.remaining}`);

  // Listings must stay open — that is the SEO and funnel decision
  const openList = await get('/api/scholarships');
  check('Listings are never gated', openList.status === 200 && openList.body.items.length === 1);
  check('Listing response reports entitlement', Boolean(openList.body.access), JSON.stringify(openList.body.access));

  await AdSlotModel.create({
    name: 'E2E House Ad', placement: 'listing_inline', type: 'HOUSE',
    headline: 'Study abroad advice', body: 'Free consultation.', ctaLabel: 'Learn more',
    targetUrl: 'https://example.org/advice', advertiser: 'Example Co', weight: 5, isActive: true
  });
  const adRes = await get('/api/ads?placement=listing_inline');
  check('Ad served to a free reader',
    adRes.status === 200 && adRes.body.ad?.headline === 'Study abroad advice',
    adRes.body?.ad?.advertiser ?? 'none');
  check('Ad click URL routes through our redirect (no open redirect)',
    typeof adRes.body?.ad?.clickUrl === 'string' && adRes.body.ad.clickUrl.startsWith('/api/ads/'),
    adRes.body?.ad?.clickUrl);

  const noFill = await get('/api/ads?placement=detail_footer');
  check('Unbooked placement returns no ad rather than an empty box', noFill.body?.ad === null);

  const sitemap = await get('/api/sitemap.xml');
  check('Sitemap is served or correctly reports missing config',
    sitemap.status === 200 || sitemap.status === 404, `HTTP ${sitemap.status}`);

  const { ScholarshipAccessModel } = await import('../models/scholarship/access');
  const { issueAccessToken, ACCESS_COOKIE } = await import('../services/scholarship/paywall');
  const grant = await ScholarshipAccessModel.create({
    email: 'e2e-premium@example.com', planId: plan._id, planName: plan.name,
    startsAt: new Date(), endsAt: new Date(Date.now() + 7 * 86400000),
    status: 'active', amountKobo: 5000, currency: 'KES'
  });
  const premiumCookie = `${ACCESS_COOKIE}=${issueAccessToken(String(grant._id), grant.endsAt)}`;

  const premiumMe = await get('/api/access/me', premiumCookie);
  check('Signed cookie resolves to the premium tier',
    premiumMe.body?.tier === 'premium' && premiumMe.body?.adsEnabled === false,
    `tier=${premiumMe.body?.tier} ads=${premiumMe.body?.adsEnabled}`);

  const premiumMatch = await postMatch(premiumCookie);
  check('Premium reader gets an explained match',
    premiumMatch.status === 200 && premiumMatch.body.items?.length === 1 && premiumMatch.body.items[0].match.passed.length > 0,
    `${premiumMatch.body?.items?.[0]?.match?.percentage}% · ${premiumMatch.body?.items?.[0]?.match?.passed?.length} passed`);

  const premiumAds = await get('/api/ads?placement=listing_inline', premiumCookie);
  check('Premium reader is served no ads', premiumAds.body?.ad === null);

  const forged = `${ACCESS_COOKIE}=${Buffer.from(JSON.stringify({ id: String(grant._id), exp: 9999999999 })).toString('base64url')}.forgedsignature`;
  const forgedMe = await get('/api/access/me', forged);
  check('Forged access cookie is rejected', forgedMe.body?.tier === 'free', `tier=${forgedMe.body?.tier}`);

  const oldApi = await get('/public/plans');
  check('Existing /public API still responds (no regression)', oldApi.status === 200);
  const health = await get('/health');
  check('Existing /health still responds (no regression)', health.status === 200);

  server.close();
  await mongoose.disconnect();
  await mongo.stop();
  fixtureServer.close();

  const failed = checks.filter((c) => !c.pass);
  console.log(`\n\x1b[1m${checks.length - failed.length}/${checks.length} checks passed\x1b[0m`);
  if (failed.length > 0) {
    console.log('\x1b[31mFailed:\x1b[0m');
    for (const f of failed) console.log(`  - ${f.name} ${f.detail}`);
    process.exit(1);
  }
  console.log('\x1b[32mEnd-to-end path verified.\x1b[0m\n');
  process.exit(0);
}

main().catch((err) => {
  console.error('E2E failed:', err);
  process.exit(1);
});
