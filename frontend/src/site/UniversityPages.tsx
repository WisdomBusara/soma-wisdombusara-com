import React from 'react';
import { Link, NavLink, Outlet, useParams, useSearchParams } from 'react-router-dom';
import { AccessProvider, useAccess } from './Paywall';
import {
  publicFetch, DEGREE_LABELS, FUNDING_LABELS, STATUS_LABELS,
  label, formatDate, statusTone,
  type ScholarshipListItem, type Pagination
} from '../api/scholarships';

/**
 * Public site shell + university browsing (§43).
 *
 * The shell is rendered outside the authenticated admin Shell in App.tsx, so
 * these routes are reachable without a session. That separation is why the
 * scholarship site can be linked publicly while /dashboard stays private.
 */

function SiteNavCta() {
  const { access } = useAccess();
  if (access?.tier === 'premium') {
    return <span className="site-nav-premium">✦ Full access</span>;
  }
  return <Link to="/upgrade" className="site-nav-cta">Get full access</Link>;
}

export function SiteLayout() {
  return (
    <AccessProvider>
      <SiteChrome />
    </AccessProvider>
  );
}

function SiteChrome() {
  return (
    <div className="site">
      <header className="site-header">
        <Link to="/" className="site-logo">
          Scholarship<span>Engine</span>
        </Link>
        <nav className="site-nav">
          <NavLink to="/scholarships" className={({ isActive }) => (isActive ? 'active' : '')}>
            Scholarships
          </NavLink>
          <NavLink to="/universities" className={({ isActive }) => (isActive ? 'active' : '')}>
            Universities
          </NavLink>
          <NavLink to="/about" className={({ isActive }) => (isActive ? 'active' : '')}>
            How this works
          </NavLink>
          <SiteNavCta />
        </nav>
      </header>

      <div className="site-body">
        <Outlet />
      </div>

      <footer className="site-footer">
        <p>
          Every listing links back to its original source. Information is extracted automatically and
          may be incomplete or out of date — always confirm details on the official page before applying.
        </p>
        <p className="site-footer-links">
          <Link to="/about">How this works</Link>
          <span className="sch-dot">·</span>
          <Link to="/upgrade">Pricing</Link>
          <span className="sch-dot">·</span>
          <Link to="/restore">Restore access</Link>
          <span className="sch-dot">·</span>
          <a href="mailto:support@wisdombusara.com">Contact</a>
        </p>
      </footer>
    </div>
  );
}

// ── Universities ────────────────────────────────────────────────────────────

interface UniversityItem {
  id: string;
  name: string;
  country: string;
  countryCode: string | null;
  city: string | null;
  website: string;
  domain: string;
  type: string;
  scholarshipCount: number;
}

