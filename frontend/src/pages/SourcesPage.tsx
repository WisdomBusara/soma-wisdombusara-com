import React from 'react';
import { apiFetch } from '../api/client';

type Source = {
  id: string;
  name: string;
  industry: string;
  vertical?: 'jobs' | 'tenders';
  kind: 'html' | 'oracle' | 'workday';
  homepage: string;
  url?: string;
  jobSelector?: string;
  dynamic?: boolean;
  tenant?: string;
  siteNumber?: string;
  locationId?: number;
  domain?: string;
  isActive: boolean;
};

const DEFAULT_FORM = {
  name: '', industry: 'banking', vertical: 'jobs' as 'jobs' | 'tenders', kind: 'html' as 'html' | 'oracle' | 'workday',
  homepage: '', url: '', tenant: '', siteNumber: '', locationId: '', isActive: true
};

export function SourcesPage() {
  const [sources, setSources] = React.useState<Source[]>([]);
  const [error, setError] = React.useState<string | null>(null);
  const [success, setSuccess] = React.useState<string | null>(null);
  const [form, setForm] = React.useState(DEFAULT_FORM);
  const [editing, setEditing] = React.useState<Source | null>(null);
  const [editUrl, setEditUrl] = React.useState('');
  const [editIndustry, setEditIndustry] = React.useState('');
  const [industryFilter, setIndustryFilter] = React.useState<string>('all');
  const [vertFilter, setVertFilter] = React.useState<'jobs' | 'tenders'>('jobs');
  const [search, setSearch] = React.useState('');
  const [page, setPage] = React.useState(1);
  const [testing, setTesting] = React.useState<string | null>(null);
  const PAGE_SIZE = 15;

  const load = React.useCallback(async () => {
    try {
      const data = await apiFetch<Source[]>('/admin/sources');
      setSources(data);
    } catch (err: any) {
      setError(String(err?.message ?? 'Failed to load'));
    }
  }, []);

  React.useEffect(() => { void load(); }, [load]);

  const notify = (msg: string) => { setSuccess(msg); setTimeout(() => setSuccess(null), 3000); };

  const industries = Array.from(new Set(sources.map((s) => s.industry))).sort();
  const q = search.trim().toLowerCase();
  const filtered = sources
    .filter((s) => (s.vertical ?? 'jobs') === vertFilter)
    .filter((s) => industryFilter === 'all' || s.industry === industryFilter)
    .filter((s) => !q || s.name.toLowerCase().includes(q) || (s.url ?? '').toLowerCase().includes(q) || s.industry.includes(q));
  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const visible = filtered.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);

  const testSource = async (s: Source) => {
    setError(null);
    setTesting(s.id);
    try {
      const r = await apiFetch<{ jobs: number; rejected: number; error: string | null; sentTo: string | null }>(
        `/admin/sources/${s.id}/test`, { method: 'POST' }
      );
      const noun = (s.vertical ?? 'jobs') === 'tenders' ? 'tenders' : 'jobs';
      if (r.error) notify(`❌ ${s.name}: FAILED — ${r.error}. Details sent to ${r.sentTo ?? 'WhatsApp'}`);
      else if (r.jobs === 0) notify(`⚠️ ${s.name}: 0 ${noun} (${r.rejected} links rejected). Details sent to ${r.sentTo ?? 'WhatsApp'}`);
      else notify(`✅ ${s.name}: ${r.jobs} ${noun} found. Details sent to ${r.sentTo ?? 'WhatsApp'}`);
    } catch (err: any) { setError(String(err?.message ?? 'Test failed')); }
    finally { setTesting(null); }
  };

  const create = async () => {
    setError(null);
    try {
      const body: Record<string, unknown> = {
        name: form.name, industry: form.industry, kind: form.kind,
        homepage: form.homepage, isActive: form.isActive
      };
      if (form.kind === 'html' || form.kind === 'workday') body.url = form.url;
      else {
        body.tenant = form.tenant;
        body.siteNumber = form.siteNumber;
        if (form.locationId) body.locationId = Number(form.locationId);
      }
      await apiFetch('/admin/sources', { method: 'POST', body: JSON.stringify({ ...body, vertical: form.vertical }) });
      setForm(DEFAULT_FORM);
      notify('Source added');
      await load();
    } catch (err: any) { setError(String(err?.message ?? 'Failed to create')); }
  };

  const saveEdit = async () => {
    if (!editing) return;
    setError(null);
    try {
      await apiFetch(`/admin/sources/${editing.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ url: editUrl || undefined, industry: editIndustry || undefined })
      });
      setEditing(null);
      notify('Source updated');
      await load();
    } catch (err: any) { setError(String(err?.message ?? 'Failed to update')); }
  };

  const toggle = async (s: Source) => {
    setError(null);
    try {
      await apiFetch(`/admin/sources/${s.id}`, { method: 'PATCH', body: JSON.stringify({ isActive: !s.isActive }) });
      await load();
    } catch (err: any) { setError(String(err?.message ?? 'Failed to update')); }
  };

  const del = async (id: string) => {
    if (!confirm('Delete this source? The scraper will stop monitoring it.')) return;
    setError(null);
    try {
      await apiFetch(`/admin/sources/${id}`, { method: 'DELETE' });
      notify('Source deleted');
      await load();
    } catch (err: any) { setError(String(err?.message ?? 'Failed to delete')); }
  };

  return (
    <div>
      <div className="page-title">Scrape Sources</div>
      <div className="muted" style={{ marginTop: -8, marginBottom: 14, fontSize: 13 }}>
        Pages the scraper monitors nightly. Switch between the Jobs and Tenders verticals below; add a new industry by typing its name on a new source.
      </div>
      <div className="row" style={{ gap: 8, marginBottom: 16 }}>
        <button className={`btn ${vertFilter === 'jobs' ? '' : 'secondary'}`} onClick={() => { setVertFilter('jobs'); setIndustryFilter('all'); setPage(1); }}>
          💼 Jobs ({sources.filter((s) => (s.vertical ?? 'jobs') === 'jobs').length})
        </button>
        <button className={`btn ${vertFilter === 'tenders' ? '' : 'secondary'}`} onClick={() => { setVertFilter('tenders'); setIndustryFilter('all'); setPage(1); }}>
          📋 Tenders ({sources.filter((s) => s.vertical === 'tenders').length})
        </button>
      </div>
      {error && <div className="error">{error}</div>}
      {success && <div className="success">{success}</div>}

      <div className="card">
        <div className="card-title">Add Source</div>
        <div className="form-grid">
          <div className="form-field">
            <label className="form-label">Company name</label>
            <input className="input" placeholder="Safaricom" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </div>
          <div className="form-field">
            <label className="form-label">Industry</label>
            <input className="input" placeholder="telecom" list="industry-list" value={form.industry} onChange={(e) => setForm({ ...form, industry: e.target.value })} />
            <datalist id="industry-list">
              {industries.map((i) => <option key={i} value={i} />)}
            </datalist>
          </div>
          <div className="form-field">
            <label className="form-label">Vertical</label>
            <select className="input" value={form.vertical} onChange={(e) => setForm({ ...form, vertical: e.target.value as 'jobs' | 'tenders' })}>
              <option value="jobs">💼 Jobs</option>
              <option value="tenders">📋 Tenders</option>
            </select>
          </div>
          <div className="form-field">
            <label className="form-label">Type</label>
            <select className="input" value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value as 'html' | 'oracle' | 'workday' })}>
              <option value="html">HTML page</option>
              <option value="oracle">Oracle HCM (ATS API)</option>
              <option value="workday">Workday (paste careersite URL)</option>
            </select>
          </div>
          <div className="form-field">
            <label className="form-label">Homepage</label>
            <input className="input" placeholder="https://safaricom.co.ke" value={form.homepage} onChange={(e) => setForm({ ...form, homepage: e.target.value })} />
          </div>
          {form.kind !== 'oracle' ? (
            <div className="form-field" style={{ gridColumn: '1 / -1' }}>
              <label className="form-label">{form.kind === 'workday' ? 'Workday careersite URL (with ?locationCountry=… if filtered)' : 'Careers page URL (this is what gets scraped)'}</label>
              <input className="input" placeholder={form.kind === 'workday' ? 'https://absa.wd3.myworkdayjobs.com/ABSAcareersite?locationCountry=…' : 'https://safaricom.co.ke/careers/'} value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} />
            </div>
          ) : (
            <>
              <div className="form-field">
                <label className="form-label">Oracle tenant</label>
                <input className="input" placeholder="eoin" value={form.tenant} onChange={(e) => setForm({ ...form, tenant: e.target.value })} />
              </div>
              <div className="form-field">
                <label className="form-label">Site number</label>
                <input className="input" placeholder="CX_3001" value={form.siteNumber} onChange={(e) => setForm({ ...form, siteNumber: e.target.value })} />
              </div>
              <div className="form-field">
                <label className="form-label">Location ID (optional)</label>
                <input className="input" placeholder="300000000385420" value={form.locationId} onChange={(e) => setForm({ ...form, locationId: e.target.value })} />
              </div>
            </>
          )}
        </div>
        <div className="row">
          <label className="row" style={{ gap: 6, fontSize: 13 }}>
            <input type="checkbox" className="input" checked={form.isActive} onChange={(e) => setForm({ ...form, isActive: e.target.checked })} />
            Active
          </label>
          <button className="btn" onClick={create}>Add Source</button>
        </div>
      </div>

      <div className="row" style={{ marginBottom: 12, gap: 8, flexWrap: 'wrap' }}>
        <input
          className="input"
          style={{ maxWidth: 260 }}
          placeholder="🔍 Search name, URL, industry…"
          value={search}
          onChange={(e) => { setSearch(e.target.value); setPage(1); }}
        />
        <button className={`btn ${industryFilter === 'all' ? '' : 'secondary'}`} style={{ fontSize: 12, padding: '4px 12px' }} onClick={() => { setIndustryFilter('all'); setPage(1); }}>
          All ({sources.length})
        </button>
        {industries.map((i) => (
          <button key={i} className={`btn ${industryFilter === i ? '' : 'secondary'}`} style={{ fontSize: 12, padding: '4px 12px' }} onClick={() => { setIndustryFilter(i); setPage(1); }}>
            {i} ({sources.filter((s) => s.industry === i).length})
          </button>
        ))}
      </div>

      <table className="table">
        <thead>
          <tr>
            <th>Name</th>
            <th>Industry</th>
            <th>Scrape target</th>
            <th>Status</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {visible.map((s) => (
            <React.Fragment key={s.id}>
              <tr>
                <td>
                  <div style={{ fontWeight: 600 }}>{s.name}</div>
                  <div className="muted" style={{ fontSize: 11 }}>{s.kind === 'oracle' ? 'Oracle HCM' : s.kind === 'workday' ? 'Workday' : s.dynamic ? 'HTML (dynamic)' : 'HTML'}</div>
                </td>
                <td><span className="badge gray">{s.industry}</span></td>
                <td>
                  {s.kind !== 'oracle'
                    ? <a href={s.url} target="_blank" rel="noopener noreferrer" className="mono" style={{ fontSize: 11 }}>
                        {(s.url ?? '').length > 48 ? (s.url ?? '').slice(0, 48) + '…' : s.url}
                      </a>
                    : <span className="mono" style={{ fontSize: 11 }}>{s.tenant} / {s.siteNumber}</span>}
                </td>
                <td>
                  <span className={`badge ${s.isActive ? 'green' : 'gray'}`}>{s.isActive ? 'Active' : 'Off'}</span>
                </td>
                <td>
                  <div className="row">
                    <button
                      className="btn"
                      style={{ fontSize: 12, padding: '4px 10px' }}
                      disabled={testing !== null}
                      onClick={() => testSource(s)}
                    >
                      {testing === s.id ? '⏳ Testing…' : '🧪 Test'}
                    </button>
                    <button className="btn secondary" style={{ fontSize: 12, padding: '4px 10px' }} onClick={() => toggle(s)}>{s.isActive ? 'Disable' : 'Enable'}</button>
                    {s.kind !== 'oracle' && (
                      <button className="btn secondary" style={{ fontSize: 12, padding: '4px 10px' }} onClick={() => { setEditing(s); setEditUrl(s.url ?? ''); setEditIndustry(s.industry); }}>Edit</button>
                    )}
                    <button className="btn danger" style={{ fontSize: 12, padding: '4px 10px' }} onClick={() => del(s.id)}>Del</button>
                  </div>
                </td>
              </tr>
              {editing?.id === s.id && (
                <tr>
                  <td colSpan={5}>
                    <div className="card" style={{ margin: 0 }}>
                      <div className="form-grid">
                        <div className="form-field" style={{ gridColumn: '1 / -1' }}>
                          <label className="form-label">Careers page URL</label>
                          <input className="input" value={editUrl} onChange={(e) => setEditUrl(e.target.value)} />
                        </div>
                        <div className="form-field">
                          <label className="form-label">Industry</label>
                          <input className="input" list="industry-list" value={editIndustry} onChange={(e) => setEditIndustry(e.target.value)} />
                        </div>
                      </div>
                      <div className="row">
                        <button className="btn" onClick={saveEdit}>Save</button>
                        <button className="btn secondary" onClick={() => setEditing(null)}>Cancel</button>
                      </div>
                    </div>
                  </td>
                </tr>
              )}
            </React.Fragment>
          ))}
          {visible.length === 0 && (
            <tr><td colSpan={5} className="muted" style={{ textAlign: 'center', padding: 32 }}>{q ? `No sources match "${search}"` : 'No sources'}</td></tr>
          )}
        </tbody>
      </table>

      {totalPages > 1 && (
        <div className="row" style={{ justifyContent: 'center', gap: 8, marginTop: 16 }}>
          <button className="btn secondary" style={{ fontSize: 12, padding: '4px 12px' }} disabled={safePage <= 1} onClick={() => setPage(safePage - 1)}>← Prev</button>
          <span className="muted" style={{ fontSize: 13, alignSelf: 'center' }}>
            Page {safePage} of {totalPages} · {filtered.length} sources
          </span>
          <button className="btn secondary" style={{ fontSize: 12, padding: '4px 12px' }} disabled={safePage >= totalPages} onClick={() => setPage(safePage + 1)}>Next →</button>
        </div>
      )}
    </div>
  );
}
