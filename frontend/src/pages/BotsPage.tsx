import React from 'react';
import { apiFetch } from '../api/client';

type Bot = {
  id: string;
  name: string;
  tokenLast4: string;
  protectedChatId: string;
  isActive: boolean;
  createdAt: string;
};

export function BotsPage() {
  const [bots, setBots] = React.useState<Bot[]>([]);
  const [error, setError] = React.useState<string | null>(null);
  const [success, setSuccess] = React.useState<string | null>(null);
  const [name, setName] = React.useState('');
  const [token, setToken] = React.useState('');
  const [chatId, setChatId] = React.useState('');

  const load = React.useCallback(async () => {
    try { setBots(await apiFetch<Bot[]>('/admin/bots')); }
    catch (err: any) { setError(String(err?.message ?? 'Failed')); }
  }, []);

  React.useEffect(() => { void load(); }, [load]);

  const notify = (msg: string) => { setSuccess(msg); setTimeout(() => setSuccess(null), 3000); };

  const create = async () => {
    setError(null);
    try {
      await apiFetch('/admin/bots', { method: 'POST', body: JSON.stringify({ name, token, protectedChatId: chatId }) });
      setName(''); setToken(''); setChatId('');
      notify('Bot added');
      await load();
    } catch (err: any) { setError(String(err?.message ?? 'Failed')); }
  };

  const toggle = async (bot: Bot) => {
    setError(null);
    try {
      await apiFetch(`/admin/bots/${bot.id}`, { method: 'PATCH', body: JSON.stringify({ isActive: !bot.isActive }) });
      notify(bot.isActive ? 'Bot disabled' : 'Bot enabled');
      await load();
    } catch (err: any) { setError(String(err?.message ?? 'Failed')); }
  };

  const del = async (id: string) => {
    if (!confirm('Delete this bot? This will stop it.')) return;
    setError(null);
    try {
      await apiFetch(`/admin/bots/${id}`, { method: 'DELETE' });
      notify('Bot deleted');
      await load();
    } catch (err: any) { setError(String(err?.message ?? 'Failed')); }
  };

  return (
    <div>
      <div className="page-title">Bots</div>
      {error && <div className="error">{error}</div>}
      {success && <div className="success">{success}</div>}

      <div className="card">
        <div className="card-title">Connect Telegram Bot</div>
        <div className="form-grid">
          <div className="form-field">
            <label className="form-label">Bot Name (label)</label>
            <input className="input" placeholder="My Video Bot" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="form-field">
            <label className="form-label">Bot Token (from @BotFather)</label>
            <input className="input" placeholder="123456:ABC..." value={token} onChange={(e) => setToken(e.target.value)} />
          </div>
          <div className="form-field">
            <label className="form-label">Protected Channel/Group ID</label>
            <input className="input" placeholder="-100123456789" value={chatId} onChange={(e) => setChatId(e.target.value)} />
          </div>
        </div>
        <button className="btn" onClick={create}>Add Bot</button>
        <div className="muted" style={{ fontSize: 12, marginTop: 10, lineHeight: 1.6 }}>
          The protected channel is where subscribers get access. Add your bot as admin of that channel/group.
          Enable "Join Requests" on the channel so the bot can approve/decline them.
        </div>
      </div>

      <table className="table">
        <thead>
          <tr>
            <th>Name</th>
            <th>Token (last 4)</th>
            <th>Channel ID</th>
            <th>Status</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {bots.map((b) => (
            <tr key={b.id}>
              <td style={{ fontWeight: 600 }}>{b.name}</td>
              <td className="mono muted">…{b.tokenLast4}</td>
              <td className="mono">{b.protectedChatId}</td>
              <td><span className={`badge ${b.isActive ? 'green' : 'gray'}`}>{b.isActive ? 'Running' : 'Stopped'}</span></td>
              <td>
                <div className="row">
                  <button className="btn secondary" style={{ fontSize: 12, padding: '4px 10px' }} onClick={() => toggle(b)}>{b.isActive ? 'Disable' : 'Enable'}</button>
                  <button className="btn danger" style={{ fontSize: 12, padding: '4px 10px' }} onClick={() => del(b.id)}>Delete</button>
                </div>
              </td>
            </tr>
          ))}
          {bots.length === 0 && <tr><td colSpan={5} className="muted" style={{ textAlign: 'center', padding: 32 }}>No bots yet</td></tr>}
        </tbody>
      </table>
    </div>
  );
}
