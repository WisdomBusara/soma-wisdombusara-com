import React from 'react';
import { apiFetch } from '../api/client';
import { DEGREE_LABELS, FUNDING_LABELS, STATUS_LABELS, label, formatDate, statusTone } from '../api/scholarships';

/**
 * Scholarship engine admin (§32, §33, §34, §61).
 *
 * One page with tabs rather than five sidebar entries — the operational
 * workflow moves between the queue, the review list and the run log constantly,
 * and splitting them across routes would mean losing filter state on every hop.
 */

type Tab = 'overview' | 'scholarships' | 'universities' | 'targets' | 'runs' | 'changes';

interface Metrics {
  universities: { total: number; active: number; unverified: number };
  crawlTargets: { total: number; pending: number; blocked: number; failed: number };
  scholarships: { total: number; open: number; closingSoon: number; expired: number; needsReview: number };
  lastRun: any;
  config: Record<string, unknown>;
}

interface BotStatus {
  configured: boolean;
  botUsername?: string;
  botName?: string;
  channelId?: string;
  webhookUrl?: string;
  webhookOk?: boolean;
  pendingUpdateCount?: number;
  lastWebhookError?: string;
  error?: string;
}

const pct = (n: number) => `${Math.round(n * 100)}%`;

export function ScholarshipsAdminPage() {
  const [tab, setTab] = React.useState<Tab>('overview');
  const [metrics, setMetrics] = React.useState<Metrics | null>(null);
  const [botStatus, setBotStatus] = React.useState<BotStatus | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [success, setSuccess] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState<string | null>(null);

  const notify = (m: string) => { setSuccess(m); setTimeout(() => setSuccess(null), 4000); };

  const loadMetrics = React.useCallback(async () => {
    try {
      setMetrics(await apiFetch<Metrics>('/admin/scholarship/metrics'));
    } catch (e: any) {
      setError(String(e?.message ?? 'Failed to load metrics'));
    }
  }, []);

  const loadBotStatus = React.useCallback(async () => {
    try {
      setBotStatus(await apiFetch<BotStatus>('/admin/scholarship/bot-status'));
    } catch {
      setBotStatus({ configured: false, error: 'Could not reach the status endpoint' });
    }
  }, []);

  React.useEffect(() => { void loadMetrics(); void loadBotStatus(); }, [loadMetrics, loadBotStatus]);

  const action = async (name: string, path: string, body?: unknown) => {
    setBusy(name);
    setError(null);
    try {
      const r = await apiFetch<any>(path, { method: 'POST', body: body ? JSON.stringify(body) : undefined });
      notify(r?.started ? `${name} started in the background` : `${name} complete`);
      await loadMetrics();
      return r;
    } catch (e: any) {
      setError(String(e?.message ?? `${name} failed`));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div>
      <h1 className="page-title">Scholarship Engine</h1>

      {error && <div className="error">{error}</div>}
      {success && <div className="success">{success}</div>}

      <div className="row" style={{ marginBottom: 20 }}>
        {(['overview', 'scholarships', 'universities', 'targets', 'runs', 'changes'] as Tab[]).map((t) => (
          <button
            key={t}
            className={`btn ${tab === t ? '' : 'secondary'}`}
            onClick={() => setTab(t)}
          >
            {t[0].toUpperCase() + t.slice(1)}
          </button>
        ))}
      </div>

      {tab === 'overview' && (
        <>
          {metrics && (
            <>
              <div className="stats-grid">
                <div className="stat-card green">
                  <div className="stat-value">{metrics.scholarships.open}</div>
                  <div className="stat-label">Open</div>
                </div>
                <div className="stat-card warn">
                  <div className="stat-value">{metrics.scholarships.closingSoon}</div>
                  <div className="stat-label">Closing soon</div>
                </div>
                <div className="stat-card">
                  <div className="stat-value">{metrics.scholarships.total}</div>
                  <div className="stat-label">Total scholarships</div>
                </div>
                <div className="stat-card warn">
                  <div className="stat-value">{metrics.scholarships.needsReview}</div>
                  <div className="stat-label">Needs review</div>
                </div>
                <div className="stat-card">
                  <div className="stat-value">{metrics.universities.active}</div>
                  <div className="stat-label">Universities active</div>
                </div>
                <div className="stat-card">
                  <div className="stat-value">{metrics.crawlTargets.pending}</div>
                  <div className="stat-label">Queue pending</div>
                </div>
                <div className="stat-card">
                  <div className="stat-value">{metrics.crawlTargets.failed}</div>
                  <div className="stat-label">Crawl failures</div>
                </div>
                <div className="stat-card">
                  <div className="stat-value">{metrics.crawlTargets.blocked}</div>
                  <div className="stat-label">Blocked</div>
                </div>
              </div>

              <div className="card">
                <div className="card-title">Engine configuration</div>
                <div className="row">
                  {Object.entries(metrics.config).map(([k, v]) => (
                    <span key={k} className={`badge ${v === true ? 'green' : v === false ? 'gray' : 'yellow'}`}>
                      {k}: {String(v)}
                    </span>
                  ))}
                </div>
                {metrics.config.crawlerEnabled === false && (
                  <p className="muted" style={{ marginTop: 12 }}>
                    The crawler is disabled. Set <code>SCHOLARSHIP_CRAWLER_ENABLED=true</code> to enable
                    scheduled runs. Manual actions below still work.
                  </p>
                )}
              </div>
            </>
          )}

          {botStatus && (
            <div className="card">
              <div className="card-title">Telegram bot</div>
              {!botStatus.configured ? (
                <p className="muted">
                  Not configured. Set <code>SCHOLARSHIP_TELEGRAM_BOT_TOKEN</code> in the backend&rsquo;s
                  .env and restart to enable Telegram delivery and group membership.
                </p>
              ) : botStatus.error ? (
                <p className="error" style={{ margin: 0 }}>{botStatus.error}</p>
              ) : (
                <>
                  <div className="row" style={{ marginBottom: 10 }}>
                    <span className="badge green">@{botStatus.botUsername}</span>
                    {botStatus.botName && <span className="badge gray">{botStatus.botName}</span>}
                    <span className={`badge ${botStatus.webhookOk ? 'green' : 'yellow'}`}>
                      Webhook {botStatus.webhookOk ? 'registered' : 'not set'}
                    </span>
                    {typeof botStatus.pendingUpdateCount === 'number' && (
                      <span className={`badge ${botStatus.pendingUpdateCount > 0 ? 'yellow' : 'gray'}`}>
                        {botStatus.pendingUpdateCount} pending update{botStatus.pendingUpdateCount === 1 ? '' : 's'}
                      </span>
                    )}
                  </div>
                  {botStatus.webhookUrl && (
                    <div className="muted mono" style={{ fontSize: 12, marginBottom: 6 }}>{botStatus.webhookUrl}</div>
                  )}
                  {botStatus.channelId && (
                    <div className="muted" style={{ fontSize: 12 }}>Channel: <span className="mono">{botStatus.channelId}</span></div>
                  )}
                  {botStatus.lastWebhookError && (
                    <p className="error" style={{ marginTop: 10 }}>Last webhook error: {botStatus.lastWebhookError}</p>
                  )}
                  <button className="btn secondary" style={{ marginTop: 12 }} onClick={() => void loadBotStatus()}>
                    Refresh
                  </button>
                </>
              )}
            </div>
          )}

          <div className="card">
            <div className="card-title">Operations</div>
            <div className="row">
              <button className="btn" disabled={busy !== null}
                onClick={() => action('Discovery', '/admin/scholarship/discover-universities', {})}>
                {busy === 'Discovery' ? 'Discovering…' : 'Discover universities'}
              </button>
              <button className="btn" disabled={busy !== null}
                onClick={() => action('Crawl', '/admin/scholarship/run', { crawlLimit: 100 })}>
                {busy === 'Crawl' ? 'Starting…' : 'Run full cycle'}
              </button>
              <button className="btn secondary" disabled={busy !== null}
                onClick={async () => {
                  const r = await action('Dry run', '/admin/scholarship/run', { dryRun: true, crawlLimit: 20 });
                  if (r?.summary) notify(`Dry run: ${JSON.stringify(r.summary.crawl ?? {})}`);
                }}>
                {busy === 'Dry run' ? 'Running…' : 'Dry run'}
              </button>
              <button className="btn secondary" disabled={busy !== null}
                onClick={() => action('Status refresh', '/admin/scholarship/refresh-statuses')}>
                Refresh statuses
              </button>
              <button className="btn secondary" disabled={busy !== null}
                onClick={() => action('Reprioritise', '/admin/scholarship/reprioritize')}>
                Reprioritise queue
              </button>
            </div>
          </div>

          <LearningCard onError={setError} onNotify={notify} />

          {metrics?.lastRun && (
            <div className="card">
              <div className="card-title">Last run</div>
              <div className="row">
                <span className={`badge ${metrics.lastRun.state === 'COMPLETED' ? 'green' : metrics.lastRun.state === 'RUNNING' ? 'yellow' : 'red'}`}>
                  {metrics.lastRun.state}
                </span>
                <span className="muted">{formatDate(metrics.lastRun.startedAt)}</span>
                {metrics.lastRun.durationMs && (
                  <span className="muted">{Math.round(metrics.lastRun.durationMs / 1000)}s</span>
                )}
              </div>
              <div className="divider" />
              <div className="stats-grid">
                {Object.entries(metrics.lastRun.metrics ?? {})
                  .filter(([, v]) => typeof v === 'number' && (v as number) > 0)
                  .map(([k, v]) => (
                    <div key={k} className="stat-card">
                      <div className="stat-value">{String(v)}</div>
                      <div className="stat-label">{k.replace(/([A-Z])/g, ' $1').toLowerCase()}</div>
                    </div>
                  ))}
              </div>
            </div>
          )}
        </>
      )}

      {tab === 'scholarships' && <ScholarshipTable onError={setError} onNotify={notify} />}
      {tab === 'universities' && <UniversityTable onError={setError} onNotify={notify} />}
      {tab === 'targets' && <TargetTable onError={setError} onNotify={notify} />}
      {tab === 'runs' && <RunTable onError={setError} />}
      {tab === 'changes' && <ChangeTable onError={setError} />}
    </div>
  );
}

// ── Self-improvement loop ───────────────────────────────────────────────────
//
// Surfaces what learnFromFeedback() has been doing so the classifier weight
// nudges never become a black box: an operator can see exactly which reasons
// moved and by how much, and which sources are getting deprioritised.

interface LearningRow { reason: string; weight: number; approved: number; rejected: number; approveRate: number }
interface DomainRow { domain: string; approved: number; rejected: number; approveRate: number }
interface LearningData { weights: LearningRow[]; domains: DomainRow[]; pendingFeedback: number }

function LearningCard({ onError, onNotify }: { onError: (s: string) => void; onNotify: (s: string) => void }) {
  const [data, setData] = React.useState<LearningData | null>(null);
  const [busy, setBusy] = React.useState(false);

  const load = React.useCallback(async () => {
    try {
      setData(await apiFetch<LearningData>('/admin/scholarship/learning'));
    } catch (e: any) { onError(String(e?.message ?? 'Failed to load learning stats')); }
  }, [onError]);

  React.useEffect(() => { void load(); }, [load]);

  const runLearning = async () => {
    setBusy(true);
    try {
      const r = await apiFetch<any>('/admin/scholarship/learn', { method: 'POST' });
      onNotify(`Learning pass: ${r.processed} decision(s) folded in — ${r.weightsAdjusted} weight(s), ${r.domainsAdjusted} domain(s) adjusted`);
      await load();
    } catch (e: any) { onError(String(e?.message ?? 'Learning pass failed')); }
    finally { setBusy(false); }
  };

  if (!data) return null;

  return (
    <div className="card">
      <div className="card-title">Self-improvement (last 90 days)</div>
      <div className="row" style={{ marginBottom: 10 }}>
        <span className={`badge ${data.pendingFeedback > 0 ? 'yellow' : 'gray'}`}>
          {data.pendingFeedback} decision{data.pendingFeedback === 1 ? '' : 's'} not yet folded in
        </span>
        <button className="btn secondary" disabled={busy} onClick={runLearning}>
          {busy ? 'Running…' : 'Run learning pass'}
        </button>
      </div>
      <p className="muted" style={{ fontSize: 12, marginBottom: 12 }}>
        Every Approve/Reject you make nudges classifier signal weights (bounded to ±50%) and
        per-source crawl priority. Runs automatically at the end of each nightly cycle too.
      </p>

      {data.weights.length > 0 && (
        <>
          <div className="muted" style={{ fontSize: 12, marginBottom: 4 }}>Classifier signals</div>
          <table className="table" style={{ marginBottom: 14 }}>
            <thead><tr><th>Reason</th><th>Weight</th><th>Approved</th><th>Rejected</th><th>Approve rate</th></tr></thead>
            <tbody>
              {data.weights.slice(0, 15).map((w) => (
                <tr key={w.reason}>
                  <td>{w.reason}</td>
                  <td className="mono">{w.weight.toFixed(2)}×</td>
                  <td>{w.approved}</td>
                  <td>{w.rejected}</td>
                  <td className="mono">{Math.round(w.approveRate * 100)}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      {data.domains.length > 0 && (
        <>
          <div className="muted" style={{ fontSize: 12, marginBottom: 4 }}>Sources</div>
          <table className="table">
            <thead><tr><th>Domain</th><th>Approved</th><th>Rejected</th><th>Approve rate</th></tr></thead>
            <tbody>
              {data.domains.slice(0, 15).map((d) => (
                <tr key={d.domain}>
                  <td className="mono">{d.domain}</td>
                  <td>{d.approved}</td>
                  <td>{d.rejected}</td>
                  <td className="mono">{Math.round(d.approveRate * 100)}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      {data.weights.length === 0 && data.domains.length === 0 && (
        <p className="muted">No review decisions in the last 90 days yet — approve or reject a few scholarships to seed this.</p>
      )}
    </div>
  );
}

// ── Scholarships ────────────────────────────────────────────────────────────

function ScholarshipTable({ onError, onNotify }: { onError: (s: string) => void; onNotify: (s: string) => void }) {
  const [rows, setRows] = React.useState<any[]>([]);
  const [reviewOnly, setReviewOnly] = React.useState(false);
  const [statusFilter, setStatusFilter] = React.useState('');
  const [page, setPage] = React.useState(1);
  const [total, setTotal] = React.useState(0);
  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const [bulkBusy, setBulkBusy] = React.useState(false);

  const load = React.useCallback(async () => {
    try {
      const qs = new URLSearchParams({ page: String(page), limit: '25' });
      if (reviewOnly) qs.set('reviewStatus', 'NEEDS_REVIEW');
      if (statusFilter) qs.set('status', statusFilter);
      const r = await apiFetch<any>(`/admin/scholarship/scholarships?${qs}`);
      setRows(r.items);
      setTotal(r.pagination.total);
      setSelected(new Set());
    } catch (e: any) { onError(String(e?.message ?? 'Failed to load')); }
  }, [page, reviewOnly, statusFilter, onError]);

  React.useEffect(() => { void load(); }, [load]);

  const review = async (id: string, action: 'APPROVE' | 'REJECT') => {
    try {
      await apiFetch(`/admin/scholarship/scholarships/${id}`, { method: 'PATCH', body: JSON.stringify({ action }) });
      onNotify(`Scholarship ${action.toLowerCase()}d`);
      await load();
    } catch (e: any) { onError(String(e?.message ?? 'Action failed')); }
  };

  const recrawl = async (id: string) => {
    try {
      const r = await apiFetch<any>(`/admin/scholarship/scholarships/${id}/recrawl`, { method: 'POST' });
      onNotify(`Recrawl: ${r.result.status}`);
      await load();
    } catch (e: any) { onError(String(e?.message ?? 'Recrawl failed')); }
  };

  const toggleOne = (id: string, checked: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (checked) next.add(id); else next.delete(id);
      return next;
    });
  };

  const allOnPageSelected = rows.length > 0 && rows.every((s) => selected.has(s.id));
  const toggleAllOnPage = (checked: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev);
      for (const s of rows) { if (checked) next.add(s.id); else next.delete(s.id); }
      return next;
    });
  };

  const bulkReview = async (action: 'APPROVE' | 'REJECT') => {
    if (selected.size === 0) return;
    if (action === 'REJECT' &&
      !window.confirm(`Reject ${selected.size} selected scholarship(s)? They'll be closed and won't be re-created by the crawler.`)) {
      return;
    }
    setBulkBusy(true);
    try {
      const r = await apiFetch<any>('/admin/scholarship/scholarships/bulk', {
        method: 'PATCH',
        body: JSON.stringify({ ids: [...selected], action })
      });
      onNotify(`${r.updated} ${action.toLowerCase()}d${r.failed.length ? `, ${r.failed.length} failed` : ''}`);
      await load();
    } catch (e: any) { onError(String(e?.message ?? 'Bulk action failed')); }
    finally { setBulkBusy(false); }
  };

  return (
    <div className="card">
      <div className="row" style={{ marginBottom: 14 }}>
        <label className="row" style={{ gap: 6 }}>
          <input className="input" type="checkbox" checked={reviewOnly}
            onChange={(e) => { setReviewOnly(e.target.checked); setPage(1); }} />
          Needs review only
        </label>
        <select className="input" value={statusFilter} onChange={(e) => { setStatusFilter(e.target.value); setPage(1); }}>
          <option value="">All statuses</option>
          {Object.keys(STATUS_LABELS).map((s) => <option key={s} value={s}>{STATUS_LABELS[s]}</option>)}
        </select>
        <span className="muted">{total} total</span>
      </div>

      {selected.size > 0 && (
        <div className="row" style={{ marginBottom: 14, gap: 8 }}>
          <span className="badge yellow">{selected.size} selected</span>
          <button className="btn" disabled={bulkBusy} onClick={() => bulkReview('APPROVE')}>
            {bulkBusy ? 'Working…' : `Approve ${selected.size}`}
          </button>
          <button className="btn danger" disabled={bulkBusy} onClick={() => bulkReview('REJECT')}>
            {bulkBusy ? 'Working…' : `Reject ${selected.size}`}
          </button>
          <button className="btn secondary" disabled={bulkBusy} onClick={() => setSelected(new Set())}>
            Clear selection
          </button>
        </div>
      )}

      <table className="table">
        <thead>
          <tr>
            <th><input type="checkbox" checked={allOnPageSelected} onChange={(e) => toggleAllOnPage(e.target.checked)} /></th>
            <th>Title</th><th>University</th><th>Country</th><th>Degree</th>
            <th>Funding</th><th>Deadline</th><th>Status</th><th>Conf.</th><th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((s) => (
            <tr key={s.id}>
              <td><input type="checkbox" checked={selected.has(s.id)} onChange={(e) => toggleOne(s.id, e.target.checked)} /></td>
              <td>
                {s.title}
                {s.reviewStatus === 'NEEDS_REVIEW' && <span className="badge yellow" style={{ marginLeft: 6 }}>review</span>}
              </td>
              <td className="muted">{s.university ?? '—'}</td>
              <td>{s.country}</td>
              <td>{s.degreeLevels.map((d: string) => label(DEGREE_LABELS, d)).join(', ') || '—'}</td>
              <td>{label(FUNDING_LABELS, s.funding)}</td>
              <td className="muted">
                {s.deadline ? formatDate(s.deadline) : s.deadlineKind === 'ROLLING' ? 'Rolling' : '—'}
              </td>
              <td><span className={`badge ${statusTone(s.status)}`}>{label(STATUS_LABELS, s.status)}</span></td>
              <td className="mono">{pct(s.confidence)}</td>
              <td>
                <div className="row" style={{ gap: 4 }}>
                  {s.reviewStatus === 'NEEDS_REVIEW' && (
                    <>
                      <button className="btn" onClick={() => review(s.id, 'APPROVE')}>Approve</button>
                      <button className="btn danger" onClick={() => review(s.id, 'REJECT')}>Reject</button>
                    </>
                  )}
                  <button className="btn secondary" onClick={() => recrawl(s.id)}>Recrawl</button>
                </div>
              </td>
            </tr>
          ))}
          {rows.length === 0 && <tr><td colSpan={10} className="muted">No scholarships found.</td></tr>}
        </tbody>
      </table>

      <div className="row" style={{ marginTop: 14 }}>
        <button className="btn secondary" disabled={page <= 1} onClick={() => setPage(page - 1)}>Previous</button>
        <span className="muted">Page {page}</span>
        <button className="btn secondary" disabled={rows.length < 25} onClick={() => setPage(page + 1)}>Next</button>
      </div>
    </div>
  );
}

// ── Universities ────────────────────────────────────────────────────────────

function UniversityTable({ onError, onNotify }: { onError: (s: string) => void; onNotify: (s: string) => void }) {
  const [rows, setRows] = React.useState<any[]>([]);
  const [status, setStatus] = React.useState('');
  const [search, setSearch] = React.useState('');
  const [page, setPage] = React.useState(1);

  const load = React.useCallback(async () => {
    try {
      const qs = new URLSearchParams({ page: String(page), limit: '25' });
      if (status) qs.set('status', status);
      if (search.trim()) qs.set('q', search.trim());
      const r = await apiFetch<any>(`/admin/scholarship/universities?${qs}`);
      setRows(r.items);
    } catch (e: any) { onError(String(e?.message ?? 'Failed to load')); }
  }, [page, status, search, onError]);

  React.useEffect(() => { void load(); }, [load]);

  const toggleCrawl = async (id: string, enabled: boolean) => {
    try {
      await apiFetch(`/admin/scholarship/universities/${id}`, { method: 'PATCH', body: JSON.stringify({ crawlEnabled: enabled }) });
      await load();
    } catch (e: any) { onError(String(e?.message ?? 'Update failed')); }
  };

  const forceCrawl = async (id: string) => {
    try {
      const r = await apiFetch<any>(`/admin/scholarship/universities/${id}/crawl`, { method: 'POST' });
      onNotify(`Found ${r.discovery.hits.length} URLs, ${r.discovery.targetsCreated} new targets`);
      await load();
    } catch (e: any) { onError(String(e?.message ?? 'Crawl failed')); }
  };

  return (
    <div className="card">
      <div className="row" style={{ marginBottom: 14 }}>
        <input className="input" placeholder="Search…" value={search}
          onChange={(e) => { setSearch(e.target.value); setPage(1); }} />
        <select className="input" value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }}>
          <option value="">All</option>
          <option value="ACTIVE">Active</option>
          <option value="UNVERIFIED">Unverified</option>
          <option value="INACTIVE">Inactive</option>
        </select>
      </div>

      <table className="table">
        <thead>
          <tr>
            <th>Name</th><th>Domain</th><th>Country</th><th>Status</th>
            <th>URLs</th><th>Scholarships</th><th>Last crawled</th><th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((u) => (
            <tr key={u.id}>
              <td>
                {u.name}
                {u.consecutiveFailures > 0 && (
                  <span className="badge red" style={{ marginLeft: 6 }}>{u.consecutiveFailures} fails</span>
                )}
              </td>
              <td className="mono">{u.domain}</td>
              <td>{u.country}</td>
              <td>
                <span className={`badge ${u.status === 'ACTIVE' ? 'green' : u.status === 'UNVERIFIED' ? 'yellow' : 'gray'}`}>
                  {u.status}
                </span>
                {u.verificationReason && u.status !== 'ACTIVE' && (
                  <div className="muted" style={{ fontSize: 11 }}>{u.verificationReason}</div>
                )}
              </td>
              <td>{u.scholarshipUrlsFound}</td>
              <td>{u.scholarshipsFound}</td>
              <td className="muted">{u.lastCrawledAt ? formatDate(u.lastCrawledAt) : '—'}</td>
              <td>
                <div className="row" style={{ gap: 4 }}>
                  <button className="btn secondary" onClick={() => toggleCrawl(u.id, !u.crawlEnabled)}>
                    {u.crawlEnabled ? 'Disable' : 'Enable'}
                  </button>
                  <button className="btn" onClick={() => forceCrawl(u.id)}>Crawl</button>
                </div>
              </td>
            </tr>
          ))}
          {rows.length === 0 && <tr><td colSpan={8} className="muted">No universities found. Run seeding first.</td></tr>}
        </tbody>
      </table>

      <div className="row" style={{ marginTop: 14 }}>
        <button className="btn secondary" disabled={page <= 1} onClick={() => setPage(page - 1)}>Previous</button>
        <span className="muted">Page {page}</span>
        <button className="btn secondary" disabled={rows.length < 25} onClick={() => setPage(page + 1)}>Next</button>
      </div>
    </div>
  );
}

// ── Crawl targets ───────────────────────────────────────────────────────────

function TargetTable({ onError, onNotify }: { onError: (s: string) => void; onNotify: (s: string) => void }) {
  const [rows, setRows] = React.useState<any[]>([]);
  const [status, setStatus] = React.useState('');
  const [url, setUrl] = React.useState('');
  const [testing, setTesting] = React.useState(false);

  const load = React.useCallback(async () => {
    try {
      const qs = new URLSearchParams({ limit: '50' });
      if (status) qs.set('status', status);
      const r = await apiFetch<any>(`/admin/scholarship/targets?${qs}`);
      setRows(r.items);
    } catch (e: any) { onError(String(e?.message ?? 'Failed to load')); }
  }, [status, onError]);

  React.useEffect(() => { void load(); }, [load]);

  const testUrl = async (dryRun: boolean) => {
    if (!url.trim()) return;
    setTesting(true);
    try {
      const r = await apiFetch<any>('/admin/scholarship/crawl-url', {
        method: 'POST',
        body: JSON.stringify({ url: url.trim(), dryRun })
      });
      onNotify(`${r.result.status}${r.result.title ? `: ${r.result.title}` : ''}${r.result.reason ? ` — ${r.result.reason}` : ''}`);
      await load();
    } catch (e: any) { onError(String(e?.message ?? 'Test failed')); }
    finally { setTesting(false); }
  };

  return (
    <>
      <div className="card">
        <div className="card-title">Test a single URL</div>
        <div className="row">
          <input className="input" style={{ flex: 1 }} placeholder="https://university.edu/scholarships/…"
            value={url} onChange={(e) => setUrl(e.target.value)} />
          <button className="btn secondary" disabled={testing} onClick={() => testUrl(true)}>Dry run</button>
          <button className="btn" disabled={testing} onClick={() => testUrl(false)}>Crawl & save</button>
        </div>
      </div>

      <div className="card">
        <div className="row" style={{ marginBottom: 14 }}>
          <select className="input" value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">All statuses</option>
            <option value="PENDING">Pending</option>
            <option value="COMPLETED">Completed</option>
            <option value="FAILED">Failed</option>
            <option value="BLOCKED">Blocked</option>
          </select>
        </div>

        <table className="table">
          <thead>
            <tr><th>URL</th><th>Type</th><th>Status</th><th>Pri</th><th>Att</th><th>HTTP</th><th>Error</th></tr>
          </thead>
          <tbody>
            {rows.map((t) => (
              <tr key={t.id}>
                <td className="mono" style={{ maxWidth: 380, overflow: 'hidden', textOverflow: 'ellipsis' }}>{t.url}</td>
                <td>{t.targetType}</td>
                <td>
                  <span className={`badge ${t.status === 'COMPLETED' ? 'green' : t.status === 'FAILED' ? 'red' : t.status === 'BLOCKED' ? 'yellow' : 'gray'}`}>
                    {t.status}
                  </span>
                </td>
                <td>{t.priority}</td>
                <td>{t.attempts}</td>
                <td className="mono">{t.httpStatus ?? '—'}</td>
                <td className="muted" style={{ maxWidth: 220, fontSize: 11 }}>{t.lastError ?? '—'}</td>
              </tr>
            ))}
            {rows.length === 0 && <tr><td colSpan={7} className="muted">Queue is empty.</td></tr>}
          </tbody>
        </table>
      </div>
    </>
  );
}

// ── Runs & changes ──────────────────────────────────────────────────────────

function RunTable({ onError }: { onError: (s: string) => void }) {
  const [rows, setRows] = React.useState<any[]>([]);
  React.useEffect(() => {
    apiFetch<any>('/admin/scholarship/runs?limit=25')
      .then((r) => setRows(r.items))
      .catch((e) => onError(String(e?.message ?? 'Failed to load')));
  }, [onError]);

  return (
    <div className="card">
      <table className="table">
        <thead>
          <tr><th>Started</th><th>Kind</th><th>Trigger</th><th>State</th><th>Duration</th><th>Created</th><th>Updated</th><th>AI</th><th>Failures</th></tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <td className="muted">{formatDate(r.startedAt)}</td>
              <td>{r.kind}</td>
              <td>{r.trigger}{r.dryRun && <span className="badge gray" style={{ marginLeft: 4 }}>dry</span>}</td>
              <td><span className={`badge ${r.state === 'COMPLETED' ? 'green' : r.state === 'RUNNING' ? 'yellow' : 'red'}`}>{r.state}</span></td>
              <td className="mono">{r.durationMs ? `${Math.round(r.durationMs / 1000)}s` : '—'}</td>
              <td>{r.metrics?.scholarshipsCreated ?? 0}</td>
              <td>{r.metrics?.scholarshipsUpdated ?? 0}</td>
              <td>{r.metrics?.aiCalls ?? 0}{(r.metrics?.aiFailures ?? 0) > 0 && <span className="badge red" style={{ marginLeft: 4 }}>{r.metrics.aiFailures}</span>}</td>
              <td>{(r.metrics?.httpFailures ?? 0) + (r.metrics?.blocked ?? 0)}</td>
            </tr>
          ))}
          {rows.length === 0 && <tr><td colSpan={9} className="muted">No runs yet.</td></tr>}
        </tbody>
      </table>
    </div>
  );
}

