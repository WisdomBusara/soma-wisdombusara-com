import React from 'react';
import { apiFetch } from '../api/client';

type Subscription = {
  id: string;
  botId: string;
  planId: string;
  telegramUserId: number;
  startsAt: string;
  endsAt: string;
  status: string;
  revokedAt?: string;
  paystackReference?: string;
  createdAt: string;
};

type Bot = { id: string; name: string };
type Plan = { id: string; name: string };

export function SubscriptionsPage() {
  const [subs, setSubs] = React.useState<Subscription[]>([]);
  const [bots, setBots] = React.useState<Bot[]>([]);
  const [plans, setPlans] = React.useState<Plan[]>([]);
  const [filterStatus, setFilterStatus] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);
  const [success, setSuccess] = React.useState<string | null>(null);

  const [grantBotId, setGrantBotId] = React.useState('');
  const [grantPlanId, setGrantPlanId] = React.useState('');
  const [grantUserId, setGrantUserId] = React.useState('');
  const [grantDuration, setGrantDuration] = React.useState('');

  const load = React.useCallback(async () => {
    setError(null);
    try {
      const params = filterStatus ? `?status=${filterStatus}` : '';
      const [subsData, botsData, plansData] = await Promise.all([
        apiFetch<Subscription[]>(`/admin/subscriptions${params}`),
        apiFetch<Bot[]>('/admin/bots'),
        apiFetch<Plan[]>('/admin/plans')
      ]);
      setSubs(subsData);
      setBots(botsData);
      setPlans(plansData);
    } catch (err: any) {
      setError(String(err?.message ?? 'Failed to load'));
    }
  }, [filterStatus]);

  React.useEffect(() => { void load(); }, [load]);

  const notify = (msg: string) => { setSuccess(msg); setTimeout(() => setSuccess(null), 4000); };

  const grant = async () => {
    if (!grantBotId || !grantPlanId || !grantUserId) { setError('Bot, Plan, and Telegram User ID are required'); return; }
    setError(null);
    try {
      const body: any = { botId: grantBotId, planId: grantPlanId, telegramUserId: Number(grantUserId) };
      if (grantDuration) body.durationMinutes = Number(grantDuration);
      await apiFetch('/admin/subscriptions/grant', { method: 'POST', body: JSON.stringify(body) });
      notify('Access granted and user notified via Telegram');
      setGrantUserId('');
      setGrantDuration('');
      await load();
    } catch (err: any) { setError(String(err?.message ?? 'Failed to grant')); }
  };

  const fmt = (d: string) => new Date(d).toLocaleDateString('en', { day: 'numeric', month: 'short', year: 'numeric' });
  const fmtTime = (d: string) => {
    const ms = new Date(d).getTime() - Date.now();
    if (ms <= 0) return 'expired';
    const h = Math.floor(ms / 3600000);
    if (h < 24) return `${h}h left`;
    return `${Math.floor(h / 24)}d left`;
  };

  const botName = (id: string) => bots.find((b) => b.id === id)?.name ?? id.slice(-6);
  const planName = (id: string) => plans.find((p) => p.id === id)?.name ?? id.slice(-6);

  const statusBadge = (s: string) => {
    if (s === 'active') return <span className="badge green">Active</span>;
    if (s === 'expired') return <span className="badge gray">Expired</span>;
    return <span className="badge red">{s}</span>;
  };

  return (
    <div>
      <div className="page-title">Subscriptions</div>
      {error && <div className="error">{error}</div>}
      {success && <div className="success">{success}</div>}

      <div className="card">
        <div className="card-title">Grant Manual Access</div>
        <div className="form-grid">
          <div className="form-field">
            <label className="form-label">Bot</label>
            <select className="input" value={grantBotId} onChange={(e) => setGrantBotId(e.target.value)}>
              <option value="">Select bot…</option>
              {bots.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
          </div>
          <div className="form-field">
            <label className="form-label">Plan</label>
            <select className="input" value={grantPlanId} onChange={(e) => setGrantPlanId(e.target.value)}>
              <option value="">Select plan…</option>
              {plans.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </div>
          <div className="form-field">
            <label className="form-label">Telegram User ID</label>
            <input className="input" type="number" placeholder="123456789" value={grantUserId} onChange={(e) => setGrantUserId(e.target.value)} />
          </div>
          <div className="form-field">
            <label className="form-label">Override Duration (min, optional)</label>
            <input className="input" type="number" placeholder="Plan default" value={grantDuration} onChange={(e) => setGrantDuration(e.target.value)} />
          </div>
        </div>
        <button className="btn" onClick={grant}>Grant Access</button>
        <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>User will be notified via Telegram with their video link.</div>
      </div>

      <div className="row" style={{ marginBottom: 16 }}>
        <select className="input" value={filterStatus} onChange={(e) => setFilterStatus(e.target.value)} style={{ width: 160 }}>
          <option value="">All statuses</option>
          <option value="active">Active</option>
          <option value="expired">Expired</option>
          <option value="canceled">Canceled</option>
        </select>
        <button className="btn secondary" onClick={load}>Refresh</button>
        <a href="/api/admin/exports/subscriptions" className="btn secondary" style={{ fontSize: 13 }}>Export CSV</a>
      </div>

      <table className="table">
        <thead>
          <tr>
            <th>User ID</th>
            <th>Bot</th>
            <th>Plan</th>
            <th>Expires</th>
            <th>Status</th>
            <th>Ref</th>
          </tr>
        </thead>
        <tbody>
          {subs.map((s) => (
            <tr key={s.id}>
              <td className="mono">{s.telegramUserId}</td>
              <td className="muted">{botName(s.botId)}</td>
              <td>{planName(s.planId)}</td>
              <td>
                <div>{fmt(s.endsAt)}</div>
                {s.status === 'active' && <div className="muted" style={{ fontSize: 11 }}>{fmtTime(s.endsAt)}</div>}
              </td>
              <td>{statusBadge(s.status)}</td>
              <td className="mono muted" style={{ fontSize: 11 }}>{s.paystackReference ? s.paystackReference.slice(-12) : '—'}</td>
            </tr>
          ))}
          {subs.length === 0 && (
            <tr><td colSpan={6} className="muted" style={{ textAlign: 'center', padding: 32 }}>No subscriptions</td></tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
