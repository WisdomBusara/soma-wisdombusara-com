import React from 'react';
import { Link, useParams } from 'react-router-dom';
import { PaywallGate, AdSlot } from './Paywall';
import {
  publicFetch, DEGREE_LABELS, FUNDING_LABELS, MODE_LABELS, STATUS_LABELS,
  label, formatDate, daysUntil, formatMoney, statusTone, triState,
  type ScholarshipDetail
} from '../api/scholarships';

/**
 * Scholarship detail (§43, §44).
 *
 * The design goal here is honesty about where each fact came from. Three
 * distinctions are always visible:
 *
 *   • covered / not covered / not stated       (tri-state, never a silent no)
 *   • confirmed / inferred                     (certainty of the reading)
 *   • official source / aggregated             (authority of the origin)
 *
 * Hovering any extracted value reveals the exact sentence the crawler read.
 */

function EvidenceValue({
  labelText, field
}: {
  labelText: string;
  field: { value: boolean | null; certainty?: string; sourceText?: string } | undefined;
}) {
  const state = triState(field?.value);
  const hedged = field?.certainty === 'PROBABLE';
  return (
    <div className={`sch-fund-row sch-fund-${state.tone}`} title={field?.sourceText ?? 'Not mentioned on the source page'}>
      <span className="sch-fund-icon">{state.icon}</span>
      <span className="sch-fund-label">{labelText}</span>
      <span className="sch-fund-state">
        {state.text}
        {hedged && state.tone === 'yes' && <em className="sch-hedge"> (conditional)</em>}
      </span>
    </div>
  );
}

function Section({ title, children, note }: { title: string; children: React.ReactNode; note?: string }) {
  return (
    <section className="sch-section">
      <h2 className="sch-section-title">{title}</h2>
      {note && <p className="sch-section-note">{note}</p>}
      {children}
    </section>
  );
}

function EnglishRequirements({ english }: { english: any }) {
  const tests = [
    { key: 'ielts', name: 'IELTS' },
    { key: 'toefl', name: 'TOEFL' },
    { key: 'pte', name: 'PTE' },
    { key: 'duolingo', name: 'Duolingo' }
  ];
  const mentioned = tests.filter((t) => english?.[t.key]?.required !== null && english?.[t.key]?.required !== undefined);

  if (mentioned.length === 0) {
    return (
      <p className="sch-unknown-block">
        {/* §56 stated plainly to the applicant */}
        No English language requirement was found on the source page. This does <strong>not</strong> mean
        one is not required — check the official page before applying.
      </p>
    );
  }

  return (
    <ul className="sch-req-list">
      {mentioned.map((t) => {
        const r = english[t.key];
        return (
          <li key={t.key} title={r.sourceText ?? ''}>
            <strong>{t.name}</strong>{' '}
            {r.required === false
              ? 'not required'
              : r.minScore !== null && r.minScore !== undefined
                ? <>minimum {r.minScore}{r.detail ? ` — ${r.detail}` : ''}</>
                : 'required, no minimum score published'}
            {r.waiverAvailable && <span className="sch-tag sch-tag-quiet">waiver available</span>}
          </li>
        );
      })}
    </ul>
  );
}