function ChangeTable({ onError }: { onError: (s: string) => void }) {
  const [rows, setRows] = React.useState<any[]>([]);
  React.useEffect(() => {
    apiFetch<any>('/admin/scholarship/changes?limit=50')
      .then((r) => setRows(r.items))
      .catch((e) => onError(String(e?.message ?? 'Failed to load')));
  }, [onError]);

  const render = (v: unknown) => {
    if (v === null || v === undefined) return '—';
    if (Array.isArray(v)) return v.join(', ') || '—';
    if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(v)) return formatDate(v);
    return String(v);
  };

  return (
    <div className="card">
      <table className="table">
        <thead>
          <tr><th>Detected</th><th>Scholarship</th><th>Field</th><th>From</th><th>To</th><th>Significance</th></tr>
        </thead>
        <tbody>
          {rows.map((c) => (
            <tr key={c.id}>
              <td className="muted">{formatDate(c.detectedAt)}</td>
              <td>{c.scholarshipTitle ?? c.scholarshipId}</td>
              <td className="mono">{c.field}</td>
              <td className="muted">{render(c.oldValue)}</td>
              <td>{render(c.newValue)}</td>
              <td><span className={`badge ${c.significance === 'MAJOR' ? 'yellow' : 'gray'}`}>{c.significance}</span></td>
            </tr>
          ))}
          {rows.length === 0 && <tr><td colSpan={6} className="muted">No changes recorded yet.</td></tr>}
        </tbody>
      </table>
    </div>
  );
}
