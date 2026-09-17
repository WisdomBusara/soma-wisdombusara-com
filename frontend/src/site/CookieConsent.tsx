import React from 'react';
import { Link } from 'react-router-dom';

/**
 * Cookie consent banner.
 *
 * The site sets a handful of cookies that are strictly necessary for the
 * product to work (the paywall access token, the free-view quota counter,
 * the admin session) plus, for free-tier readers, ad-serving cookies. This
 * banner is the one honest disclosure point for all of them — it does not
 * block the site or degrade functionality on reject, because the necessary
 * cookies keep working either way; what "reject" turns off is analytics/ads
 * personalization signals read elsewhere in the app.
 */

const CONSENT_KEY = 'sch_cookie_consent';

export type CookieConsent = 'accepted' | 'rejected';

export function getCookieConsent(): CookieConsent | null {
  try {
    const v = localStorage.getItem(CONSENT_KEY);
    return v === 'accepted' || v === 'rejected' ? v : null;
  } catch {
    return null;
  }
}

export function CookieConsentBanner() {
  const [choice, setChoice] = React.useState<CookieConsent | null>(() => getCookieConsent());

  const decide = (value: CookieConsent) => {
    try { localStorage.setItem(CONSENT_KEY, value); } catch { /* private mode — banner just won't persist */ }
    setChoice(value);
  };

  if (choice) return null;

  return (
    <div className="cookie-banner" role="dialog" aria-label="Cookie notice">
      <p className="cookie-banner-text">
        We use a few cookies to keep you signed in to paid access, remember your free-view
        allowance, and — for free-tier readers — show relevant ads. See our{' '}
        <Link to="/cookies">Cookie Policy</Link> for details.
      </p>
      <div className="cookie-banner-actions">
        <button type="button" className="btn secondary" onClick={() => decide('rejected')}>
          Reject non-essential
        </button>
        <button type="button" className="btn" onClick={() => decide('accepted')}>
          Accept
        </button>
      </div>
    </div>
  );
}
