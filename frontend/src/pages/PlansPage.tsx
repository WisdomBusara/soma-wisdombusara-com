import React from 'react';
import { apiFetch } from '../api/client';

type Plan = {
  id: string;
  name: string;
  durationMinutes: number;
  amountKobo: number;
  currency: string;
  videoUrl?: string;
  description?: string;
  isActive: boolean;
};

function fmtMoney(kobo: number, currency: string) {
  const code = currency.toUpperCase();
  const symbol = code === 'NGN' ? '₦' : code === 'KES' ? 'KSh ' : code === 'GHS' ? '₵' : '$';
  return `${symbol}${(kobo / 100).toFixed(2)}`;
}

function fmtDuration(mins: number) {
  if (mins < 60) return `${mins}m`;
  if (mins < 60 * 24) return `${Math.floor(mins / 60)}h`;
  return `${Math.floor(mins / (60 * 24))}d`;
}

// Form holds whole currency units (KSh); backend stores minor units (×100)
const DEFAULT_FORM = { name: '', durationMinutes: 1440, amountMajor: 100, currency: 'KES', videoUrl: '', description: '', isActive: true };

export function PlansPage() {
  const [plans, setPlans] = React.useState<Plan[]>([]);
  const [error, setError] = React.useState<string | null>(null);
  const [success, setSuccess] = React.useState<string | null>(null);
  const [form, setForm] = React.useState(DEFAULT_FORM);
  const [editing, setEditing] = React.useState<Plan | null>(null);
  const [editForm, setEditForm] = React.useState<Partial<typeof DEFAULT_FORM>>({});

  const load = React.useCallback(async () => {
    try {
      const data = await apiFetch<Plan[]>('/admin/plans');
      setPlans(data);
    } catch (err: any) {
      setError(String(err?.message ?? 'Failed to load'));
    }
  }, []);

  React.useEffect(() => { void load(); }, [load]);

  const notify = (msg: string) => { setSuccess(msg); setTimeout(() => setSuccess(null), 3000); };

  const create = async () => {
    setError(null);
    try {
      const { amountMajor, ...rest } = form;
      await apiFetch('/admin/plans', { method: 'POST', body: JSON.stringify({ ...rest, amountKobo: Math.round(amountMajor * 100), videoUrl: form.videoUrl || undefined, description: form.description || undefined }) });
      setForm(DEFAULT_FORM);
      notify('Plan created');
      await load();
    } catch (err: any) { setError(String(err?.message ?? 'Failed to create')); }
  };

  const saveEdit = async () => {
    if (!editing) return;
    setError(null);
    try {
      const { amountMajor: editMajor, ...editRest } = editForm;
      await apiFetch(`/admin/plans/${editing.id}`, { method: 'PATCH', body: JSON.stringify({ ...editRest, ...(editMajor !== undefined ? { amountKobo: Math.round(editMajor * 100) } : {}), videoUrl: editForm.videoUrl || undefined }) });
      setEditing(null);
      notify('Plan updated');
      await load();
    } catch (err: any) { setError(String(err?.message ?? 'Failed to update')); }
  };

  const del = async (id: string) => {
    if (!confirm('Delete this plan?')) return;
    setError(null);
    try {
      await apiFetch(`/admin/plans/${id}`, { method: 'DELETE' });
      notify('Plan deleted');
      await load();
    } catch (err: any) { setError(String(err?.message ?? 'Failed to delete')); }
  };

  return (
    <div>
      <div className="page-title">Plans</div>
      {error && <div className="error">{error}</div>}
      {success && <div className="success">{success}</div>}

      <div className="card">
        <div className="card-title">Create New Plan</div>
        <div className="form-grid">
          <div className="form-field">
            <label className="form-label">Name</label>
            <input className="input" placeholder="Week Pass" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </div>
          <div className="form-field">
            <label className="form-label">Duration (minutes)</label>
            <input className="input" type="number" value={form.durationMinutes} onChange={(e) => setForm({ ...form, durationMinutes: Number(e.target.value) })} />
          </div>
          <div className="form-field">
            <label className="form-label">Amount (whole KSh — e.g. 20 for KSh 20)</label>
            <input className="input" type="number" value={form.amountMajor} onChange={(e) => setForm({ ...form, amountMajor: Number(e.target.value) })} />
          </div>
          <div className="form-field">
            <label className="form-label">Currency</label>
            <select className="input" value={form.currency} onChange={(e) => setForm({ ...form, currency: e.target.value })}>
              <option value="NGN">NGN</option>
              <option value="KES">KES</option>
              <option value="GHS">GHS</option>
              <option value="USD">USD</option>
            </select>
          </div>
          <div className="form-field" style={{ gridColumn: '1 / -1' }}>
            <label className="form-label">Video URL — subscribers receive this after payment</label>
            <input className="input" placeholder="https://drive.google.com/..." value={form.videoUrl} onChange={(e) => setForm({ ...form, videoUrl: e.target.value })} />
          </div>
          <div className="form-field" style={{ gridColumn: '1 / -1' }}>
            <label className="form-label">Description (shown to users in bot)</label>
            <input className="input" placeholder="7 day full access" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
          </div>
        </div>
        <div className="row">
          <label className="row" style={{ gap: 6, fontSize: 13 }}>
            <input type="checkbox" className="input" checked={form.isActive} onChange={(e) => setForm({ ...form, isActive: e.target.checked })} />
            Active
          </label>
          <button className="btn" onClick={create}>Create Plan</button>
        </div>
        <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>Enter whole amounts: 20 = KSh 20, 1000 = KSh 1,000.</div>
      </div>

      <table className="table">
        <thead>
          <tr>
            <th>Name</th>
            <th>Duration</th>
            <th>Price</th>
            <th>Video URL</th>
            <th>Status</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {plans.map((p) => (
            <React.Fragment key={p.id}>
              <tr>
                <td>
                  <div style={{ fontWeight: 600 }}>{p.name}</div>
                  {p.description && <div className="muted" style={{ fontSize: 12 }}>{p.description}</div>}
                </td>
                <td className="muted">{fmtDuration(p.durationMinutes)}</td>
                <td>{fmtMoney(p.amountKobo, p.currency)}</td>
                <td>
                  {p.videoUrl
                    ? <a href={p.videoUrl} target="_blank" rel="noopener noreferrer" className="mono" style={{ fontSize: 11 }}>
                        {p.videoUrl.length > 40 ? p.videoUrl.slice(0, 40) + '…' : p.videoUrl}
                      </a>
                    : <span className="muted" style={{ fontSize: 12 }}>not set</span>}
                </td>
                <td>
                  <span className={`badge ${p.isActive ? 'green' : 'gray'}`}>{p.isActive ? 'Active' : 'Off'}</span>
                </td>
                <td>
                  <div className="row">
                    <button className="btn secondary" style={{ fontSize: 12, padding: '4px 10px' }} onClick={() => { setEditing(p); setEditForm({ name: p.name, durationMinutes: p.durationMinutes, amountMajor: p.amountKobo / 100, currency: p.currency, videoUrl: p.videoUrl ?? '', description: p.description ?? '', isActive: p.isActive }); }}>Edit</button>
                    <button className="btn danger" style={{ fontSize: 12, padding: '4px 10px' }} onClick={() => del(p.id)}>Del</button>
                  </div>
                </td>
              </tr>
              {editing?.id === p.id && (
                <tr>
                  <td colSpan={6}>
                    <div className="card" style={{ margin: 0 }}>
                      <div className="form-grid">
                        <div className="form-field">
                          <label className="form-label">Name</label>
                          <input className="input" value={editForm.name ?? ''} onChange={(e) => setEditForm({ ...editForm, name: e.target.value })} />
                        </div>
                        <div className="form-field">
                          <label className="form-label">Duration (min)</label>
                          <input className="input" type="number" value={editForm.durationMinutes ?? 0} onChange={(e) => setEditForm({ ...editForm, durationMinutes: Number(e.target.value) })} />
                        </div>
                        <div className="form-field">
                          <label className="form-label">Amount (whole KSh)</label>
                          <input className="input" type="number" value={editForm.amountMajor ?? 0} onChange={(e) => setEditForm({ ...editForm, amountMajor: Number(e.target.value) })} />
                        </div>
                        <div className="form-field">
                          <label className="form-label">Currency</label>
                          <select className="input" value={editForm.currency ?? 'NGN'} onChange={(e) => setEditForm({ ...editForm, currency: e.target.value })}>
                            <option value="NGN">NGN</option>
                            <option value="KES">KES</option>
                            <option value="GHS">GHS</option>
                            <option value="USD">USD</option>
                          </select>
                        </div>
                        <div className="form-field" style={{ gridColumn: '1 / -1' }}>
                          <label className="form-label">Video URL</label>
                          <input className="input" value={editForm.videoUrl ?? ''} onChange={(e) => setEditForm({ ...editForm, videoUrl: e.target.value })} />
                        </div>
                        <div className="form-field" style={{ gridColumn: '1 / -1' }}>
                          <label className="form-label">Description</label>
                          <input className="input" value={editForm.description ?? ''} onChange={(e) => setEditForm({ ...editForm, description: e.target.value })} />
                        </div>
                      </div>
                      <div className="row">
                        <label className="row" style={{ gap: 6, fontSize: 13 }}>
                          <input type="checkbox" className="input" checked={editForm.isActive ?? true} onChange={(e) => setEditForm({ ...editForm, isActive: e.target.checked })} />
                          Active
                        </label>
                        <button className="btn" onClick={saveEdit}>Save</button>
                        <button className="btn secondary" onClick={() => setEditing(null)}>Cancel</button>
                      </div>
                    </div>
                  </td>
                </tr>
              )}
            </React.Fragment>
          ))}
          {plans.length === 0 && (
            <tr><td colSpan={6} className="muted" style={{ textAlign: 'center', padding: 32 }}>No plans yet</td></tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