export function UniversityListPage() {
  const [params, setParams] = useSearchParams();
  const [items, setItems] = React.useState<UniversityItem[]>([]);
  const [pagination, setPagination] = React.useState<Pagination | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [search, setSearch] = React.useState(params.get('q') ?? '');

  React.useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    const qs = new URLSearchParams(params);
    if (!qs.get('limit')) qs.set('limit', '24');
    publicFetch<{ items: UniversityItem[]; pagination: Pagination }>(`/universities?${qs.toString()}`)
      .then((r) => { if (!cancelled) { setItems(r.items); setPagination(r.pagination); } })
      .catch((e) => { if (!cancelled) setError(String(e?.message ?? 'Failed to load')); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [params]);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const next = new URLSearchParams(params);
    if (search.trim()) next.set('q', search.trim());
    else next.delete('q');
    next.delete('page');
    setParams(next, { replace: true });
  };

  const page = Number(params.get('page') ?? 1);
  const goTo = (p: number) => {
    const next = new URLSearchParams(params);
    next.set('page', String(p));
    setParams(next);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  return (
    <div className="site-page">
      <h1 className="site-page-title">Universities</h1>
      <p className="site-page-sub">
        Institutions in the registry. Each has been verified against its own domain before any of its
        pages were crawled.
      </p>

      <form className="sch-searchbar" onSubmit={submit}>
        <input
          className="input"
          placeholder="Search universities…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <button className="btn" type="submit">Search</button>
      </form>

      {error && <div className="error">{error}</div>}
      {loading && <div className="loading">Loading…</div>}

      {!loading && items.length === 0 && (
        <div className="sch-empty">
          <div className="sch-empty-icon">◌</div>
          <h3>No universities yet</h3>
          <p className="muted">
            Seed the registry and run discovery from the admin panel, or via
            <code> npm run scholarships:seed</code>.
          </p>
        </div>
      )}

      <div className="uni-grid">
        {items.map((u) => (
          <Link key={u.id} to={`/universities/${u.id}`} className="uni-card">
            <div className="uni-card-name">{u.name}</div>
            <div className="uni-card-loc">
              {u.city ? `${u.city}, ${u.country}` : u.country}
            </div>
            <div className="uni-card-foot">
              <span className="uni-card-domain">{u.domain}</span>
              <span className="uni-card-count">
                {u.scholarshipCount} scholarship{u.scholarshipCount === 1 ? '' : 's'}
              </span>
            </div>
          </Link>
        ))}
      </div>

      {pagination && pagination.totalPages > 1 && (
        <div className="sch-pagination">
          <button className="btn secondary" disabled={page <= 1} onClick={() => goTo(page - 1)}>Previous</button>
          <span className="muted">Page {pagination.page} of {pagination.totalPages}</span>
          <button className="btn secondary" disabled={!pagination.hasMore} onClick={() => goTo(page + 1)}>Next</button>
        </div>
      )}
    </div>
  );
}

interface UniversityDetail {
  id: string;
  name: string;
  officialName: string | null;
  country: string;
  countryCode: string | null;
  city: string | null;
  website: string;
  domain: string;
  type: string;
  admissionsUrl: string | null;
  internationalStudentsUrl: string | null;
  lastVerifiedAt: string | null;
  scholarships: ScholarshipListItem[];
}

export function UniversityDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [u, setU] = React.useState<UniversityDetail | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!id) return;
    let cancelled = false;
    setLoading(true);
    publicFetch<UniversityDetail>(`/universities/${id}`)
      .then((r) => { if (!cancelled) setU(r); })
      .catch((e) => { if (!cancelled) setError(String(e?.message ?? 'Failed to load')); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [id]);

  if (loading) return <div className="loading">Loading…</div>;
  if (error) return <div className="site-page"><div className="error">{error}</div></div>;
  if (!u) return null;

  return (
    <div className="site-page">
      <Link to="/universities" className="sch-back">← All universities</Link>

      <h1 className="site-page-title">{u.name}</h1>
      <p className="site-page-sub">
        {u.city ? `${u.city}, ${u.country}` : u.country}
        <span className="sch-dot">·</span>
        <a href={u.website} target="_blank" rel="noopener noreferrer">{u.domain}</a>
        {u.lastVerifiedAt && (
          <>
            <span className="sch-dot">·</span>
            <span className="muted">Domain verified {formatDate(u.lastVerifiedAt)}</span>
          </>
        )}
      </p>

      <div className="uni-links">
        {u.admissionsUrl && <a className="btn secondary" href={u.admissionsUrl} target="_blank" rel="noopener noreferrer">Admissions</a>}
        {u.internationalStudentsUrl && <a className="btn secondary" href={u.internationalStudentsUrl} target="_blank" rel="noopener noreferrer">International students</a>}
      </div>

      <h2 className="sch-section-title">
        {u.scholarships.length} scholarship{u.scholarships.length === 1 ? '' : 's'}
      </h2>

      {u.scholarships.length === 0 && (
        <p className="muted">No scholarships have been extracted for this institution yet.</p>
      )}

      <div className="sch-cards">
        {u.scholarships.map((s) => (
          <Link key={s.id} to={`/scholarships/${s.id}`} className="sch-card">
            <div className="sch-card-head">
              <div className="sch-card-titles">
                <h3 className="sch-card-title">{s.title}</h3>
              </div>
            </div>
            <div className="sch-tags">
              {s.funding.primaryType !== 'UNKNOWN' && (
                <span className={`sch-tag ${s.funding.primaryType === 'FULLY_FUNDED' ? 'sch-tag-gold' : 'sch-tag-accent'}`}>
                  {label(FUNDING_LABELS, s.funding.primaryType)}
                </span>
              )}
              {s.degreeLevels.map((d) => <span key={d} className="sch-tag">{label(DEGREE_LABELS, d)}</span>)}
            </div>
            <div className="sch-card-foot">
              <span className="muted">
                {s.deadline.date ? formatDate(s.deadline.date) : s.deadline.kind === 'ROLLING' ? 'Rolling' : 'Deadline not stated'}
              </span>
              <span className={`badge ${statusTone(s.status)}`}>{label(STATUS_LABELS, s.status)}</span>
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
}

// ── About ───────────────────────────────────────────────────────────────────

export function AboutPage() {
  return (
    <div className="site-page site-prose">
      <h1 className="site-page-title">How this works</h1>

      <p>
        This index is built by crawling publicly accessible scholarship and funding pages published by
        universities and government bodies, then extracting structured information from them.
      </p>

      <h2>What the labels mean</h2>
      <dl className="about-list">
        <dt>Official source</dt>
        <dd>The information was read from the institution's own website or an official government site.</dd>

        <dt>Aggregated</dt>
        <dd>The information came from a third-party page that we have not yet traced back to an official source.</dd>

        <dt>Auto-extracted</dt>
        <dd>A program read the page and structured the information. No human has checked it.</dd>

        <dt>Needs verification</dt>
        <dd>Extraction confidence fell below our threshold. Treat every field as provisional.</dd>

        <dt>Not stated</dt>
        <dd>
          The source page did not mention this. It is deliberately different from "not covered" —
          we never turn silence into a negative answer.
        </dd>

        <dt>Inferred</dt>
        <dd>
          We derived this from what the page said rather than reading it verbatim. For example, a page
          that covers both tuition and living costs is marked fully funded as an inference, not a quote.
        </dd>
      </dl>

      <h2>Why "open to international students" isn't a yes</h2>
      <p>
        Many pages say an award is open to international applicants without publishing which
        nationalities actually qualify. When that happens we say so plainly rather than implying every
        country is eligible. If a page does name countries, we list them.
      </p>

      <h2>Confidence scores</h2>
      <p>
        Confidence describes how reliably we extracted a page — source authority, how much of the page
        we could parse, and how certain each field was. It is an operational signal for prioritising
        review. It is not a claim that the information is correct.
      </p>

      <h2>Crawling policy</h2>
      <p>
        The crawler requests only publicly accessible pages, identifies itself, respects robots.txt, and
        rate-limits itself per domain. It does not attempt to access anything behind a login, a paywall,
        or any other access control.
      </p>

      <h2>Before you apply</h2>
      <p>
        Always open the official source link and confirm the deadline, eligibility and requirements
        yourself. Pages change, and an automated index will sometimes be behind.
      </p>
    </div>
  );
}
