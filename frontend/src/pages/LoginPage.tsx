import React from 'react';
import { useNavigate } from 'react-router-dom';
import { apiFetch } from '../api/client';

export function LoginPage() {
  const [email, setEmail] = React.useState('');
  const [password, setPassword] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(false);
  const navigate = useNavigate();

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      await apiFetch('/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) });
      navigate('/dashboard');
    } catch (err: any) {
      setError(String(err?.message ?? 'Login failed'));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '100vh', padding: 24 }}>
      <div style={{ width: '100%', maxWidth: 360 }}>
        <div style={{ textAlign: 'center', marginBottom: 32 }}>
          <div style={{ fontSize: 28, fontWeight: 800, color: 'var(--accent)' }}>Wraith<span style={{ color: 'var(--text)' }}>Admin</span></div>
          <div style={{ color: 'var(--muted)', fontSize: 13, marginTop: 6 }}>Sign in to your dashboard</div>
        </div>

        {error && <div className="error">{error}</div>}

        <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div className="form-field">
            <label className="form-label">Email</label>
            <input className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="admin@example.com" required />
          </div>
          <div className="form-field">
            <label className="form-label">Password</label>
            <input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="••••••••" required />
          </div>
          <button className="btn" type="submit" disabled={loading} style={{ marginTop: 8 }}>
            {loading ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
      </div>
    </div>
  );
}
