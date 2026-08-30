import React from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { publicFetch } from '../api/scholarships';

/**
 * Paywall + advertising client.
 *
 * Everything here is deliberately soft. A hard wall on first visit converts
 * nobody and destroys search traffic; the reader gets full search, a handful of
 * full detail views, and a running, honest count of what is left. The upgrade
 * prompt appears when they have actually hit the edge of the free tier.
 */

export interface Access {
  tier: 'free' | 'premium';
  used: number;
  limit: number | null;
  remaining: number | null;
  endsAt: string | null;
  adsEnabled: boolean;
}

const AccessContext = React.createContext<{
  access: Access | null;
  refresh: () => Promise<void>;
}>({ access: null, refresh: async () => {} });

export const useAccess = () => React.useContext(AccessContext);

export function AccessProvider({ children }: { children: React.ReactNode }) {
  const [access, setAccess] = React.useState<Access | null>(null);

  const refresh = React.useCallback(async () => {
    try {
      setAccess(await publicFetch<Access>('/access/me'));
    } catch {
      // A failed entitlement check must never blank the site — assume free.
      setAccess({ tier: 'free', used: 0, limit: 5, remaining: 5, endsAt: null, adsEnabled: true });
    }
  }, []);

  React.useEffect(() => { void refresh(); }, [refresh]);

  return (
    <AccessContext.Provider value={{ access, refresh }}>
      {children}
    </AccessContext.Provider>
  );
}

/** Small persistent indicator of remaining free views. */
export function QuotaPill() {
  const { access } = useAccess();
  if (!access) return null;
  if (access.tier === 'premium') {
    return <span className="quota-pill premium">✦ Full access</span>;
  }
  const left = access.remaining ?? 0;
  if (left > 2) return null; // don't nag until it's actually relevant
  return (
    <Link to="/upgrade" className={`quota-pill ${left === 0 ? 'out' : 'low'}`}>
      {left === 0 ? 'Free views used' : `${left} free view${left === 1 ? '' : 's'} left`}
    </Link>
  );
}

/** Shown in place of a detail page once the free allowance is spent. */
export function PaywallGate({ preview }: { preview: any }) {
  return (
    <div className="paywall">
      <div className="paywall-preview">
        <h1 className="sch-detail-title">{preview?.title ?? 'This scholarship'}</h1>
        <div className="sch-detail-eyebrow">
          {preview?.university ?? '—'}<span className="sch-dot">·</span>{preview?.country ?? ''}
        </div>
        <div className="paywall-fade" />
      </div>

      <div className="paywall-card">
        <div className="paywall-badge">Free views used</div>
        <h2>You&rsquo;ve read your free scholarships this month.</h2>
        <p>
          Unlock every listing, the eligibility matcher, and an ad-free page for less than
          the cost of a matatu ride.
        </p>
        <ul className="paywall-list">
          <li>Unlimited scholarship details</li>
          <li>Match scoring against your own profile</li>
          <li>Funding, eligibility and document requirements in full</li>
          <li>No ads</li>
        </ul>
        <Link to="/upgrade" className="btn paywall-cta">See plans</Link>
        <p className="paywall-alt">
          Already paid? <Link to="/restore">Restore your access</Link>
        </p>
      </div>
    </div>
  );
}

/** Inline upsell for premium-only features, shown instead of an error. */
export function PremiumTeaser({ title, body }: { title: string; body: string }) {
  return (
    <div className="premium-teaser">
      <div className="premium-teaser-icon">✦</div>
      <div>
        <h3>{title}</h3>
        <p>{body}</p>
      </div>
      <Link to="/upgrade" className="btn">Unlock</Link>
    </div>
  );
}

// ── Ads ─────────────────────────────────────────────────────────────────────

interface ServedAd {
  id: string;
  type: 'HOUSE' | 'NETWORK' | 'CUSTOM';
  headline?: string;
  body?: string;
  ctaLabel?: string;
  imageUrl?: string;
  clickUrl?: string;
  advertiser?: string;
  networkSlotId?: string;
  networkClientId?: string;
  html?: string;
}

/**
 * An ad placement.
 *
 * Renders nothing at all when there is no fill or the reader is premium — an
 * empty bordered box is worse than no box. Always labelled, because an unlabelled
 * ad inside a list of scholarships would read as an endorsement.
 */
