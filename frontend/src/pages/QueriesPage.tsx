import React from 'react';
import { apiFetch } from '../api/client';

type Query = { id: string; botId: string; telegramUserId: number; text: string; status: string; createdAt: string };
type Bot = { id: string; name: string };

export function QueriesPage() {
  const [items, setItems] = React.useState<Query[]>([]);
  const [bots, setBots] = React.useState<Bot[]>([]);
  const [filterStatus, setFilterStatus] = React.useState('open');
  const [error, setError] = React.useState<string | null>(null);
  const [success, setSuccess] = React.useState<string | null>(null);

  const load = React.useCallback(async () => {
    setError(null);
    try {
      const params = filterStatus ? `?status=${filterStatus}` : '';
      const [itemsData, botsData] = await Promise.all([
        apiFetch<Query[]>(`/admin/queries${params}`),
        apiFetch<Bot[]>('/admin/bots')
      ]);
      setItems(itemsData);
      setBots(botsData);
    } catch (err: any) { setError(String(err?.message ?? 'Failed')); }
  }, [filterStatus]);

  React.useEffect(() => { void load(); }, [load]);

  const notify = (msg: string) => { setSuccess(msg); setTimeout(() => setSuccess(null), 3000); };

  const close = async (id: string) => {
    setError(null);
    try {
      await apiFetch(`/admin/queries/${id}`, { method: 'PATCH', body: JSON.stringify({ status: 'closed' }) });
      notify('Marked closed');
      await load();
    } catch (err: any) { setError(String(err?.message ?? 'Failed')); }
  };

  const botName = (id: string) => bots.find((b) => b.id === id)?.name ?? id.slice(-6);

  return (
    <div>
      <div className="page-title">Support Queries</div>
      {error && <div className="error">{error}</div>}
      {success && <div className="success">{success}</div>}

      <div className="row" style={{ marginBottom: 16 }}>
        <select className="input" value={filterStatus} onChange={(e) => setFilterStatus(e.target.value)} style={{ width: 160 }}>
          <option value="">All</option>
          <option value="open">Open</option>
          <option value="closed">Closed</option>
        </select>
        <button className="btn secondary" onClick={load}>Refresh</button>
      </div>

      <table className="table">
        <thead>
          <tr><th>User</th><th>Bot</th><th>Message</th><th>Date</th><th>Status</th><th></th></tr>
        </thead>
        <tbody>
          {items.map((q) => (
            <tr key={q.id}>
              <td className="mono">{q.telegramUserId}</td>
              <td className="muted">{botName(q.botId)}</td>
              <td>{q.text}</td>
              <td className="muted" style={{ fontSize: 12 }}>{new Date(q.createdAt).toLocaleDateString()}</td>
              <td><span className={`badge ${q.status === 'open' ? 'yellow' : 'gray'}`}>{q.status}</span></td>
              <td>
                {q.status === 'open' && (
                  <button className="btn secondary" style={{ fontSize: 12, padding: '4px 10px' }} onClick={() => close(q.id)}>Close</button>
                )}
              </td>
            </tr>
          ))}
          {items.length === 0 && <tr><td colSpan={6} className="muted" style={{ textAlign: 'center', padding: 32 }}>No queries</td></tr>}
        </tbody>
      </table>
    </div>
  );
}
