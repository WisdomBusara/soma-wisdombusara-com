import React from 'react';
import { apiFetch } from '../api/client';

type Summary = {
  bots: number;
  plans: number;
  subscriptions: number;
  subscriptionsActive: number;
  subscriptionsExpired: number;
  openQueries: number;
  revenueKobo: number;
  revenueCurrency: string;
  paidPayments: number;
  totalUsers: number;
};

function fmt(kobo: number, currency = 'KES') {
  const code = currency.toUpperCase();
  const symbol = code === 'KES' ? 'KSh ' : code === 'NGN' ? '₦' : code === 'GHS' ? '₵' : '$';
  return `${symbol}${(kobo / 100).toLocaleString('en', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function DashboardPage() {
  const [summary, setSummary] = React.useState<Summary | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  const load = React.useCallback(async () => {
    setError(null);
    try {
      const data = await apiFetch<Summary>('/admin/reports/summary');
      setSummary(data);
    } catch (err: any) {
      setError(String(err?.message ?? 'Failed to load'));
    }
  }, []);

  React.useEffect(() => { void load(); }, [load]);

  return (
    <div>
      <div className="page-title">Dashboard</div>
      {error && <div className="error">{error}</div>}

      {summary && (
        <>
          <div className="stats-grid">
            <div className="stat-card green">
              <div className="stat-value">{fmt(summary.revenueKobo, summary.revenueCurrency)}</div>
              <div className="stat-label">Total Revenue</div>
            </div>
            <div className="stat-card green">
              <div className="stat-value">{summary.subscriptionsActive}</div>
              <div className="stat-label">Active Subs</div>
            </div>
            <div className="stat-card">
              <div className="stat-value">{summary.paidPayments}</div>
              <div className="stat-label">Total Payments</div>
            </div>
            <div className="stat-card">
              <div className="stat-value">{summary.totalUsers}</div>
              <div className="stat-label">Telegram Users</div>
            </div>
            <div className="stat-card warn">
              <div className="stat-value">{summary.openQueries}</div>
              <div className="stat-label">Open Queries</div>
            </div>
            <div className="stat-card">
              <div className="stat-value">{summary.bots}</div>
              <div className="stat-label">Bots</div>
            </div>
            <div className="stat-card">
              <div className="stat-value">{summary.plans}</div>
              <div className="stat-label">Plans</div>
            </div>
            <div className="stat-card">
              <div className="stat-value">{summary.subscriptionsExpired}</div>
              <div className="stat-label">Expired Subs</div>
            </div>
          </div>

          <div className="card">
            <div className="card-title">Quick Tips</div>
            <ul style={{ color: 'var(--muted)', fontSize: 13, lineHeight: 2, paddingLeft: 18 }}>
              <li>Go to <strong>Plans</strong> to add subscription tiers and paste video links</li>
              <li>Go to <strong>Bots</strong> to connect a Telegram bot and its protected channel</li>
              <li>Go to <strong>WhatsApp</strong> to add a WAHA bot, scan the QR and link a WhatsApp group</li>
              <li>Users pick a plan → pay via M-Pesa or Card → added to channel/group automatically</li>
              <li>Use <strong>Subscriptions → Grant Access</strong> to manually give someone access</li>
            </ul>
          </div>
        </>
      )}

      <button className="btn secondary" onClick={load} style={{ marginTop: 8 }}>Refresh</button>
    </div>
  );
}