export function AdSlot({
  placement, country, degree
}: {
  placement: 'listing_inline' | 'listing_sidebar' | 'detail_sidebar' | 'detail_footer' | 'landing_banner';
  country?: string | null;
  degree?: string | null;
}) {
  const { access } = useAccess();
  const [ad, setAd] = React.useState<ServedAd | null>(null);

  React.useEffect(() => {
    if (!access || access.tier === 'premium' || !access.adsEnabled) { setAd(null); return; }
    let cancelled = false;
    const qs = new URLSearchParams({ placement });
    if (country) qs.set('country', country);
    if (degree) qs.set('degree', degree);
    publicFetch<{ ad: ServedAd | null }>(`/ads?${qs}`)
      .then((r) => { if (!cancelled) setAd(r.ad); })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, [access, placement, country, degree]);

  // Network slots need the provider script to process the element after mount
  React.useEffect(() => {
    if (ad?.type !== 'NETWORK') return;
    try {
      (window as any).adsbygoogle = (window as any).adsbygoogle || [];
      (window as any).adsbygoogle.push({});
    } catch { /* blocked or not loaded — leave the slot empty */ }
  }, [ad]);

  if (!ad) return null;

  if (ad.type === 'NETWORK' && ad.networkClientId && ad.networkSlotId) {
    return (
      <aside className={`ad ad-${placement}`}>
        <div className="ad-label">Advertisement</div>
        <ins
          className="adsbygoogle"
          style={{ display: 'block' }}
          data-ad-client={ad.networkClientId}
          data-ad-slot={ad.networkSlotId}
          data-ad-format="auto"
          data-full-width-responsive="true"
        />
      </aside>
    );
  }

  if (ad.type === 'CUSTOM' && ad.html) {
    return (
      <aside className={`ad ad-${placement}`}>
        <div className="ad-label">Advertisement</div>
        {/* Admin-authored markup only — never reader input */}
        <div dangerouslySetInnerHTML={{ __html: ad.html }} />
      </aside>
    );
  }

  return (
    <aside className={`ad ad-${placement} ad-house`}>
      <div className="ad-label">Sponsored{ad.advertiser ? ` · ${ad.advertiser}` : ''}</div>
      <a
        href={ad.clickUrl ?? '#'}
        target="_blank"
        rel="noopener noreferrer sponsored"
        className="ad-body"
      >
        {ad.imageUrl && <img src={ad.imageUrl} alt="" className="ad-image" loading="lazy" />}
        <div>
          {ad.headline && <div className="ad-headline">{ad.headline}</div>}
          {ad.body && <div className="ad-text">{ad.body}</div>}
          {ad.ctaLabel && <span className="ad-cta">{ad.ctaLabel} →</span>}
        </div>
      </a>
    </aside>
  );
}

// ── Upgrade ─────────────────────────────────────────────────────────────────

interface PlanOption {
  id: string; name: string; description: string | null;
  amount: number; currency: string; durationLabel: string;
}

export function UpgradePage() {
  const { refresh } = useAccess();
  const navigate = useNavigate();
  const [plans, setPlans] = React.useState<PlanOption[]>([]);
  const [freeViews, setFreeViews] = React.useState(5);
  const [selected, setSelected] = React.useState<string | null>(null);
  const [method, setMethod] = React.useState<'mpesa' | 'card'>('mpesa');
  const [phone, setPhone] = React.useState('');
  const [email, setEmail] = React.useState('');
  const [state, setState] = React.useState<'idle' | 'paying' | 'waiting' | 'done'>('idle');
  const [error, setError] = React.useState<string | null>(null);
  const [restoreCode, setRestoreCode] = React.useState<string | null>(null);

  React.useEffect(() => {
    publicFetch<{ plans: PlanOption[]; freeViewsPerMonth: number }>('/access/plans')
      .then((r) => {
        setPlans(r.plans);
        setFreeViews(r.freeViewsPerMonth);
        if (r.plans.length > 0) setSelected(r.plans[0].id);
      })
      .catch(() => setError('Could not load plans. Please refresh.'));
  }, []);

  /** Poll until the webhook (or the server-side verify) grants access. */
  const poll = React.useCallback(async (reference: string) => {
    for (let i = 0; i < 40; i += 1) {
      await new Promise((r) => setTimeout(r, 3000));
      try {
        const r = await publicFetch<any>(`/access/status/${reference}`);
        if (r.status === 'paid') {
          setRestoreCode(r.restoreCode ?? null);
          setState('done');
          await refresh();
          return;
        }
        if (r.status === 'failed') {
          setError('That payment did not go through. You have not been charged.');
          setState('idle');
          return;
        }
      } catch { /* keep polling */ }
    }
    setError('We have not seen the payment yet. If you were charged, use your restore code or contact support.');
    setState('idle');
  }, [refresh]);

  const pay = async () => {
    if (!selected) return;
    setError(null);
    setState('paying');
    try {
      const r = await publicFetch<any>('/access/checkout', {
        method: 'POST',
        body: JSON.stringify({
          planId: selected,
          method,
          phone: method === 'mpesa' ? phone : undefined,
          email: method === 'card' ? email : undefined
        })
      });
      if (r.method === 'card' && r.authorizationUrl) {
        window.location.href = r.authorizationUrl;
        return;
      }
      setState('waiting');
      void poll(r.reference);
    } catch (e: any) {
      setError(String(e?.message ?? 'Checkout failed. Please try again.'));
      setState('idle');
    }
  };

  if (state === 'done') {
    return (
      <div className="site-page upgrade-done">
        <div className="upgrade-tick">✓</div>
        <h1 className="site-page-title">You&rsquo;re in.</h1>
        <p className="site-page-sub">Full access is active on this device.</p>
        {restoreCode && (
          <div className="restore-box">
            <div className="restore-label">Your restore code</div>
            <div className="restore-code">{restoreCode}</div>
            <p className="muted">
              Save this. It restores your access on another phone or laptop — it is the only
              way back in, and we will not show it again.
            </p>
          </div>
        )}
        <button className="btn" onClick={() => navigate('/scholarships')}>Browse scholarships</button>
      </div>
    );
  }

  return (
    <div className="site-page upgrade">
      <h1 className="site-page-title">Full access</h1>
      <p className="site-page-sub">
        {freeViews} scholarships a month are free, always. This unlocks the rest — plus the
        matcher, and no ads.
      </p>

      {error && <div className="error">{error}</div>}

      <div className="plan-grid">
        {plans.map((p) => (
          <button
            key={p.id}
            type="button"
            className={`plan-card ${selected === p.id ? 'selected' : ''}`}
            onClick={() => setSelected(p.id)}
          >
            <div className="plan-name">{p.name}</div>
            <div className="plan-price">
              <span className="plan-currency">{p.currency}</span>
              {p.amount.toLocaleString()}
            </div>
            <div className="plan-duration">for {p.durationLabel}</div>
            {p.description && <div className="plan-desc">{p.description}</div>}
          </button>
        ))}
        {plans.length === 0 && !error && <div className="muted">Loading plans…</div>}
      </div>

      <div className="pay-box">
        <div className="pay-methods">
          <button type="button" className={`pay-method ${method === 'mpesa' ? 'active' : ''}`} onClick={() => setMethod('mpesa')}>
            M-Pesa
          </button>
          <button type="button" className={`pay-method ${method === 'card' ? 'active' : ''}`} onClick={() => setMethod('card')}>
            Card
          </button>
        </div>

        {method === 'mpesa' ? (
          <>
            <label className="pay-label">Your M-Pesa number</label>
            <input
              className="input" inputMode="tel" placeholder="0712 345 678"
              value={phone} onChange={(e) => setPhone(e.target.value)}
              disabled={state !== 'idle'}
            />
            <p className="pay-hint">You&rsquo;ll get a prompt on your phone. Enter your PIN to confirm.</p>
          </>
        ) : (
          <>
            <label className="pay-label">Your email</label>
            <input
              className="input" type="email" placeholder="you@example.com"
              value={email} onChange={(e) => setEmail(e.target.value)}
              disabled={state !== 'idle'}
            />
            <p className="pay-hint">You&rsquo;ll be taken to a secure Paystack checkout.</p>
          </>
        )}

        <button className="btn pay-button" onClick={pay} disabled={state !== 'idle' || !selected}>
          {state === 'paying' ? 'Starting…' : state === 'waiting' ? 'Waiting for payment…' : 'Pay and unlock'}
        </button>

        {state === 'waiting' && (
          <p className="pay-waiting">
            Check your phone for the M-Pesa prompt. This page will unlock itself the moment
            payment lands — don&rsquo;t close it.
          </p>
        )}

        <p className="pay-alt">
          Already paid? <Link to="/restore">Restore your access</Link>
        </p>
      </div>
    </div>
  );
}

export function RestorePage() {
  const { refresh } = useAccess();
  const navigate = useNavigate();
  const [code, setCode] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await publicFetch('/access/restore', { method: 'POST', body: JSON.stringify({ code: code.trim() }) });
      await refresh();
      navigate('/scholarships');
    } catch {
      setError('That code is not valid or has expired.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="site-page restore-page">
      <h1 className="site-page-title">Restore access</h1>
      <p className="site-page-sub">Enter the restore code you were given after paying.</p>
      {error && <div className="error">{error}</div>}
      <form onSubmit={submit} className="restore-form">
        <input
          className="input restore-input"
          placeholder="ABC234"
          value={code}
          onChange={(e) => setCode(e.target.value.toUpperCase())}
          maxLength={12}
          autoCapitalize="characters"
        />
        <button className="btn" type="submit" disabled={busy || code.trim().length < 4}>
          {busy ? 'Checking…' : 'Restore'}
        </button>
      </form>
      <p className="muted">
        Lost your code? Email <a href="mailto:support@wisdombusara.com">support@wisdombusara.com</a> with
        the phone number or email you paid with.
      </p>
    </div>
  );
}
