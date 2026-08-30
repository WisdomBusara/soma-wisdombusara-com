import React from 'react';
import { BrowserRouter, NavLink, Navigate, Route, Routes, useNavigate } from 'react-router-dom';

import { apiFetch } from './api/client';
import { LoginPage } from './pages/LoginPage';
import { DashboardPage } from './pages/DashboardPage';
import { BotsPage } from './pages/BotsPage';
import { PlansPage } from './pages/PlansPage';
import { SubscriptionsPage } from './pages/SubscriptionsPage';
import { PaymentsPage } from './pages/PaymentsPage';
import { ContentPage } from './pages/ContentPage';
import { QueriesPage } from './pages/QueriesPage';
import { UsersPage } from './pages/UsersPage';
import { WhatsAppPage } from './pages/WhatsAppPage';
import { SourcesPage } from './pages/SourcesPage';
import { PremiumPage } from './pages/PremiumPage';
import { ScholarshipsAdminPage } from './pages/ScholarshipsAdminPage';
import { SiteLayout, UniversityListPage, UniversityDetailPage, AboutPage } from './site/UniversityPages';
import { ScholarshipSearchPage } from './site/ScholarshipSearchPage';
import { ScholarshipDetailPage } from './site/ScholarshipDetailPage';
import { LandingPage } from './site/LandingPage';
import { AccessProvider, UpgradePage, RestorePage } from './site/Paywall';

const NAV = [
  { to: '/dashboard', label: 'Dashboard', icon: '◈' },
  { to: '/bots', label: 'Bots', icon: '⊙' },
  { to: '/whatsapp', label: 'WhatsApp', icon: '◬' },
  { to: '/sources', label: 'Sources', icon: '⌖' },
  { to: '/scholarships-admin', label: 'Scholarships', icon: '◇' },
  { to: '/premium', label: 'Premium', icon: '★' },
  { to: '/plans', label: 'Plans', icon: '◉' },
  { to: '/subscriptions', label: 'Subscriptions', icon: '◎' },
  { to: '/payments', label: 'Payments', icon: '₿' },
  { to: '/content', label: 'Broadcast', icon: '▶' },
  { to: '/queries', label: 'Support', icon: '◷' },
  { to: '/users', label: 'Users', icon: '◑' }
];

function Shell() {
  const [me, setMe] = React.useState<{ id: string; email: string } | null>(null);
  const [loading, setLoading] = React.useState(true);
  const navigate = useNavigate();

  const refreshMe = React.useCallback(async () => {
    try {
      const data = await apiFetch<{ id: string; email: string }>('/auth/me');
      setMe(data);
    } catch {
      setMe(null);
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => { void refreshMe(); }, [refreshMe]);

  const logout = async () => {
    try { await apiFetch('/auth/logout', { method: 'POST' }); } finally {
      setMe(null);
      navigate('/login');
    }
  };

  if (loading) return <div className="loading">Loading…</div>;
  if (!me) return <Navigate to="/login" replace />;

  return (
    <div className="layout">
      <nav className="sidebar">
        <div className="sidebar-logo">Wisdom Busara<span>Admin</span></div>
        <div className="sidebar-nav">
          {NAV.map((n) => (
            <NavLink key={n.to} to={n.to} className={({ isActive }) => isActive ? 'active' : ''}>
              <span>{n.icon}</span>
              {n.label}
            </NavLink>
          ))}
        </div>
        <div className="sidebar-footer">
          <div className="sidebar-user">{me.email}</div>
          <button className="btn secondary sidebar-logout" onClick={logout}>Sign out</button>
        </div>
      </nav>

      <main className="main">
        <Routes>
          <Route path="/dashboard" element={<DashboardPage />} />
          <Route path="/bots" element={<BotsPage />} />
          <Route path="/sources" element={<SourcesPage />} />
          <Route path="/scholarships-admin" element={<ScholarshipsAdminPage />} />
          <Route path="/premium" element={<PremiumPage />} />
          <Route path="/plans" element={<PlansPage />} />
          <Route path="/subscriptions" element={<SubscriptionsPage />} />
          <Route path="/payments" element={<PaymentsPage />} />
          <Route path="/content" element={<ContentPage />} />
          <Route path="/queries" element={<QueriesPage />} />
          <Route path="/whatsapp" element={<WhatsAppPage />} />
          <Route path="/users" element={<UsersPage />} />
          <Route path="*" element={<Navigate to="/dashboard" replace />} />
        </Routes>
      </main>
    </div>
  );
}

export function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<LoginPage />} />

        {/* Public scholarship site — deliberately outside <Shell />, which
            redirects to /login. These routes must resolve without a session. */}
        <Route element={<SiteLayout />}>
          <Route path="/" element={<LandingPage />} />
          <Route path="/upgrade" element={<UpgradePage />} />
          <Route path="/upgrade/complete" element={<UpgradePage />} />
          <Route path="/restore" element={<RestorePage />} />
          <Route path="/scholarships" element={<ScholarshipSearchPage />} />
          <Route path="/scholarships/:id" element={<ScholarshipDetailPage />} />
          <Route path="/universities" element={<UniversityListPage />} />
          <Route path="/universities/:id" element={<UniversityDetailPage />} />
          <Route path="/about" element={<AboutPage />} />
        </Route>

        <Route path="/*" element={<Shell />} />
      </Routes>
    </BrowserRouter>
  );
}
