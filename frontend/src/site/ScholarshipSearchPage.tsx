import React from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { AdSlot, QuotaPill } from './Paywall';
import {
  publicFetch, DEGREE_LABELS, FUNDING_LABELS, MODE_LABELS, STATUS_LABELS,
  label, formatDate, daysUntil, formatMoney, statusTone,
  type ScholarshipListItem, type Pagination, type Facets
} from '../api/scholarships';

/**
 * Public scholarship search (§43).
 *
 * Uses the existing design tokens (--bg, --surface, --accent …) so this reads
 * as the same product as the admin, with a wider, lighter layout appropriate
 * to a public browse experience.
 *
 * The interface makes provenance visible rather than hiding it: every card
 * states whether the information came from an official source and whether it
 * still needs verification. That is a deliberate product decision — a
 * scholarship listing that cannot be traced back to the institution is worth
 * very little to an applicant.
 */

const DEGREES = ['BACHELORS', 'MASTERS', 'PHD'];
const FUNDING = ['FULLY_FUNDED', 'PARTIALLY_FUNDED', 'TUITION_ONLY', 'LIVING_STIPEND'];
const MODES = ['ON_CAMPUS', 'ONLINE', 'HYBRID', 'DISTANCE'];
const ATTENDANCE = ['FULL_TIME', 'PART_TIME'];
const STATUSES = ['OPEN', 'CLOSING_SOON', 'UPCOMING', 'VERIFIED'];

interface ListResponse {
  items: ScholarshipListItem[];
  pagination: Pagination;
}

function DeadlinePill({ item }: { item: ScholarshipListItem }) {
  if (item.deadline.kind === 'ROLLING') {
    return <span className="sch-pill sch-pill-info">Rolling deadline</span>;
  }
  if (!item.deadline.date) {
    // Never invent urgency where the source gave none
    return <span className="sch-pill sch-pill-muted">Deadline not stated</span>;
  }
  const days = daysUntil(item.deadline.date);
  if (days === null) return <span className="sch-pill sch-pill-muted">Deadline not stated</span>;
  if (days < 0) return <span className="sch-pill sch-pill-closed">Closed {formatDate(item.deadline.date)}</span>;
  if (days <= 14) return <span className="sch-pill sch-pill-urgent">{days === 0 ? 'Closes today' : `${days} day${days === 1 ? '' : 's'} left`}</span>;
  return <span className="sch-pill sch-pill-ok">{formatDate(item.deadline.date)}</span>;
}

function FundingBadge({ item }: { item: ScholarshipListItem }) {
  const type = item.funding.primaryType;
  if (type === 'UNKNOWN') return <span className="sch-tag sch-tag-muted">Funding not stated</span>;
  const derived = item.funding.certainty === 'PROBABLE';
  return (
    <span className={`sch-tag ${type === 'FULLY_FUNDED' ? 'sch-tag-gold' : 'sch-tag-accent'}`}>
      {label(FUNDING_LABELS, type)}
      {/* A derived classification is marked, never presented as stated fact */}
      {derived && <span className="sch-tag-qualifier" title="Inferred from the funding described, not stated verbatim"> (inferred)</span>}
    </span>
  );
}

function ProvenanceLine({ item }: { item: ScholarshipListItem }) {
  return (
    <div className="sch-provenance">
      {item.hasOfficialSource
        ? <span className="sch-prov sch-prov-official" title="Sourced from the institution or a government site">◆ Official source</span>
        : <span className="sch-prov sch-prov-aggregated" title="Not yet traced to an official institutional page">◇ Aggregated</span>}
      {item.extractionMethod !== 'MANUAL' && (
        <span className="sch-prov sch-prov-auto" title={`Extracted automatically (${item.extractionMethod.toLowerCase()})`}>
          ◈ Auto-extracted
        </span>
      )}
      {item.needsVerification && (
        <span className="sch-prov sch-prov-review" title="Confidence below the auto-approval threshold — verify against the official page">
          ⚠ Needs verification
        </span>
      )}
    </div>
  );
}

