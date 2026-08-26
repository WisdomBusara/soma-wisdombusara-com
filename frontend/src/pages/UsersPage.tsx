import React from 'react';
import { apiFetch } from '../api/client';

type User = {
  id: string;
  telegramUserId: number;
  username?: string;
  firstName?: string;
  lastName?: string;
  email?: string;
  lastSeenAt?: string;
  createdAt: string;
};

export function UsersPage() {
  const [users, setUsers] = React.useState<User[]>([]);
  const [search, setSearch] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);

  const load = React.useCallback(async () => {
    setError(null);
    try {
      const params = search ? `?q=${encodeURIComponent(search)}` : '';
      setUsers(await apiFetch<User[]>(`/admin/telegram-users${params}`));
    } catch (err: any) { setError(String(err?.message ?? 'Failed')); }
  }, [search]);

  React.useEffect(() => { void load(); }, [load]);

  const displayName = (u: User) => {
    const parts = [u.firstName, u.lastName].filter(Boolean).join(' ');
    return parts || u.username || '—';
  };

  return (
    <div>
      <div className="page-title">Telegram Users</div>
      {error && <div className="error">{error}</div>}

      <div className="row" style={{ marginBottom: 16 }}>
        <input className="input" placeholder="Search by name, username, email…" value={search} onChange={(e) => setSearch(e.target.value)} style={{ maxWidth: 300 }} onKeyDown={(e) => e.key === 'Enter' && load()} />
        <button className="btn secondary" onClick={load}>Search</button>
        <span className="muted" style={{ fontSize: 12 }}>{users.length} users</span>
        <a href="/api/admin/exports/telegram-users" className="btn secondary" style={{ fontSize: 13 }}>Export CSV</a>
      </div>

      <table className="table">
        <thead>
          <tr><th>ID</th><th>Name</th><th>Username</th><th>Email</th><th>Last seen</th></tr>
        </thead>
        <tbody>
          {users.map((u) => (
            <tr key={u.id}>
              <td className="mono">{u.telegramUserId}</td>
              <td>{displayName(u)}</td>
              <td className="muted">{u.username ? `@${u.username}` : '—'}</td>
              <td className="muted" style={{ fontSize: 12 }}>{u.email ?? '—'}</td>
              <td className="muted" style={{ fontSize: 12 }}>{u.lastSeenAt ? new Date(u.lastSeenAt).toLocaleDateString() : '—'}</td>
            </tr>
          ))}
          {users.length === 0 && <tr><td colSpan={5} className="muted" style={{ textAlign: 'center', padding: 32 }}>No users</td></tr>}
        </tbody>
      </table>
    </div>
  );
}
