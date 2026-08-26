import React from 'react';
import { apiFetch } from '../api/client';

type PremiumUser = {
  id: string;
  phone: string;
  name?: string;
  email?: string;
  notes?: string;
  isActive: boolean;
  expiresAt?: string | null;
  createdAt?: string;
};

type LlmStatus = {
  enabled: boolean;
  model: string;
  categories: string[];
  jobsTotal: number;
  jobsCategorized: number;
  today: Array<{ category: string; count: number }>;
  run?: {
    state: string;
    done: number;
    total: number;
    current: string | null;
    startedAt: string | null;
    finishedAt: string | null;
    error: string | null;
  };
};

const DEFAULT_FORM = { phone: '', name: '', email: '', notes: '' };

export function PremiumPage() {
  const [users, setUsers] = React.useState<PremiumUser[]>([]);
  const [llm, setLlm] = React.useState<LlmStatus | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [success, setSuccess] = React.useState<string | null>(null);
  const [form, setForm] = React.useState(DEFAULT_FORM);
  const [editing, setEditing] = React.useState<PremiumUser | null>(null);
  const [editForm, setEditForm] = React.useState(DEFAULT_FORM);

  const load = React.useCallback(async () => {
    try {
      const [u, s] = await Promise.all([
        apiFetch<PremiumUser[]>('/admin/premium-users'),
        apiFetch<LlmStatus>('/admin/llm/status')
      ]);
      setUsers(u);
      setLlm(s);
    } catch (err: any) { setError(String(err?.message ?? 'Failed to load')); }
  }, []);

  React.useEffect(() => { void load(); }, [load]);

  // live progress while a categorization run is active
  React.useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let stopped = false;
    const tick = async () => {
      let active = false;
      try {
        const s = await apiFetch<LlmStatus>('/admin/llm/status');
        if (stopped) return;
        setLlm(s);
        active = s.run?.state === 'scraping';
      } catch { /* keep last */ }
      if (!stopped) timer = setTimeout(tick, active ? 4000 : 30000);
    };
    void tick();
    return () => { stopped = true; if (timer) clearTimeout(timer); };
  }, []);

  const notify = (msg: string) => { setSuccess(msg); setTimeout(() => setSuccess(null), 3500); };

  const create = async () => {
    setError(null);
    try {
      await apiFetch('/admin/premium-users', {
        method: 'POST',
        body: JSON.stringify({ phone: form.phone, name: form.name || undefined, email: form.email || undefined, notes: form.notes || undefined })
      });
      setForm(DEFAULT_FORM);
      notify('Premium user added');
      await load();
    } catch (err: any) { setError(String(err?.message ?? 'Failed to add')); }
  };

  const saveEdit = async () => {
    if (!editing) return;
    setError(null);
    try {
      await apiFetch(`/admin/premium-users/${editing.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ phone: editForm.phone, name: editForm.name || undefined, email: editForm.email || undefined, notes: editForm.notes || undefined })
      });
      setEditing(null);
      notify('Updated');
      await load();
    } catch (err: any) { setError(String(err?.message ?? 'Failed to update')); }
  };

  const toggle = async (u: PremiumUser) => {
    setError(null);
    try {
      await apiFetch(`/admin/premium-users/${u.id}`, { method: 'PATCH', body: JSON.stringify({ isActive: !u.isActive }) });
      await load();
    } catch (err: any) { setError(String(err?.message ?? 'Failed')); }
  };

  const del = async (id: string) => {
    if (!confirm('Delete this premium user? They will fall back to the standard menu.')) return;
    setError(null);
    try {
      await apiFetch(`/admin/premium-users/${id}`, { method: 'DELETE' });
      notify('Deleted');
      await load();
    } catch (err: any) { setError(String(err?.message ?? 'Failed to delete')); }
  };

  const runCategorize = async () => {
    setError(null);
    try {
      const r = await apiFetch<{ message: string }>('/admin/llm/categorize', { method: 'POST' });
      notify(r.message);
    } catch (err: any) { setError(String(err?.message ?? 'Failed to start')); }
  };

  return (
    <div>
      <div className="page-title">Premium</div>
      <div className="muted" style={{ marginTop: -8, marginBottom: 16, fontSize: 13 }}>
        Premium members text <b>hi</b> to the bot and receive LLM-categorized jobs by field (IT, Finance, HR…). Manage members and the categorizer here.
      </div>
      {error && <div className="error">{error}</div>}
      {success && <div className="success">{success}</div>}

      {/* LLM status */}
      <div className="card">
        <div className="card-title">LLM Categorizer</div>
        {llm ? (
          <>
            <div className="row" style={{ gap: 18, flexWrap: 'wrap', marginBottom: 10 }}>
              <span className={`badge ${llm.enabled ? 'green' : 'gray'}`}>{llm.enabled ? 'Enabled' : 'Disabled — set HF_TOKEN'}</span>
              <span className="mono" style={{ fontSize: 12 }}>{llm.model}</span>
              <span className="muted" style={{ fontSize: 13 }}>{llm.jobsCategorized}/{llm.jobsTotal} jobs categorized</span>
              <button className="btn secondary" style={{ fontSize: 12, padding: '4px 12px' }} onClick={runCategorize} disabled={!llm.enabled}>
                ▶ Categorize now
              </button>
            </div>
            {!llm.enabled && (
              <div className="muted" style={{ fontSize: 12.5, marginBottom: 8 }}>
                Get a <b>Read</b> token from huggingface.co → Settings → Access Tokens, then run:{' '}
                <span className="mono">fly secrets set HF_TOKEN=hf_xxx -a vee-backend</span>
              </div>
            )}
            {llm.run?.state === 'scraping' && (
              <div style={{ marginBottom: 10, padding: '10px 12px', border: '1px solid var(--border, #2a2a2a)', borderRadius: 8, fontSize: 13 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
                  <span>🧠 Categorizing — <b>{llm.run.done}/{llm.run.total}</b>{llm.run.current ? <span className="muted"> · {llm.run.current}</span> : null}</span>
                </div>
                <div style={{ height: 6, background: 'var(--border, #2a2a2a)', borderRadius: 3, overflow: 'hidden' }}>
                  <div style={{ height: '100%', width: `${llm.run.total ? Math.round((llm.run.done / llm.run.total) * 100) : 3}%`, background: '#22c55e', transition: 'width 0.5s' }} />
                </div>
              </div>
            )}
            {llm.run?.state === 'failed' && (
              <div style={{ marginBottom: 10, fontSize: 13 }}>❌ Last categorization failed: <span className="mono">{llm.run.error}</span></div>
            )}
            {llm.run?.state === 'done' && llm.run.finishedAt && (
              <div style={{ marginBottom: 10, fontSize: 13 }}>✅ Last run finished {new Date(llm.run.finishedAt).toLocaleTimeString()} — {llm.run.done}/{llm.run.total} categorized</div>
            )}
            {llm.today.length > 0 && (
              <div style={{ fontSize: 13 }}>
                <span className="muted">Last 24h: </span>
                {llm.today.map((c) => `${c.category} (${c.count})`).join(' · ')}
              </div>
            )}
          </>
        ) : <span className="muted">Loading…</span>}
      </div>

      {/* Add member */}
      <div className="card">
        <div className="card-title">Add Premium Member</div>
        <div className="form-grid">
          <div className="form-field">
            <label className="form-label">WhatsApp number (or LID for @lid contacts)</label>
            <input className="input" placeholder="254712345678" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
          </div>
          <div className="form-field">
            <label className="form-label">Name (used in bot greeting)</label>
            <input className="input" placeholder="Jane" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </div>
          <div className="form-field">
            <label className="form-label">Email (optional)</label>
            <input className="input" placeholder="jane@example.com" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
          </div>
          <div className="form-field">
            <label className="form-label">Notes (optional)</label>
            <input className="input" placeholder="paid via M-Pesa 5/7" value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
          </div>
        </div>
        <div className="row">
          <button className="btn" onClick={create}>Add Member</button>
        </div>
      </div>

      {/* Members table */}
      <table className="table">
        <thead>
          <tr><th>Member</th><th>Phone</th><th>Notes</th><th>Status</th><th></th></tr>
        </thead>
        <tbody>
          {users.map((u) => (
            <React.Fragment key={u.id}>
              <tr>
                <td>
                  <div style={{ fontWeight: 600 }}>{u.name || '—'}</div>
                  {u.email && <div className="muted" style={{ fontSize: 12 }}>{u.email}</div>}
                </td>
                <td className="mono" style={{ fontSize: 12 }}>{u.phone}</td>
                <td className="muted" style={{ fontSize: 12 }}>{u.notes || ''}</td>
                <td><span className={`badge ${u.isActive ? 'green' : 'gray'}`}>{u.isActive ? 'Active' : 'Disabled'}</span></td>
                <td>
                  <div className="row">
                    <button className="btn secondary" style={{ fontSize: 12, padding: '4px 10px' }} onClick={() => toggle(u)}>{u.isActive ? 'Disable' : 'Enable'}</button>
                    <button className="btn secondary" style={{ fontSize: 12, padding: '4px 10px' }} onClick={() => { setEditing(u); setEditForm({ phone: u.phone, name: u.name ?? '', email: u.email ?? '', notes: u.notes ?? '' }); }}>Edit</button>
                    <button className="btn danger" style={{ fontSize: 12, padding: '4px 10px' }} onClick={() => del(u.id)}>Del</button>
                  </div>
                </td>
              </tr>
              {editing?.id === u.id && (
                <tr>
                  <td colSpan={5}>
                    <div className="card" style={{ margin: 0 }}>
                      <div className="form-grid">
                        <div className="form-field"><label className="form-label">Phone</label>
                          <input className="input" value={editForm.phone} onChange={(e) => setEditForm({ ...editForm, phone: e.target.value })} /></div>
                        <div className="form-field"><label className="form-label">Name</label>
                          <input className="input" value={editForm.name} onChange={(e) => setEditForm({ ...editForm, name: e.target.value })} /></div>
                        <div className="form-field"><label className="form-label">Email</label>
                          <input className="input" value={editForm.email} onChange={(e) => setEditForm({ ...editForm, email: e.target.value })} /></div>
                        <div className="form-field"><label className="form-label">Notes</label>
                          <input className="input" value={editForm.notes} onChange={(e) => setEditForm({ ...editForm, notes: e.target.value })} /></div>
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
          {users.length === 0 && (
            <tr><td colSpan={5} className="muted" style={{ textAlign: 'center', padding: 32 }}>No premium members yet</td></tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
