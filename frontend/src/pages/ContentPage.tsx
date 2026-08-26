import React from 'react';
import { apiFetch } from '../api/client';

type Content = { id: string; botId: string; title: string; body: string; isActive: boolean; createdAt: string };
type Bot = { id: string; name: string };

export function ContentPage() {
  const [items, setItems] = React.useState<Content[]>([]);
  const [bots, setBots] = React.useState<Bot[]>([]);
  const [error, setError] = React.useState<string | null>(null);
  const [success, setSuccess] = React.useState<string | null>(null);
  const [botId, setBotId] = React.useState('');
  const [title, setTitle] = React.useState('');
  const [body, setBody] = React.useState('');

  const load = React.useCallback(async () => {
    setError(null);
    try {
      const [contentData, botsData] = await Promise.all([
        apiFetch<Content[]>('/admin/content'),
        apiFetch<Bot[]>('/admin/bots')
      ]);
      setItems(contentData);
      setBots(botsData);
      if (botsData.length > 0 && !botId) setBotId(botsData[0].id);
    } catch (err: any) { setError(String(err?.message ?? 'Failed')); }
  }, [botId]);

  React.useEffect(() => { void load(); }, [load]);

  const notify = (msg: string) => { setSuccess(msg); setTimeout(() => setSuccess(null), 3000); };

  const broadcast = async () => {
    if (!botId || !title || !body) { setError('Fill in all fields'); return; }
    setError(null);
    try {
      await apiFetch('/admin/content', { method: 'POST', body: JSON.stringify({ botId, title, body, isActive: true }) });
      setTitle(''); setBody('');
      notify('Broadcasted to channel');
      await load();
    } catch (err: any) { setError(String(err?.message ?? 'Failed')); }
  };

  const del = async (id: string) => {
    if (!confirm('Delete?')) return;
    try {
      await apiFetch(`/admin/content/${id}`, { method: 'DELETE' });
      notify('Deleted');
      await load();
    } catch (err: any) { setError(String(err?.message ?? 'Failed')); }
  };

  const botName = (id: string) => bots.find((b) => b.id === id)?.name ?? id.slice(-6);

  return (
    <div>
      <div className="page-title">Broadcast</div>
      {error && <div className="error">{error}</div>}
      {success && <div className="success">{success}</div>}

      <div className="card">
        <div className="card-title">Send Message to Channel</div>
        <div className="form-field" style={{ marginBottom: 10 }}>
          <label className="form-label">Bot / Channel</label>
          <select className="input" value={botId} onChange={(e) => setBotId(e.target.value)} style={{ maxWidth: 300 }}>
            <option value="">Select bot…</option>
            {bots.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
          </select>
        </div>
        <div className="form-field" style={{ marginBottom: 10 }}>
          <label className="form-label">Title</label>
          <input className="input" placeholder="New drop 🎬" value={title} onChange={(e) => setTitle(e.target.value)} />
        </div>
        <div className="form-field" style={{ marginBottom: 12 }}>
          <label className="form-label">Body</label>
          <textarea className="input" placeholder="Message text..." value={body} onChange={(e) => setBody(e.target.value)} rows={5} />
        </div>
        <button className="btn" onClick={broadcast}>Broadcast to Channel</button>
        <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>This sends to the protected channel immediately. All members will see it.</div>
      </div>

      <div className="card-title" style={{ marginBottom: 12 }}>History</div>
      <table className="table">
        <thead>
          <tr><th>Title</th><th>Bot</th><th>Date</th><th></th></tr>
        </thead>
        <tbody>
          {items.map((c) => (
            <tr key={c.id}>
              <td>
                <div style={{ fontWeight: 600 }}>{c.title}</div>
                <div className="muted" style={{ fontSize: 12 }}>{c.body.slice(0, 80)}{c.body.length > 80 ? '…' : ''}</div>
              </td>
              <td className="muted">{botName(c.botId)}</td>
              <td className="muted" style={{ fontSize: 12 }}>{new Date(c.createdAt).toLocaleDateString()}</td>
              <td><button className="btn danger" style={{ fontSize: 12, padding: '4px 10px' }} onClick={() => del(c.id)}>Del</button></td>
            </tr>
          ))}
          {items.length === 0 && <tr><td colSpan={4} className="muted" style={{ textAlign: 'center', padding: 32 }}>No broadcasts yet</td></tr>}
        </tbody>
      </table>
    </div>
  );
}
