import React from 'react';
import { Link } from 'react-router-dom';
import { publicFetch, formatDate, DEGREE_LABELS, FUNDING_LABELS, label } from '../api/scholarships';
import { AdSlot } from './Paywall';

/**
 * Landing page.
 *
 * Follows the editorial rhythm of the Wraith jobs site — a claim, then the
 * evidence, then the price — but every number on this page is read live from
 * the API rather than hardcoded. A marketing page that quietly goes stale is
 * worse than no marketing page, and this one updates itself as the crawler
 * finds more.
 */

interface Stats {
  total: number;
  open: number;
  countries: number;
  universities: number;
}

export function LandingPage() {
  const [stats, setStats] = React.useState<Stats | null>(null);
  const [featured, setFeatured] = React.useState<any[]>([]);
  const [freeViews, setFreeViews] = React.useState(5);
  const [plans, setPlans] = React.useState<any[]>([]);

  React.useEffect(() => {
    // Facets give us live counts without a bespoke stats endpoint
    Promise.all([
      publicFetch<any>('/scholarships/facets').catch(() => null),
      publicFetch<any>('/scholarships?status=OPEN,CLOSING_SOON&sort=quality&limit=6').catch(() => null),
      publicFetch<any>('/universities?limit=1').catch(() => null),
      publicFetch<any>('/access/plans').catch(() => null)
    ]).then(([facets, list, unis, planData]) => {
      if (facets && list) {
        setStats({
          total: list.pagination?.total ?? 0,
          open: list.pagination?.total ?? 0,
          countries: facets.countries?.length ?? 0,
          universities: unis?.pagination?.total ?? 0
        });
      }
      if (list?.items) setFeatured(list.items);
      if (planData) {
        setFreeViews(planData.freeViewsPerMonth ?? 5);
        setPlans(planData.plans ?? []);
      }
    });
  }, []);

  const cheapest = plans.length > 0 ? plans[0] : null;

  return (
    <div className="landing">
      <section className="hero">
        <div className="hero-eyebrow">A Wisdom Busara product</div>
        <h1 className="hero-title">
          The scholarships that fund you <em>never make the listicles.</em>
        </h1>
        <p className="hero-sub">
          The real money sits on university funding pages and PDFs that nobody indexes — and it
          closes quietly. We read those pages every night, pull out the funding, the eligibility
          and the deadline, and show you the source every time.
        </p>
        <div className="hero-actions">
          <Link to="/scholarships" className="btn hero-cta">Browse scholarships</Link>
          <a href="#how" className="hero-link">How it works →</a>
        </div>
        <div className="hero-note">
          {freeViews} full scholarships free every month. No account needed.
        </div>
      </section>

      {stats && (
        <section className="stat-band">
          <div><strong>{stats.total.toLocaleString()}</strong><span>scholarships indexed</span></div>
          <div><strong>{stats.universities.toLocaleString()}</strong><span>universities watched</span></div>
          <div><strong>{stats.countries}</strong><span>countries</span></div>
          <div><strong>Nightly</strong><span>re-checked for changes</span></div>
        </section>
      )}

      <AdSlot placement="landing_banner" />

      <section className="feature" id="how">
        <div className="feature-label">01 · Where they come from</div>
        <h2 className="feature-title">Straight from the university, not an aggregator.</h2>
        <p className="feature-body">
          We start from the institution&rsquo;s own domain — verified before we crawl a single page —
          then follow its funding, studentship and bursary pages, including the PDFs most scrapers
          skip. Every scholarship keeps a link to the page it came from.
        </p>
        <ul className="feature-list">
          <li>University and government sources ranked above aggregators</li>
          <li>PDF funding guides parsed, not ignored</li>
          <li>Same award found on four pages becomes one listing, four sources</li>
        </ul>
      </section>

      <section className="feature alt">
        <div className="feature-label">02 · What we will not do</div>
        <h2 className="feature-title">We never turn silence into a yes.</h2>
        <p className="feature-body">
          If a page does not mention IELTS, we say &ldquo;not confirmed&rdquo; — not &ldquo;not
          required&rdquo;. If it says &ldquo;open to international students&rdquo; without naming
          countries, we say exactly that instead of implying you qualify. Unknown and no are
          different answers, and conflating them is how people miss deadlines they could have met.
        </p>
        <div className="honesty-grid">
          <div className="honesty-item yes"><span>✓</span> Covered — the page says so</div>
          <div className="honesty-item no"><span>✕</span> Not covered — the page rules it out</div>
          <div className="honesty-item unknown"><span>?</span> Not stated — the page is silent</div>
        </div>
      </section>

      {featured.length > 0 && (
        <section className="feature">
          <div className="feature-label">03 · Open right now</div>
          <h2 className="feature-title">A few that are live today.</h2>
          <div className="featured-grid">
            {featured.slice(0, 6).map((s) => (
              <Link key={s.id} to={`/scholarships/${s.id}`} className="featured-card">
                <div className="featured-title">{s.title}</div>
                <div className="featured-meta">{s.university ?? s.provider} · {s.country}</div>
                <div className="featured-tags">
                  {s.funding.primaryType !== 'UNKNOWN' && (
                    <span className="sch-tag sch-tag-gold">{label(FUNDING_LABELS, s.funding.primaryType)}</span>
                  )}
                  {s.degreeLevels.slice(0, 2).map((d: string) => (
                    <span key={d} className="sch-tag">{label(DEGREE_LABELS, d)}</span>
                  ))}
                </div>
                <div className="featured-deadline">
                  {s.deadline.date ? `Closes ${formatDate(s.deadline.date)}` : s.deadline.kind === 'ROLLING' ? 'Rolling deadline' : 'Deadline not stated'}
                </div>
              </Link>
            ))}
          </div>
          <Link to="/scholarships" className="btn secondary">See all scholarships</Link>
        </section>
      )}

      <section className="feature alt" id="pricing">
        <div className="feature-label">04 · Access</div>
        <h2 className="feature-title">Free to read. A small fee to go deep.</h2>
        <p className="feature-body">
          {freeViews} full scholarships every month cost nothing and never will. Beyond that
          {cheapest
            ? <> it&rsquo;s <strong>{cheapest.currency} {cheapest.amount.toLocaleString()}</strong> for {cheapest.durationLabel}</>
            : <> there&rsquo;s a small fee</>} — which also removes the ads and unlocks the matcher
          that scores every award against your nationality, degree and test scores.
        </p>
        <div className="pricing-actions">
          <Link to="/upgrade" className="btn">See plans</Link>
          <Link to="/restore" className="hero-link">Already paid? Restore →</Link>
        </div>
        <p className="pricing-note">Pay with M-Pesa or card. Access starts the moment payment lands.</p>
      </section>

      <section className="closing">
        <h2>The funding is out there.<br />It just closes quietly.</h2>
        <Link to="/scholarships" className="btn hero-cta">Start browsing</Link>
      </section>
    </div>
  );
}
