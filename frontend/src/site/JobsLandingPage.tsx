import React from 'react';
import { publicMarketingFetch, durationLabel, type PublicPlan, type JobsOverview } from '../api/public';

/**
 * Jobs & Tenders landing page.
 *
 * Modeled on wraith.neithlogic.com's shape (hero → live stats → feed
 * descriptions → pricing → CTA), reusing LandingPage.tsx's own CSS classes —
 * its header comment already says it "follows the editorial rhythm of the
 * Wraith jobs site", so this page and that one are siblings by design.
 *
 * Unlike the scholarship site, there is no searchable listing page here on
 * purpose: delivery is WhatsApp-first. The backend's conversational flow
 * (backend/src/services/whatsappBotRunner.ts) already handles plan choice,
 * payment, and group access end-to-end — this page's only job is to explain
 * the product and hand the reader off to that chat.
 */

// Set once WAHA is connected and this number is live — until then the CTA
// shows "Launching soon" instead of linking anywhere. E.164 format, no '+'.
const WHATSAPP_NUMBER = (import.meta.env.VITE_JOBS_WHATSAPP_NUMBER as string | undefined) ?? '';

function WhatsAppCta({ className, children }: { className: string; children: React.ReactNode }) {
  if (!WHATSAPP_NUMBER) {
    return (
      <span className={className} aria-disabled="true" style={{ opacity: 0.5, cursor: 'not-allowed' }}>
        Launching soon
      </span>
    );
  }
  const href = `https://wa.me/${WHATSAPP_NUMBER}?text=${encodeURIComponent('hi')}`;
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className={className}>
      {children}
    </a>
  );
}

export function JobsLandingPage() {
  const [overview, setOverview] = React.useState<JobsOverview | null>(null);
  const [jobPlans, setJobPlans] = React.useState<PublicPlan[]>([]);
  const [tenderPlans, setTenderPlans] = React.useState<PublicPlan[]>([]);

  React.useEffect(() => {
    publicMarketingFetch<JobsOverview>('/jobs-overview').then(setOverview).catch(() => undefined);
    publicMarketingFetch<{ plans: PublicPlan[] }>('/plans?vertical=jobs')
      .then((r) => setJobPlans(r.plans))
      .catch(() => undefined);
    publicMarketingFetch<{ plans: PublicPlan[] }>('/plans?vertical=tenders')
      .then((r) => setTenderPlans(r.plans))
      .catch(() => undefined);
  }, []);

  const trial = [...jobPlans, ...tenderPlans].find((p) => p.isTrial);

  return (
    <div className="landing">
      <section className="hero">
        <div className="hero-eyebrow">A Wisdom Busara product</div>
        <h1 className="hero-title">
          The best jobs <em>never reach the job boards.</em>
        </h1>
        <p className="hero-sub">
          We watch company career pages and government tender portals every night, and deliver
          what's new straight to WhatsApp before the listing sites even notice it. No app, no
          search — just message us and the daily digest starts landing at dawn.
        </p>
        <div className="hero-actions">
          <WhatsAppCta className="btn hero-cta">Message us on WhatsApp →</WhatsAppCta>
          <a href="#how" className="hero-link">How it works →</a>
        </div>
        {trial && (
          <div className="hero-note">
            Try it for {trial.currency} {trial.amount.toLocaleString()} — {durationLabel(trial.durationMinutes)} full access.
          </div>
        )}
      </section>

      {overview && (
        <section className="stat-band">
          <div>
            <strong>{overview.jobs.sourceCount + overview.tenders.sourceCount}</strong>
            <span>sources watched nightly</span>
          </div>
          <div>
            <strong>{overview.jobs.itemCount.toLocaleString()}</strong>
            <span>jobs tracked</span>
          </div>
          <div>
            <strong>{overview.tenders.itemCount.toLocaleString()}</strong>
            <span>tenders tracked</span>
          </div>
          <div>
            <strong>07:00</strong>
            <span>daily delivery, EAT</span>
          </div>
        </section>
      )}

      <section className="feature" id="how">
        <div className="feature-label">01 · Jobs feed</div>
        <h2 className="feature-title">Straight from the careers page, not a job board.</h2>
        <p className="feature-body">
          Every night we check the career pages of banks, insurers and telcos directly — the
          postings that never make it to the big listing sites because nobody's paying to
          promote them there. New openings land in your WhatsApp the next morning at 07:00 EAT.
        </p>
        <ul className="feature-list">
          <li>Banking, insurance and telecom sources tracked today, more industries coming</li>
          <li>Deduplicated — the same posting on two pages is one message, not two</li>
          <li>Delivered as a digest, not a flood — read it in the time it takes to make tea</li>
        </ul>
      </section>

      <section className="feature alt">
        <div className="feature-label">02 · Tenders feed</div>
        <h2 className="feature-title">Government and corporate tenders, tracked separately.</h2>
        <p className="feature-body">
          Tenders move on their own schedule and close on deadlines that don't forgive a missed
          check — so they get their own digest, sent at 07:20 EAT, with the closing date and a
          short scope description pulled straight from the notice.
        </p>
        <ul className="feature-list">
          <li>Closing dates included, so nothing slips past you unnoticed</li>
          <li>Independent from the jobs feed — subscribe to either, or both</li>
        </ul>
      </section>

      <section className="feature" id="pricing">
        <div className="feature-label">03 · Access</div>
        <h2 className="feature-title">Jobs and tenders, priced separately.</h2>
        <p className="feature-body">
          Each feed is its own subscription — take the one you need, or both. Message us on
          WhatsApp to see current plans and pay by M-Pesa or card; access starts the moment
          payment lands.
        </p>
        <div className="honesty-grid">
          {jobPlans.map((p) => (
            <div key={p.id} className="honesty-item yes">
              <span>Jobs</span> {p.name} — {p.currency} {p.amount.toLocaleString()} / {durationLabel(p.durationMinutes)}
            </div>
          ))}
          {tenderPlans.map((p) => (
            <div key={p.id} className="honesty-item yes">
              <span>Tenders</span> {p.name} — {p.currency} {p.amount.toLocaleString()} / {durationLabel(p.durationMinutes)}
            </div>
          ))}
        </div>
        <div className="pricing-actions" style={{ marginTop: 20 }}>
          <WhatsAppCta className="btn">See plans on WhatsApp</WhatsAppCta>
        </div>
        <p className="pricing-note">Pay with M-Pesa or card, entirely inside the chat.</p>
      </section>

      <section className="closing">
        <h2>New listings land while you sleep.<br />Go find out what you missed.</h2>
        <WhatsAppCta className="btn hero-cta">Message us on WhatsApp →</WhatsAppCta>
      </section>
    </div>
  );
}
