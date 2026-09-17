import React from 'react';
import { Link } from 'react-router-dom';
import { publicFetch } from '../api/scholarships';
import { useAccess } from './Paywall';

/**
 * Delivery subscription.
 *
 * Shown to paid readers so they choose how new scholarships reach them: email,
 * Telegram, and/or WhatsApp. Rendered on /subscribe and as a card after
 * checkout completes.
 */

type Channel = 'email' | 'telegram' | 'whatsapp';

export function SubscribePage() {
  const { access } = useAccess();
  const [channels, setChannels] = React.useState<Channel[]>(['email']);
  const [email, setEmail] = React.useState('');
  const [phone, setPhone] = React.useState('');
  const [fundingOnly, setFundingOnly] = React.useState(false);
  const [state, setState] = React.useState<'idle' | 'saving' | 'done'>('idle');
  const [error, setError] = React.useState<string | null>(null);
  const [telegram, setTelegram] = React.useState<{ connectCode: string; instructions: string; botUsername: string | null } | null>(null);

  // Not paid yet → send them to upgrade first.
  if (access && access.tier !== 'premium') {
    return (
      <div className="site-page">
        <h1 className="site-page-title">Get scholarships delivered</h1>
        <p className="site-page-sub">Delivery is part of full access. Unlock it first, then choose your channels.</p>
        <Link to="/upgrade" className="btn">See plans</Link>
      </div>
    );
  }

  const toggle = (c: Channel) =>
    setChannels((prev) => (prev.includes(c) ? prev.filter((x) => x !== c) : [...prev, c]));

  const save = async () => {
    setError(null);
    if (channels.length === 0) { setError('Pick at least one channel.'); return; }
    if (channels.includes('email') && !email) { setError('Enter your email.'); return; }
    if (channels.includes('whatsapp') && !phone) { setError('Enter your WhatsApp number.'); return; }
    setState('saving');
    try {
      const r = await publicFetch<any>('/subscribe', {
        method: 'POST',
        body: JSON.stringify({
          channels,
          email: channels.includes('email') ? email : undefined,
          whatsappPhone: channels.includes('whatsapp') ? phone : undefined,
          fundingOnly
        })
      });
      if (r.telegram) setTelegram(r.telegram);
      setState('done');
    } catch (e: any) {
      setError(String(e?.message ?? 'Could not save. Please try again.'));
      setState('idle');
    }
  };

  if (state === 'done') {
    return (
      <div className="site-page">
        <div className="upgrade-tick">✓</div>
        <h1 className="site-page-title">You&rsquo;re subscribed.</h1>
        <p className="site-page-sub">New scholarships will reach you on your chosen channels as our engine finds them.</p>
        {telegram && (
          <div className="restore-box">
            <div className="restore-label">One more step for Telegram</div>
            <p style={{ marginBottom: 8 }}>{telegram.instructions}</p>
            <div className="restore-code" style={{ fontSize: 22 }}>/connect {telegram.connectCode}</div>
            {telegram.botUsername && (
              <a className="btn secondary" href={`https://t.me/${telegram.botUsername.replace('@', '')}`} target="_blank" rel="noopener noreferrer">
                Open the bot
              </a>
            )}
          </div>
        )}
        <Link to="/scholarships" className="btn">Browse scholarships</Link>
      </div>
    );
  }

  return (
    <div className="site-page subscribe">
      <h1 className="site-page-title">Get new scholarships delivered</h1>
      <p className="site-page-sub">Choose how you want them — pick as many as you like.</p>

      {error && <div className="error">{error}</div>}

      <div className="channel-grid">
        <button type="button" className={`channel-card ${channels.includes('email') ? 'on' : ''}`} onClick={() => toggle('email')}>
          <div className="channel-icon">✉️</div>
          <div className="channel-name">Email</div>
          <div className="channel-desc">A tidy digest in your inbox</div>
        </button>
        <button type="button" className={`channel-card ${channels.includes('telegram') ? 'on' : ''}`} onClick={() => toggle('telegram')}>
          <div className="channel-icon">✈️</div>
          <div className="channel-name">Telegram</div>
          <div className="channel-desc">Instant, via our bot</div>
        </button>
        <button type="button" className={`channel-card ${channels.includes('whatsapp') ? 'on' : ''}`} onClick={() => toggle('whatsapp')}>
          <div className="channel-icon">💬</div>
          <div className="channel-name">WhatsApp</div>
          <div className="channel-desc">Straight to your chats</div>
        </button>
      </div>

      <div className="subscribe-fields">
        {channels.includes('email') && (
          <div className="field">
            <label>Your email</label>
            <input className="input" type="email" placeholder="you@example.com" value={email} onChange={(e) => setEmail(e.target.value)} />
          </div>
        )}
        {channels.includes('whatsapp') && (
          <div className="field">
            <label>Your WhatsApp number</label>
            <input className="input" inputMode="tel" placeholder="0712 345 678" value={phone} onChange={(e) => setPhone(e.target.value)} />
          </div>
        )}
        {channels.includes('telegram') && (
          <p className="pay-hint">After saving, we&rsquo;ll give you a code to send our Telegram bot — that links your chat.</p>
        )}

        <label className="subscribe-check">
          <input type="checkbox" checked={fundingOnly} onChange={(e) => setFundingOnly(e.target.checked)} />
          Only send me fully-funded scholarships
        </label>
      </div>

      <button className="btn" onClick={save} disabled={state === 'saving'}>
        {state === 'saving' ? 'Saving…' : 'Start delivery'}
      </button>
    </div>
  );
}
