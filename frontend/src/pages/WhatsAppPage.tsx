import React from 'react';
import { apiFetch } from '../api/client';

type WABot = {
  _id: string;
  name: string;
  wahaUrl: string;
  wahaSessionName: string;
  groupId: string;
  tendersGroupId?: string;
  scholarshipGroupId?: string;
  isActive: boolean;
  webhookSecret: string;
  createdAt: string;
};

const STATUS_COLOR: Record<string, string> = {
  WORKING: 'green',
  SCAN_QR_CODE: 'yellow',
  STARTING: 'yellow',
  STOPPED: 'gray',
  FAILED: 'red',
  UNKNOWN: 'gray'
};

const STATUS_LABEL: Record<string, string> = {
  WORKING: 'Connected',
  SCAN_QR_CODE: 'Scan QR',
  STARTING: 'Starting…',
  STOPPED: 'Stopped',
  FAILED: 'Error',
  UNKNOWN: 'Unknown'
};

export function WhatsAppPage() {
  const [bots, setBots] = React.useState<WABot[]>([]);
  const [error, setError] = React.useState<string | null>(null);
  const [success, setSuccess] = React.useState<string | null>(null);

  // Create form
  const [name, setName] = React.useState('');
  const [wahaUrl, setWahaUrl] = React.useState('https://waha.neithlogic.com');
  const [sessionName, setSessionName] = React.useState('default');
  const [apiKey, setApiKey] = React.useState('');
  const [groupId, setGroupId] = React.useState('');

  // Management panel
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const [status, setStatus] = React.useState<string>('UNKNOWN');
  const [qr, setQr] = React.useState<string | null>(null);
  const [webhookUrl, setWebhookUrl] = React.useState<string>('');
  const [actionLoading, setActionLoading] = React.useState(false);
  const [groups, setGroups] = React.useState<{ id: string; name: string; size: number }[]>([]);
  const [groupsLoading, setGroupsLoading] = React.useState(false);
  const [showGroups, setShowGroups] = React.useState(false);
  const [editGroupId, setEditGroupId] = React.useState('');
  const [editTendersGroupId, setEditTendersGroupId] = React.useState('');
  const [editScholarshipGroupId, setEditScholarshipGroupId] = React.useState('');
  const pollRef = React.useRef<ReturnType<typeof setInterval> | null>(null);


  const load = React.useCallback(async () => {
    try { setBots(await apiFetch<WABot[]>('/admin/wa-bots')); }
    catch (err: any) { setError(String(err?.message ?? 'Failed to load')); }
  }, []);

  React.useEffect(() => { void load(); }, [load]);

  const notify = (msg: string) => { setSuccess(msg); setTimeout(() => setSuccess(null), 3000); };

  // Poll status + QR for the selected bot
  const pollStatus = React.useCallback(async (botId: string) => {
    try {
      const data = await apiFetch<{ status: string }>(`/admin/wa-bots/${botId}/status`);
      setStatus(data.status ?? 'UNKNOWN');
      if (data.status === 'SCAN_QR_CODE') {
        try {
          const qrData = await apiFetch<{ qr: string }>(`/admin/wa-bots/${botId}/qr`);
          setQr(qrData.qr ?? null);
        } catch { setQr(null); }
      } else {
        setQr(null);
      }
    } catch {
      setStatus('UNKNOWN');
    }
  }, []);

  const startPolling = React.useCallback((botId: string) => {
    if (pollRef.current) clearInterval(pollRef.current);
    void pollStatus(botId);
    pollRef.current = setInterval(() => void pollStatus(botId), 5000);
  }, [pollStatus]);

  const stopPolling = React.useCallback(() => {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
  }, []);

  React.useEffect(() => () => stopPolling(), [stopPolling]);

  const selectBot = async (bot: WABot) => {
    stopPolling();
    setSelectedId(bot._id);
    setStatus('UNKNOWN');
    setQr(null);
    setGroups([]);
    setShowGroups(false);
    setEditGroupId(bot.groupId);
    setEditTendersGroupId((bot as any).tendersGroupId ?? '');
    setEditScholarshipGroupId((bot as any).scholarshipGroupId ?? '');
    startPolling(bot._id);
    try {
      const data = await apiFetch<{ webhookUrl: string }>(`/admin/wa-bots/${bot._id}/webhook-url`);
      setWebhookUrl(data.webhookUrl ?? '');
    } catch { setWebhookUrl(''); }
  };

  const loadGroups = async () => {
    if (!selectedId) return;
    setGroupsLoading(true); setError(null);
    try {
      const data = await apiFetch<{ id: string; name: string; size: number }[]>(`/admin/wa-bots/${selectedId}/groups`);
      setGroups(data);
      setShowGroups(true);
    } catch (err: any) { setError(String(err?.message ?? 'Could not load groups — make sure the session is connected first')); }
    finally { setGroupsLoading(false); }
  };

  const saveTendersGroupId = async () => {
    if (!selectedId) return;
    setError(null);
    try {
      await apiFetch(`/admin/wa-bots/${selectedId}`, { method: 'PATCH', body: JSON.stringify({ tendersGroupId: editTendersGroupId }) });
      notify('Tenders group saved');
      await load();
    } catch (err: any) { setError(String(err?.message ?? 'Failed to save')); }
  };

  const saveScholarshipGroupId = async () => {
    if (!selectedId) return;
    setError(null);
    try {
      await apiFetch(`/admin/wa-bots/${selectedId}`, { method: 'PATCH', body: JSON.stringify({ scholarshipGroupId: editScholarshipGroupId }) });
      notify('Scholarships group saved');
      await load();
    } catch (err: any) { setError(String(err?.message ?? 'Failed to save')); }
  };

  const saveGroupId = async () => {
    if (!selectedId || !editGroupId) return;
    setError(null);
    try {
      await apiFetch(`/admin/wa-bots/${selectedId}`, { method: 'PATCH', body: JSON.stringify({ groupId: editGroupId }) });
      notify('Subscription group saved');
      setShowGroups(false);
      await load();
    } catch (err: any) { setError(String(err?.message ?? 'Failed')); }
  };

  const deselect = () => {
    stopPolling();
    setSelectedId(null);
    setStatus('UNKNOWN');
    setQr(null);
  };

  const create = async () => {
    setError(null);
    if (!name || !wahaUrl || !sessionName || !groupId) { setError('Name, WAHA URL, session name and group ID are required'); return; }
    try {
      await apiFetch('/admin/wa-bots', { method: 'POST', body: JSON.stringify({ name, wahaUrl, wahaSessionName: sessionName, wahaApiKey: apiKey || undefined, groupId }) });
      setName(''); setApiKey(''); setGroupId('');
      notify('WhatsApp bot added');
      await load();
    } catch (err: any) { setError(String(err?.message ?? 'Failed')); }
  };

  const toggle = async (bot: WABot) => {
    setError(null);
    try {
      await apiFetch(`/admin/wa-bots/${bot._id}`, { method: 'PATCH', body: JSON.stringify({ isActive: !bot.isActive }) });
      notify(bot.isActive ? 'Bot disabled' : 'Bot enabled');
      await load();
    } catch (err: any) { setError(String(err?.message ?? 'Failed')); }
  };

  const del = async (bot: WABot) => {
    if (!confirm(`Delete "${bot.name}"?`)) return;
    if (selectedId === bot._id) deselect();
    setError(null);
    try {
      await apiFetch(`/admin/wa-bots/${bot._id}`, { method: 'DELETE' });
      notify('Bot deleted');
      await load();
    } catch (err: any) { setError(String(err?.message ?? 'Failed')); }
  };

  const startSession = async () => {
    if (!selectedId) return;
    setActionLoading(true); setError(null);
    try {
      await apiFetch(`/admin/wa-bots/${selectedId}/start`, { method: 'POST' });
      notify('Session started — scan the QR code with your WhatsApp');
      await pollStatus(selectedId);
    } catch (err: any) { setError(String(err?.message ?? 'Failed to start session')); }
    finally { setActionLoading(false); }
  };

  const configureWebhook = async () => {
    if (!selectedId) return;
    setActionLoading(true); setError(null);
    try {
      await apiFetch(`/admin/wa-bots/${selectedId}/configure-webhook`, { method: 'POST' });
      notify('Webhook configured in WAHA ✓');
    } catch (err: any) { setError(String(err?.message ?? 'Failed to configure webhook')); }
    finally { setActionLoading(false); }
  };

  const selectedBot = bots.find((b) => b._id === selectedId) ?? null;

  return (
    <div>
      <div className="page-title">WhatsApp Bots</div>
      {error && <div className="error">{error}</div>}
      {success && <div className="success">{success}</div>}

      {/* Create form */}
      <div className="card">
        <div className="card-title">Add WhatsApp Bot</div>
        <div className="form-grid">
          <div className="form-field">
            <label className="form-label">Bot Name</label>
            <input className="input" placeholder="My WhatsApp Bot" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="form-field">
            <label className="form-label">WAHA URL</label>
            <input className="input" placeholder="https://waha.neithlogic.com" value={wahaUrl} onChange={(e) => setWahaUrl(e.target.value)} />
          </div>
          <div className="form-field">
            <label className="form-label">Session Name</label>
            <input className="input" placeholder="default" value={sessionName} onChange={(e) => setSessionName(e.target.value)} />
          </div>
          <div className="form-field">
            <label className="form-label">WAHA API Key</label>
            <input className="input" type="password" placeholder="your-waha-api-key" value={apiKey} onChange={(e) => setApiKey(e.target.value)} />
          </div>
          <div className="form-field">
            <label className="form-label">WhatsApp Group ID <span className="muted" style={{fontWeight:400}}>(put "pending" if you don't have it yet)</span></label>
            <input className="input" placeholder="pending" value={groupId} onChange={(e) => setGroupId(e.target.value)} />
          </div>
        </div>
        <button className="btn" onClick={create}>Add Bot</button>
        <div className="muted" style={{ fontSize: 12, marginTop: 10, lineHeight: 1.6 }}>
          Don't know your group ID yet? Put <span className="mono">pending</span> and update it after you connect —
          click the bot row → <em>List my groups</em> → tap the group → Save.
          WAHA URL: <span className="mono">https://waha.neithlogic.com</span> &nbsp;|&nbsp;
          API Key: ask your admin (set via fly secrets).
        </div>
      </div>

      {/* Bot table */}
      <table className="table">
        <thead>
          <tr>
            <th>Name</th>
            <th>WAHA URL</th>
            <th>Session</th>
            <th>Group ID</th>
            <th>Active</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {bots.map((b) => (
            <tr
              key={b._id}
              style={{ cursor: 'pointer', background: selectedId === b._id ? 'rgba(255,255,255,0.04)' : undefined }}
              onClick={() => selectedId === b._id ? deselect() : selectBot(b)}
            >
              <td style={{ fontWeight: 600 }}>{b.name}</td>
              <td className="mono muted" style={{ fontSize: 12 }}>{b.wahaUrl}</td>
              <td className="mono">{b.wahaSessionName}</td>
              <td className="mono" style={{ fontSize: 11 }}>{b.groupId}</td>
              <td><span className={`badge ${b.isActive ? 'green' : 'gray'}`}>{b.isActive ? 'Active' : 'Inactive'}</span></td>
              <td onClick={(e) => e.stopPropagation()}>
                <div className="row">
                  <button className="btn secondary" style={{ fontSize: 12, padding: '4px 10px' }} onClick={() => toggle(b)}>
                    {b.isActive ? 'Disable' : 'Enable'}
                  </button>
                  <button className="btn danger" style={{ fontSize: 12, padding: '4px 10px' }} onClick={() => del(b)}>
                    Delete
                  </button>
                </div>
              </td>
            </tr>
          ))}
          {bots.length === 0 && (
            <tr><td colSpan={6} className="muted" style={{ textAlign: 'center', padding: 32 }}>No WhatsApp bots yet</td></tr>
          )}
        </tbody>
      </table>

      <ReportCard vertical="jobs" onError={setError} onNotify={notify} />
      <ReportCard vertical="tenders" onError={setError} onNotify={notify} />
      <ScholarshipReportCard onError={setError} onNotify={notify} />

      {/* Management panel */}
      {selectedBot && (
        <div className="card" style={{ marginTop: 24 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
            <div className="card-title" style={{ marginBottom: 0 }}>
              Manage — {selectedBot.name}
            </div>
            <button className="btn ghost" style={{ fontSize: 12 }} onClick={deselect}>✕ Close</button>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 24 }}>
            {/* Left: status + controls */}
            <div>
              <div style={{ marginBottom: 16 }}>
                <div className="form-label" style={{ marginBottom: 8 }}>Session Status</div>
                <span className={`badge ${STATUS_COLOR[status] ?? 'gray'}`} style={{ fontSize: 14, padding: '6px 14px' }}>
                  {STATUS_LABEL[status] ?? status}
                </span>
                {status === 'SCAN_QR_CODE' && (
                  <span className="muted" style={{ marginLeft: 12, fontSize: 12 }}>
                    Scan with your WhatsApp to connect
                  </span>
                )}
              </div>

              <div className="row" style={{ marginBottom: 20, flexWrap: 'wrap', gap: 8 }}>
                <button className="btn" onClick={startSession} disabled={actionLoading}>
                  {actionLoading ? 'Working…' : (status === 'WORKING' ? '↺ Restart Session' : status === 'FAILED' ? '↺ Get New QR' : '▶ Start Session')}
                </button>
                <button className="btn secondary" onClick={() => pollStatus(selectedBot._id)}>
                  ↻ Refresh
                </button>
                <button className="btn secondary" onClick={configureWebhook} disabled={actionLoading}>
                  ⚡ Configure Webhook
                </button>
              </div>

              <div style={{ marginBottom: 12 }}>
                <div className="form-label" style={{ marginBottom: 6 }}>Webhook URL (set in WAHA config)</div>
                <div className="mono" style={{ fontSize: 11, background: 'rgba(255,255,255,0.06)', padding: '10px 12px', borderRadius: 6, wordBreak: 'break-all', lineHeight: 1.5 }}>
                  {webhookUrl || 'Loading…'}
                </div>
                {webhookUrl && (
                  <button
                    className="btn ghost"
                    style={{ fontSize: 11, marginTop: 6 }}
                    onClick={() => { navigator.clipboard.writeText(webhookUrl); notify('Copied!'); }}
                  >
                    Copy
                  </button>
                )}
              </div>

              {/* Group ID picker */}
              <div style={{ borderTop: '1px solid rgba(255,255,255,0.06)', paddingTop: 14, marginTop: 4 }}>
                <div className="form-label" style={{ marginBottom: 8 }}>WhatsApp Group ID <span className="muted" style={{fontWeight:400}}>(update after connecting)</span></div>
                <div className="row" style={{ gap: 8, marginBottom: 8 }}>
                  <input
                    className="input"
                    style={{ flex: 1, fontSize: 12 }}
                    placeholder="120363xxx@g.us"
                    value={editGroupId}
                    onChange={(e) => setEditGroupId(e.target.value)}
                  />
                  <button className="btn secondary" style={{ fontSize: 12, whiteSpace: 'nowrap' }} onClick={saveGroupId}>Save</button>
                </div>
                <div className="form-label" style={{ marginBottom: 8, marginTop: 12 }}>📋 Tenders Group ID <span className="muted" style={{fontWeight:400}}>(separate group for the tenders digest)</span></div>
                <div className="row" style={{ gap: 8, marginBottom: 8 }}>
                  <input
                    className="input"
                    style={{ flex: 1, fontSize: 12 }}
                    placeholder="120363xxx@g.us"
                    value={editTendersGroupId}
                    onChange={(e) => setEditTendersGroupId(e.target.value)}
                  />
                  <button className="btn secondary" style={{ fontSize: 12, whiteSpace: 'nowrap' }} onClick={saveTendersGroupId}>Save</button>
                </div>
                <div className="form-label" style={{ marginBottom: 8, marginTop: 12 }}>🎓 Scholarships Group ID <span className="muted" style={{fontWeight:400}}>(same session, separate group)</span></div>
                <div className="row" style={{ gap: 8, marginBottom: 8 }}>
                  <input
                    className="input"
                    style={{ flex: 1, fontSize: 12 }}
                    placeholder="120363xxx@g.us"
                    value={editScholarshipGroupId}
                    onChange={(e) => setEditScholarshipGroupId(e.target.value)}
                  />
                  <button className="btn secondary" style={{ fontSize: 12, whiteSpace: 'nowrap' }} onClick={saveScholarshipGroupId}>Save</button>
                </div>
                <button
                  className="btn ghost"
                  style={{ fontSize: 12 }}
                  onClick={loadGroups}
                  disabled={groupsLoading}
                >
                  {groupsLoading ? 'Loading…' : '📋 List my groups (connect first)'}
                </button>

                {showGroups && groups.length > 0 && (
                  <div style={{ marginTop: 10, background: 'rgba(255,255,255,0.04)', borderRadius: 8, overflow: 'hidden' }}>
                    {groups.map((g) => (
                      <div
                        key={g.id}
                        onClick={() => setEditGroupId(g.id)}
                        style={{
                          padding: '10px 14px', cursor: 'pointer', borderBottom: '1px solid rgba(255,255,255,0.05)',
                          background: editGroupId === g.id ? 'rgba(34,197,94,0.1)' : undefined,
                          display: 'flex', justifyContent: 'space-between', alignItems: 'center'
                        }}
                      >
                        <div>
                          <div style={{ fontWeight: 600, fontSize: 13 }}>{g.name || '(unnamed)'}</div>
                          <div className="mono muted" style={{ fontSize: 11 }}>{g.id}</div>
                        </div>
                        <span className="muted" style={{ fontSize: 11 }}>{g.size} members</span>
                      </div>
                    ))}
                  </div>
                )}
                {showGroups && groups.length === 0 && (
                  <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>
                    No groups found. Create a WhatsApp group on your phone first and make the linked number an admin.
                  </div>
                )}
              </div>

              <div className="muted" style={{ fontSize: 12, lineHeight: 1.7, borderTop: '1px solid rgba(255,255,255,0.06)', paddingTop: 14, marginTop: 14 }}>
                <strong style={{ color: '#ccc' }}>First time? Follow these steps:</strong><br />
                1. Click <em>Start Session</em> — QR code appears on the right<br />
                2. On your phone: <strong>WhatsApp → Linked Devices → Link a Device</strong> → scan<br />
                3. Create a group on WhatsApp and make that number admin<br />
                4. Click <em>List my groups</em> → tap your group → Save<br />
                5. Click <em>Configure Webhook</em> — done!
              </div>
            </div>

            {/* Right: QR code */}
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', minHeight: 200 }}>
              {status === 'SCAN_QR_CODE' ? (
                qr ? (
                  <div style={{ textAlign: 'center' }}>
                    <div className="form-label" style={{ marginBottom: 12 }}>Scan with WhatsApp</div>
                    <img
                      src={qr}
                      alt="WhatsApp QR Code"
                      style={{ width: 220, height: 220, borderRadius: 12, border: '3px solid rgba(255,255,255,0.1)', background: '#fff' }}
                    />
                    <div className="muted" style={{ fontSize: 11, marginTop: 10 }}>
                      Open WhatsApp → Linked Devices → Link a Device
                    </div>
                  </div>
                ) : (
                  <div style={{ textAlign: 'center' }}>
                    <div style={{ width: 220, height: 220, borderRadius: 12, background: 'rgba(255,255,255,0.04)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                      <div className="muted" style={{ fontSize: 13 }}>Loading QR…</div>
                    </div>
                  </div>
                )
              ) : status === 'WORKING' ? (
                <div style={{ textAlign: 'center' }}>
                  <div style={{ fontSize: 56, marginBottom: 12 }}>✅</div>
                  <div style={{ fontWeight: 600, color: '#22c55e', fontSize: 16 }}>Connected</div>
                  <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>WhatsApp is active and receiving messages</div>
                </div>
              ) : (
                <div style={{ textAlign: 'center' }}>
                  <div style={{ fontSize: 48, marginBottom: 12 }}>{status === 'FAILED' ? '⚠️' : '📱'}</div>
                  <div className="muted" style={{ fontSize: 13 }}>
                    {status === 'STOPPED' ? 'Click Start Session to begin'
                      : status === 'UNKNOWN' ? 'Click Start Session or Refresh'
                      : status === 'FAILED' ? 'QR expired — click ↺ Get New QR to regenerate'
                      : status === 'STARTING' ? 'Starting… please wait'
                      : `Status: ${status}`}
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}


type RunStatus = {
  state: 'idle' | 'scraping' | 'sending' | 'done' | 'failed';
  startedAt: string | null; finishedAt: string | null;
  banksDone: number; banksTotal: number; currentBank: string | null;
  newJobs: number; banksWithNew: number; error: string | null;
};

function ReportCard({ vertical, onError, onNotify }: { vertical: 'jobs' | 'tenders'; onError: (m: string | null) => void; onNotify: (m: string) => void }) {
  const isTenders = vertical === 'tenders';
  const label = isTenders ? 'Tenders' : 'Jobs';
  const emoji = isTenders ? '📋' : '💼';
  const noun = isTenders ? 'tenders' : 'jobs';
  const [status, setStatus] = React.useState<RunStatus | null>(null);

  React.useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let stopped = false;
    const tick = async () => {
      let active = false;
      try {
        const s = await apiFetch<RunStatus>(`/admin/jobs/status?vertical=${vertical}`);
        if (stopped) return;
        setStatus(s);
        active = s.state === 'scraping' || s.state === 'sending';
      } catch { /* keep last */ }
      if (!stopped) timer = setTimeout(tick, active ? 4000 : 30000);
    };
    void tick();
    return () => { stopped = true; if (timer) clearTimeout(timer); };
  }, [vertical]);

  return (
    <div className="card" style={{ marginTop: 24 }}>
      <div className="card-title">{emoji} Daily {label} Report</div>
      <p className="muted" style={{ fontSize: 13, marginBottom: 16, lineHeight: 1.6 }}>
        Scrapes the {label} sources nightly and posts new {noun} to the {isTenders ? 'tenders' : 'jobs'} WhatsApp group.
        Runs automatically at {isTenders ? '07:20' : '07:00'} EAT.
      </p>
      {status && (
        <div style={{ marginBottom: 16, padding: '12px 14px', border: '1px solid var(--border, #2a2a2a)', borderRadius: 8, fontSize: 13 }}>
          {status.state === 'idle' && (
            <span className="muted">💤 No run since the last restart — next scheduled run {isTenders ? '07:20' : '07:00'} EAT. Trigger one below to watch it live.</span>
          )}
          {(status.state === 'scraping' || status.state === 'sending') && (
            <>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
                <span>
                  {status.state === 'scraping'
                    ? <>⏳ Scraping — <b>{status.banksDone}/{status.banksTotal || '…'}</b>{status.currentBank ? <span className="muted"> · {status.currentBank}</span> : null}</>
                    : <>📤 Sending digest — <b>{status.newJobs}</b> new {noun} across <b>{status.banksWithNew}</b> sources</>}
                </span>
                <span className="muted">{status.startedAt ? `started ${new Date(status.startedAt).toLocaleTimeString()}` : ''}</span>
              </div>
              <div style={{ height: 6, background: 'var(--border, #2a2a2a)', borderRadius: 3, overflow: 'hidden' }}>
                <div style={{ height: '100%', width: `${status.banksTotal ? Math.round((status.banksDone / status.banksTotal) * 100) : 5}%`, background: '#22c55e', transition: 'width 0.5s' }} />
              </div>
            </>
          )}
          {status.state === 'done' && (
            <span>✅ Last run: <b>{status.newJobs}</b> new {noun} across <b>{status.banksWithNew}</b> sources ({status.banksDone} scraped) — finished {status.finishedAt ? new Date(status.finishedAt).toLocaleTimeString() : ''}</span>
          )}
          {status.state === 'failed' && (
            <span>❌ Last run failed: <span className="mono">{status.error}</span></span>
          )}
        </div>
      )}
      <div className="row" style={{ gap: 10 }}>
        <button className="btn" onClick={async () => {
          onError(null);
          try {
            await apiFetch(`/admin/jobs/run?vertical=${vertical}`, { method: 'POST' });
            onNotify(`${label} report triggered — check the group in ~60 seconds`);
          } catch (err: any) { onError(String(err?.message ?? 'Failed to trigger')); }
        }}>▶ Send Report Now</button>
        <button className="btn danger" onClick={async () => {
          if (!confirm(`This deletes all saved ${noun} records and resends a fresh report with everything as "new". Continue?`)) return;
          onError(null);
          try {
            const r = await apiFetch<{ message: string }>(`/admin/jobs/reset-and-run?vertical=${vertical}`, { method: 'POST' });
            onNotify(r.message ?? 'Reset done — fresh report incoming');
          } catch (err: any) { onError(String(err?.message ?? 'Failed to reset')); }
        }}>↺ Reset & Resend All</button>
      </div>
    </div>
  );
}

type ScholarshipDeliverySummary = {
  subscribers: number;
  emailsSent: number;
  whatsappSent: number;
  telegramSent: number;
  groupBroadcast: boolean;
  failures: number;
};

function ScholarshipReportCard({ onError, onNotify }: { onError: (m: string | null) => void; onNotify: (m: string) => void }) {
  const [busy, setBusy] = React.useState(false);
  const [last, setLast] = React.useState<ScholarshipDeliverySummary | null>(null);

  const send = async () => {
    setBusy(true); onError(null);
    try {
      const r = await apiFetch<{ summary: ScholarshipDeliverySummary }>('/admin/scholarship/deliver', { method: 'POST' });
      setLast(r.summary);
      onNotify(
        `Scholarship report sent — group ${r.summary.groupBroadcast ? 'posted' : 'skipped'}, ` +
        `${r.summary.whatsappSent} WhatsApp, ${r.summary.telegramSent} Telegram, ${r.summary.emailsSent} email`
      );
    } catch (err: any) { onError(String(err?.message ?? 'Failed to send scholarship report')); }
    finally { setBusy(false); }
  };

  return (
    <div className="card" style={{ marginTop: 24 }}>
      <div className="card-title">🎓 Daily Scholarship Report</div>
      <p className="muted" style={{ fontSize: 13, marginBottom: 16, lineHeight: 1.6 }}>
        Posts newly open/closing-soon scholarships to the Scholarships WhatsApp group and Telegram
        channel, plus email/WhatsApp/Telegram to individual subscribers. Runs automatically as the
        last step of each nightly crawl cycle — this sends immediately without waiting for or
        re-running the crawl. Note: clicking this twice in a short window reposts the same recent
        batch to the group (no per-click dedup, same as the crawl's own nightly send).
      </p>
      {last && (
        <div style={{ marginBottom: 16, padding: '12px 14px', border: '1px solid var(--border, #2a2a2a)', borderRadius: 8, fontSize: 13 }}>
          ✅ Last send: group {last.groupBroadcast ? 'posted' : 'skipped'} · {last.whatsappSent} WhatsApp ·{' '}
          {last.telegramSent} Telegram · {last.emailsSent} email · {last.subscribers} subscriber(s) checked
          {last.failures > 0 && <span className="error" style={{ marginLeft: 8 }}>{last.failures} failure(s)</span>}
        </div>
      )}
      <button className="btn" disabled={busy} onClick={send}>
        {busy ? 'Sending…' : '▶ Send Report Now'}
      </button>
    </div>
  );
}
