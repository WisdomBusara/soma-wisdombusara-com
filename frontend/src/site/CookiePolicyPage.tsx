import React from 'react';

export function CookiePolicyPage() {
  return (
    <div className="site-page site-prose">
      <h1 className="site-page-title">Cookie Policy</h1>
      <p className="site-page-sub">Last updated {new Date().toLocaleDateString('en-GB', { year: 'numeric', month: 'long' })}</p>

      <p>
        ScholarshipEngine uses a small number of cookies. This page lists every one, what it
        does, and how long it lasts. There is no cookie here that tracks you across other
        websites.
      </p>

      <h2>Strictly necessary</h2>
      <p>These keep the site and the paywall working. They cannot be switched off.</p>
      <dl className="about-list">
        <dt>sch_access</dt>
        <dd>Proves you have paid access, once you have. Signed, httpOnly, expires when your plan does.</dd>

        <dt>sch_q</dt>
        <dd>Counts how many free scholarship pages you have opened this month, so the limit resets on the 1st rather than never. Signed, httpOnly.</dd>

        <dt>wraith_refresh / wraith_csrf</dt>
        <dd>Admin session and CSRF protection — only set for staff logged into the admin panel, never for readers of the public site.</dd>

        <dt>cf_clearance</dt>
        <dd>Set by Cloudflare when it verifies you are not a bot. Not set by us and not read by our application code.</dd>
      </dl>

      <h2>Advertising</h2>
      <p>
        Free-tier readers see ads to keep the site free. Depending on what is being served,
        that can include a cookie from our ad network (currently Google AdSense) used to
        select and measure ads. Premium readers never see ads and this cookie is never set
        for them.
      </p>

      <h2>Your choice</h2>
      <p>
        The banner shown on your first visit lets you accept or reject the advertising
        cookie. Rejecting it does not block the site — the strictly necessary cookies above
        keep working regardless, because the product depends on them (there are no
        password-based accounts; the access cookie is how paid status is remembered at all).
      </p>
      <p>
        To change your choice, clear your browser&rsquo;s site data for this domain and reload —
        the banner will reappear.
      </p>

      <h2>Contact</h2>
      <p>
        Questions about this policy: <a href="mailto:support@wisdombusara.com">support@wisdombusara.com</a>
      </p>
    </div>
  );
}