function ScholarshipCard({ item }: { item: ScholarshipListItem }) {
  const stipend = formatMoney(item.funding.stipendAmount, item.funding.stipendCurrency);
  return (
    <Link to={`/scholarships/${item.id}`} className="sch-card">
      <div className="sch-card-head">
        <div className="sch-card-titles">
          <h3 className="sch-card-title">{item.title}</h3>
          <div className="sch-card-sub">
            {item.university ?? item.provider ?? 'Unknown provider'}
            <span className="sch-dot">·</span>
            {item.country}
          </div>
        </div>
        {item.match && (
          <div className={`sch-match ${item.match.uncertain ? 'sch-match-soft' : ''}`}>
            <div className="sch-match-pct">{item.match.percentage}%</div>
            <div className="sch-match-label">match</div>
          </div>
        )}
      </div>

      <div className="sch-tags">
        <FundingBadge item={item} />
        {item.degreeLevels.map((d) => (
          <span key={d} className="sch-tag">{label(DEGREE_LABELS, d)}</span>
        ))}
        {item.attendance[0] !== 'UNKNOWN' && item.attendance.map((a) => (
          <span key={a} className="sch-tag sch-tag-quiet">{label(MODE_LABELS, a)}</span>
        ))}
        {item.studyMode[0] !== 'UNKNOWN' && item.studyMode.map((m) => (
          <span key={m} className="sch-tag sch-tag-quiet">{label(MODE_LABELS, m)}</span>
        ))}
      </div>

      {stipend && <div className="sch-stipend">Stipend {stipend}</div>}

      <div className="sch-card-foot">
        <DeadlinePill item={item} />
        <span className={`badge ${statusTone(item.status)}`}>{label(STATUS_LABELS, item.status)}</span>
      </div>

      {item.nationalityMatch === 'INTERNATIONAL_UNCONFIRMED' && (
        <div className="sch-note">
          {/* §58 rendered honestly for the applicant */}
          Open to international applicants — no explicit country list was published
        </div>
      )}
      {item.nationalityMatch === 'EXPLICIT' && (
        <div className="sch-note sch-note-good">Your nationality is explicitly listed as eligible</div>
      )}

      <ProvenanceLine item={item} />
    </Link>
  );
}

function FilterGroup({
  title, options, selected, onToggle, labels
}: {
  title: string;
  options: string[];
  selected: string[];
  onToggle: (v: string) => void;
  labels?: Record<string, string>;
}) {
  return (
    <div className="sch-filter-group">
      <div className="sch-filter-title">{title}</div>
      <div className="sch-filter-options">
        {options.map((o) => (
          <button
            key={o}
            type="button"
            className={`sch-chip ${selected.includes(o) ? 'active' : ''}`}
            onClick={() => onToggle(o)}
          >
            {labels ? label(labels, o) : o}
          </button>
        ))}
      </div>
    </div>
  );
}