export function ScholarshipDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [s, setS] = React.useState<ScholarshipDetail | null>(null);
  const [locked, setLocked] = React.useState<any | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!id) return;
    let cancelled = false;
    setLoading(true);
    setLocked(null);
    publicFetch<ScholarshipDetail>(`/scholarships/${id}`)
      .then((r) => { if (!cancelled) setS(r); })
      .catch((e) => {
        if (cancelled) return;
        // A 402 is not an error state — it is the paywall doing its job, and
        // it arrives with enough preview data to keep the page meaningful.
        const payload = e?.payload;
        if (payload?.error === 'free_limit_reached') setLocked(payload.preview ?? {});
        else setError(String(e?.message ?? 'Failed to load'));
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [id]);

  if (loading) return <div className="loading">Loading…</div>;
  if (locked) return <div className="sch-detail"><PaywallGate preview={locked} /></div>;
  if (error) return <div className="sch-detail"><div className="error">{error}</div><Link to="/scholarships">← Back to search</Link></div>;
  if (!s) return null;

  const f = s.fundingDetail ?? {};
  const e = s.eligibilityDetail ?? {};
  const r = s.requirements ?? {};
  const days = daysUntil(s.deadline.date);
  const stipend = formatMoney(f.stipendAmount?.amount ?? null, f.stipendAmount?.currency ?? null);
  const primarySource = s.sources.find((x) => x.isPrimary) ?? s.sources[0];

  return (
    <article className="sch-detail">
      <Link to="/scholarships" className="sch-back">← Back to search</Link>

      <header className="sch-detail-head">
        <div className="sch-detail-eyebrow">
          {s.universityRef
            ? <Link to={`/universities/${s.universityRef.id}`}>{s.universityRef.name}</Link>
            : <span>{s.provider ?? 'Unknown provider'}</span>}
          <span className="sch-dot">·</span>
          {s.city ? `${s.city}, ${s.country}` : s.country}
        </div>

        <h1 className="sch-detail-title">{s.title}</h1>

        <div className="sch-detail-badges">
          {s.funding.primaryType !== 'UNKNOWN' && (
            <span className={`sch-hero-badge ${s.funding.primaryType === 'FULLY_FUNDED' ? 'gold' : ''}`}>
              {label(FUNDING_LABELS, s.funding.primaryType)}
              {s.funding.certainty === 'PROBABLE' && <em> (inferred)</em>}
            </span>
          )}
          {s.degreeLevels.map((d) => <span key={d} className="sch-hero-badge">{label(DEGREE_LABELS, d)}</span>)}
          {s.attendance.filter((a) => a !== 'UNKNOWN').map((a) => <span key={a} className="sch-hero-badge quiet">{label(MODE_LABELS, a)}</span>)}
          {s.studyMode.filter((m) => m !== 'UNKNOWN').map((m) => <span key={m} className="sch-hero-badge quiet">{label(MODE_LABELS, m)}</span>)}
          <span className={`badge ${statusTone(s.status)}`}>{label(STATUS_LABELS, s.status)}</span>
        </div>

        {s.needsVerification && (
          <div className="sch-warning-banner">
            <strong>Needs verification.</strong> This record was extracted automatically and scored below
            our confidence threshold ({Math.round(s.confidence * 100)}%). Confirm every detail on the
            official page before you apply.
          </div>
        )}
      </header>

      <div className="sch-detail-grid">
        <div className="sch-detail-main">
          {s.description && <p className="sch-lede">{s.description}</p>}

          <Section
            title="Funding"
            note="Each line reflects what the source page states. “Not stated” means the page was silent — it does not mean the cost is excluded."
          >
            {stipend && (
              <div className="sch-stipend-callout">
                <div className="sch-stipend-amount">{stipend}</div>
                <div className="sch-stipend-period">
                  {f.stipendAmount?.period ?? 'stipend'}
                  {f.stipendAmount?.originalText && (
                    <span className="sch-verbatim" title={f.stipendAmount.originalText}> · as published</span>
                  )}
                </div>
              </div>
            )}
            <div className="sch-fund-grid">
              <EvidenceValue labelText="Tuition fees" field={f.tuitionCovered} />
              <EvidenceValue labelText="Living stipend" field={f.livingStipend} />
              <EvidenceValue labelText="Accommodation" field={f.accommodationCovered} />
              <EvidenceValue labelText="Health insurance" field={f.healthInsurance} />
              <EvidenceValue labelText="Travel allowance" field={f.travelCovered} />
              <EvidenceValue labelText="Airfare" field={f.airfareCovered} />
              <EvidenceValue labelText="Research allowance" field={f.researchAllowance} />
              <EvidenceValue labelText="Application fee waiver" field={f.applicationFeeWaiver} />
            </div>
            {f.tuitionPercentage?.value != null && (
              <p className="muted">Covers {f.tuitionPercentage.value}% of tuition fees.</p>
            )}
            {f.awardCount?.value != null && (
              <p className="muted">{f.awardCount.value} award{f.awardCount.value === 1 ? '' : 's'} available.</p>
            )}
          </Section>

          <Section title="Eligibility">
            {e.scope === 'SPECIFIC_COUNTRIES' && e.countries?.length > 0 && (
              <p><strong>Open to nationals of:</strong> {e.countries.join(', ')}</p>
            )}
            {e.scope === 'INTERNATIONAL' && (
              <p title={e.scopeSourceText ?? ''}>
                Open to <strong>international applicants</strong>.{' '}
                <span className="muted">
                  The source page did not publish an explicit list of eligible countries, so we cannot
                  confirm any specific nationality.
                </span>
              </p>
            )}
            {e.scope === 'BOTH' && <p>Open to <strong>home and international</strong> applicants.</p>}
            {e.scope === 'DOMESTIC' && <p>Restricted to <strong>domestic</strong> applicants.</p>}
            {e.scope === 'SPECIFIC_REGIONS' && e.regions?.length > 0 && (
              <p><strong>Open to applicants from:</strong> {e.regions.map((x: string) => x.replace(/_/g, ' ').toLowerCase()).join(', ')}</p>
            )}
            {e.scope === 'UNKNOWN' && (
              <p className="sch-unknown-block">Eligibility was not stated on the source page.</p>
            )}
            {e.excludedCountries?.length > 0 && (
              <p><strong>Explicitly excluded:</strong> {e.excludedCountries.join(', ')}</p>
            )}
            {e.categories?.length > 0 && (
              <p><strong>Priority groups:</strong> {e.categories.map((c: string) => c.replace(/_/g, ' ')).join(', ')}</p>
            )}
            {(e.ageMin?.value != null || e.ageMax?.value != null) && (
              <p><strong>Age:</strong> {e.ageMin?.value ?? '—'} to {e.ageMax?.value ?? '—'}</p>
            )}
          </Section>

          <Section title="Academic requirements">
            <ul className="sch-req-list">
              {r.minimumDegree?.value && (
                <li title={r.minimumDegree.sourceText ?? ''}>
                  <strong>Minimum degree:</strong> {label(DEGREE_LABELS, r.minimumDegree.value)}
                </li>
              )}
              {r.minimumGrade?.value && (
                <li title={r.minimumGrade.sourceText ?? ''}><strong>Minimum classification:</strong> {r.minimumGrade.value}</li>
              )}
              {r.minimumGpa?.value != null && (
                <li title={r.minimumGpa.sourceText ?? ''}>
                  <strong>Minimum GPA:</strong> {r.minimumGpa.value}{r.gpaScale?.value ? ` / ${r.gpaScale.value}` : ''}
                </li>
              )}
              {r.workExperienceRequired?.value === true && (
                <li><strong>Work experience:</strong> {r.workExperienceYears?.value ? `${r.workExperienceYears.value}+ years` : 'required'}</li>
              )}
              {r.supervisorRequired?.value === true && <li>A supervisor must be identified before applying</li>}
              {r.admissionOfferRequired?.value === true && <li>An offer of admission is required</li>}
              {!r.minimumDegree?.value && !r.minimumGrade?.value && r.minimumGpa?.value == null && (
                <li className="muted">No academic requirements were found on the source page.</li>
              )}
            </ul>
          </Section>

          <Section title="English language">
            <EnglishRequirements english={r.english} />
          </Section>

          {r.documents?.length > 0 && (
            <Section title="Documents to submit">
              <ul className="sch-doc-list">
                {r.documents.map((d: any) => (
                  <li key={d.code} title={d.sourceText ?? ''}>
                    <span className="sch-doc-check">✓</span>
                    {d.count ? `${d.count} × ` : ''}{d.label}
                  </li>
                ))}
              </ul>
            </Section>
          )}
        </div>

        <aside className="sch-detail-side">
          <div className="sch-side-card">
            <div className="sch-side-title">Deadline</div>
            {s.deadline.kind === 'ROLLING' ? (
              <div className="sch-side-value">Rolling — applications accepted year-round</div>
            ) : s.deadline.date ? (
              <>
                <div className="sch-side-value">{formatDate(s.deadline.date)}</div>
                {days !== null && days >= 0 && (
                  <div className={`sch-side-meta ${days <= 14 ? 'urgent' : ''}`}>
                    {days === 0 ? 'Closes today' : `${days} days remaining`}
                  </div>
                )}
                {days !== null && days < 0 && <div className="sch-side-meta closed">Closed</div>}
              </>
            ) : (
              <div className="sch-side-value muted">Not stated on the source page</div>
            )}
            {s.deadlineDetail?.originalText && (
              <div className="sch-side-verbatim">“{s.deadlineDetail.originalText}”</div>
            )}
            {s.deadlineDetail?.timezoneStated
              ? <div className="sch-side-meta">Timezone: {s.deadlineDetail.timezoneStated}</div>
              : s.deadline.date && <div className="sch-side-meta muted">No timezone stated by the source</div>}
          </div>

          {s.applicationUrl ? (
            <a className="btn sch-apply" href={s.applicationUrl} target="_blank" rel="noopener noreferrer">
              Apply on the official site →
            </a>
          ) : (
            <div className="sch-side-card">
              <div className="sch-side-title">Application link</div>
              <div className="sch-side-value muted">
                No direct application link was found. Use the official source below.
              </div>
            </div>
          )}

          <div className="sch-side-card">
            <div className="sch-side-title">Source</div>
            {primarySource && (
              <>
                <div className={`sch-source-type ${['UNIVERSITY', 'GOVERNMENT'].includes(primarySource.type) ? 'official' : ''}`}>
                  {primarySource.type === 'UNIVERSITY' ? 'Official university website'
                    : primarySource.type === 'GOVERNMENT' ? 'Official government website'
                    : primarySource.type === 'FACULTY' ? 'Faculty / department page'
                    : primarySource.type === 'PDF' ? 'Official PDF document'
                    : primarySource.type === 'AGGREGATOR' ? 'Third-party aggregator'
                    : 'Institutional page'}
                </div>
                <a className="sch-source-link" href={primarySource.url} target="_blank" rel="noopener noreferrer">
                  {primarySource.url}
                </a>
              </>
            )}
            {s.sources.length > 1 && (
              <details className="sch-source-more">
                <summary>{s.sources.length - 1} other source{s.sources.length === 2 ? '' : 's'}</summary>
                <ul>
                  {s.sources.filter((x) => !x.isPrimary).map((x) => (
                    <li key={x.url}>
                      <a href={x.url} target="_blank" rel="noopener noreferrer">{x.url}</a>
                      <span className="muted"> · {x.type.toLowerCase()}</span>
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </div>

          <AdSlot placement="detail_sidebar" country={s.countryCode} degree={s.degreeLevels[0]} />

          <div className="sch-side-card">
            <div className="sch-side-title">Record details</div>
            <dl className="sch-meta-list">
              {s.academicYear && <><dt>Academic year</dt><dd>{s.academicYear}</dd></>}
              {s.intake && <><dt>Intake</dt><dd>{s.intake}</dd></>}
              {s.duration && <><dt>Duration</dt><dd>{s.duration}</dd></>}
              <dt>Extraction</dt>
              <dd>{s.extractionMethod === 'MANUAL' ? 'Manually verified' : s.extractionMethod === 'HYBRID' ? 'Rules + AI' : 'Rule-based'}</dd>
              <dt>Confidence</dt>
              <dd>
                <div className="sch-conf-bar"><span style={{ width: `${Math.round(s.confidence * 100)}%` }} /></div>
                {Math.round(s.confidence * 100)}%
              </dd>
              <dt>Last checked</dt>
              <dd>{formatDate(s.lastCrawledAt)}</dd>
              {s.lastVerifiedAt && <><dt>Last verified</dt><dd>{formatDate(s.lastVerifiedAt)}</dd></>}
            </dl>
            <p className="sch-conf-note">
              Confidence is an operational signal about extraction quality — not a guarantee that the
              information is correct. Always confirm on the official page.
            </p>
          </div>
        </aside>
      </div>
    </article>
  );
}
