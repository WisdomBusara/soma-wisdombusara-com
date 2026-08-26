import React from 'react';
import { apiFetch } from '../api/client';

type Payment = {
  id: string;
  reference: string;
  botId: string;
  planId: string;
  telegramUserId: number;
  email: string;
  amountKobo: number;
  currency: string;
  status: string;
  createdAt: string;
};

function fmtMoney(kobo: number, currency: string) {
  const code = currency.toUpperCase();
  const symbol = code === 'NGN' ? '₦' : code === 'KES' ? 'KSh ' : '$';
  return `${symbol}${(kobo / 100).toFixed(2)}`;
}

export function PaymentsPage() {
  const [payments, setPayments] = React.useState<Payment[]>([]);
  const [filterStatus, setFilterStatus] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);

  const load = React.useCallback(async () => {
    setError(null);
    try {
      const params = filterStatus ? `?status=${filterStatus}` : '';
      const data = await apiFetch<Payment[]>(`/admin/payments${params}`);
      setPayments(data);
    } catch (err: any) {
      setError(String(err?.message ?? 'Failed to load'));
    }
  }, [filterStatus]);

  React.useEffect(() => { void load(); }, [load]);

  const statusBadge = (s: string) => {
    if (s === 'paid') return <span className="badge green">Paid</span>;
    if (s === 'failed') return <span className="badge red">Failed</span>;
    return <span className="badge yellow">Pending</span>;
  };

  const total = payments.filter((p) => p.status === 'paid').reduce((sum, p) => sum + p.amountKobo, 0);

  return (
    <div>
      <div className="page-title">Payments</div>
      {error && <div className="error">{error}</div>}

      <div className="stats-grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))' }}>
        <div className="stat-card green">
          <div className="stat-value">{fmtMoney(total, 'NGN')}</div>
          <div className="stat-label">Paid Revenue (shown)</div>
        </div>
        <div className="stat-card">
          <div className="stat-value">{payments.filter((p) => p.status === 'paid').length}</div>
          <div className="stat-label">Paid</div>
        </div>
        <div className="stat-card">
          <div className="stat-value">{payments.filter((p) => p.status === 'initialized').length}</div>
          <div className="stat-label">Pending</div>
        </div>
      </div>

      <div className="row" style={{ marginBottom: 16 }}>
        <select className="input" value={filterStatus} onChange={(e) => setFilterStatus(e.target.value)} style={{ width: 160 }}>
          <option value="">All statuses</option>
          <option value="paid">Paid</option>
          <option value="initialized">Pending</option>
          <option value="failed">Failed</option>
        </select>
        <button className="btn secondary" onClick={load}>Refresh</button>
        <a href="/api/admin/exports/payments" className="btn secondary" style={{ fontSize: 13 }}>Export CSV</a>
      </div>

      <table className="table">
        <thead>
          <tr>
            <th>Date</th>
            <th>User ID</th>
            <th>Email</th>
            <th>Amount</th>
            <th>Status</th>
            <th>Reference</th>
          </tr>
        </thead>
        <tbody>
          {payments.map((p) => (
            <tr key={p.id}>
              <td className="muted" style={{ fontSize: 12 }}>{new Date(p.createdAt).toLocaleDateString('en', { day: 'numeric', month: 'short' })}</td>
              <td className="mono">{p.telegramUserId}</td>
              <td style={{ fontSize: 12 }}>{p.email}</td>
              <td>{fmtMoney(p.amountKobo, p.currency)}</td>
              <td>{statusBadge(p.status)}</td>
              <td className="mono muted" style={{ fontSize: 11 }}>{p.reference.slice(-16)}</td>
            </tr>
          ))}
          {payments.length === 0 && (
            <tr><td colSpan={6} className="muted" style={{ textAlign: 'center', padding: 32 }}>No payments</td></tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