export function ScholarshipSearchPage() {
  const [params, setParams] = useSearchParams();
  const [data, setData] = React.useState<ListResponse | null>(null);
  const [facets, setFacets] = React.useState<Facets | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [search, setSearch] = React.useState(params.get('q') ?? '');

  const get = (k: string): string[] => (params.get(k) ?? '').split(',').filter(Boolean);

  const setParam = (k: string, v: string | null) => {
    const next = new URLSearchParams(params);
    if (!v) next.delete(k);
    else next.set(k, v);
    next.delete('page'); // any filter change resets pagination
    setParams(next, { replace: true });
  };

  const toggle = (k: string, v: string) => {
    const current = get(k);
    const next = current.includes(v) ? current.filter((x) => x !== v) : [...current, v];
    setParam(k, next.length ? next.join(',') : null);
  };

  React.useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    const qs = new URLSearchParams(params);
    if (!qs.get('limit')) qs.set('limit', '20');
    publicFetch<ListResponse>(`/scholarships?${qs.toString()}`)
      .then((r) => { if (!cancelled) setData(r); })
      .catch((e) => { if (!cancelled) setError(String(e?.message ?? 'Failed to load')); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [params]);

  React.useEffect(() => {
    publicFetch<Facets>('/scholarships/facets')
      .then(setFacets)
      .catch(() => undefined); // facets are a nicety, not a requirement
  }, []);

  const submitSearch = (e: React.FormEvent) => {
    e.preventDefault();
    setParam('q', search.trim() || null);
  };

  const page = Number(params.get('page') ?? 1);
  const goTo = (p: number) => {
    const next = new URLSearchParams(params);
    next.set('page', String(p));
    setParams(next);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const activeFilters = ['degree', 'country', 'funding', 'studyMode', 'attendance', 'nationality', 'status', 'fullyFunded']
    .filter((k) => params.get(k));

  return (
    <div className="sch-layout">
      <aside className="sch-sidebar">
        <FilterGroup
          title="Degree level"
          options={DEGREES}
          selected={get('degree')}
          onToggle={(v) => toggle('degree', v)}
          labels={DEGREE_LABELS}
        />

        <div className="sch-filter-group">
          <div className="sch-filter-title">Funding</div>
          <label className="sch-check">
            <input
              type="checkbox"
              checked={params.get('fullyFunded') === 'true'}
              onChange={(e) => setParam('fullyFunded', e.target.checked ? 'true' : null)}
            />
            Fully funded only
          </label>
          {params.get('fullyFunded') !== 'true' && (
            <div className="sch-filter-options">
              {FUNDING.map((f) => (
                <button
                  key={f}
                  type="button"
                  className={`sch-chip ${get('funding').includes(f) ? 'active' : ''}`}
                  onClick={() => toggle('funding', f)}
                >
                  {label(FUNDING_LABELS, f)}
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="sch-filter-group">
          <div className="sch-filter-title">Country</div>
          <select
            className="input sch-select"
            value={params.get('country') ?? ''}
            onChange={(e) => setParam('country', e.target.value || null)}
          >
            <option value="">Any country</option>
            {(facets?.countries ?? []).map((c) => (
              <option key={c.code} value={c.code}>{c.name} ({c.count})</option>
            ))}
          </select>
        </div>

        <div className="sch-filter-group">
          <div className="sch-filter-title">Your nationality</div>
          <input
            className="input sch-select"
            placeholder="e.g. Kenya"
            defaultValue={params.get('nationality') ?? ''}
            onBlur={(e) => setParam('nationality', e.target.value.trim() || null)}
          />
          <div className="sch-filter-hint">
            Shows awards that name your country, cover your region, or accept international applicants.
          </div>
        </div>

        <FilterGroup title="Study mode" options={MODES} selected={get('studyMode')} onToggle={(v) => toggle('studyMode', v)} labels={MODE_LABELS} />
        <FilterGroup title="Attendance" options={ATTENDANCE} selected={get('attendance')} onToggle={(v) => toggle('attendance', v)} labels={MODE_LABELS} />
        <FilterGroup title="Status" options={STATUSES} selected={get('status')} onToggle={(v) => toggle('status', v)} labels={STATUS_LABELS} />

        {(facets?.fields.length ?? 0) > 0 && (
          <div className="sch-filter-group">
            <div className="sch-filter-title">Field of study</div>
            <select
              className="input sch-select"
              value={params.get('field') ?? ''}
              onChange={(e) => setParam('field', e.target.value || null)}
            >
              <option value="">Any field</option>
              {facets!.fields.map((f) => (
                <option key={f.value} value={f.value}>{f.value} ({f.count})</option>
              ))}
            </select>
          </div>
        )}

        {activeFilters.length > 0 && (
          <button className="btn secondary sch-clear" onClick={() => setParams(new URLSearchParams())}>
            Clear all filters
          </button>
        )}

        <AdSlot placement="listing_sidebar" country={params.get('country')} degree={params.get('degree')} />
      </aside>

      <main className="sch-results">
        <form className="sch-searchbar" onSubmit={submitSearch}>
          <input
            className="input"
            placeholder="Search scholarships, universities, fields…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <button className="btn" type="submit">Search</button>
        </form>

        <div className="sch-results-head">
          <div>
            {loading ? 'Searching…' : data
              ? <><strong>{data.pagination.total.toLocaleString()}</strong> scholarship{data.pagination.total === 1 ? '' : 's'}</>
              : ''}
          </div>
          <QuotaPill />
          <select
            className="input sch-sort"
            value={params.get('sort') ?? 'deadline'}
            onChange={(e) => setParam('sort', e.target.value)}
          >
            <option value="deadline">Deadline soonest</option>
            <option value="newest">Recently added</option>
            <option value="quality">Best documented</option>
            <option value="confidence">Highest confidence</option>
          </select>
        </div>

        {error && <div className="error">{error}</div>}

        {!loading && data && data.items.length === 0 && (
          <div className="sch-empty">
            <div className="sch-empty-icon">◌</div>
            <h3>No scholarships match these filters</h3>
            <p className="muted">
              Try widening the degree level or removing the country filter. If the index is still being
              built, run a crawl from the admin panel.
            </p>
          </div>
        )}

        <div className="sch-cards">
          {data?.items.map((item, i) => (
            <React.Fragment key={item.id}>
              <ScholarshipCard item={item} />
              {/* One inline placement, deep enough that it never displaces the
                  first results a reader came for. */}
              {i === 3 && <AdSlot placement="listing_inline" country={params.get('country')} degree={params.get('degree')} />}
            </React.Fragment>
          ))}
        </div>

        {data && data.pagination.totalPages > 1 && (
          <div className="sch-pagination">
            <button className="btn secondary" disabled={page <= 1} onClick={() => goTo(page - 1)}>Previous</button>
            <span className="muted">Page {data.pagination.page} of {data.pagination.totalPages}</span>
            <button className="btn secondary" disabled={!data.pagination.hasMore} onClick={() => goTo(page + 1)}>Next</button>
          </div>
        )}
      </main>
    </div>
  );
}
