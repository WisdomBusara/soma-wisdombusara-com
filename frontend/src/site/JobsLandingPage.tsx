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
        <div className="hero-eyebrow">From the team behind Wisdom Busara Scholarships</div>
        <h1 className="hero-title">
          Stop refreshing job sites. <em>Let the jobs come to you.</em>
        </h1>
        <p className="hero-sub">
          Every night, we go through employer career pages and government tender portals across
          Kenya and pull out what's new. By the time you wake up, it's already sitting in your
          WhatsApp — no account to create, no app to install, nothing to search through.
        </p>
        <div className="hero-actions">
          <WhatsAppCta className="btn hero-cta">Start on WhatsApp →</WhatsAppCta>
          <a href="#how" className="hero-link">See how it works →</a>
        </div>
        {trial && (
          <div className="hero-note">
            First {durationLabel(trial.durationMinutes)} on us for {trial.currency} {trial.amount.toLocaleString()} — see a real digest before you commit.
          </div>
        )}
      </section>

      {overview && (
        <section className="stat-band">
          <div>
            <strong>{overview.jobs.sourceCount + overview.tenders.sourceCount}</strong>
            <span>employer &amp; government sites monitored</span>
          </div>
          <div>
            <strong>{overview.jobs.itemCount.toLocaleString()}</strong>
            <span>job openings catalogued</span>
          </div>
          <div>
            <strong>{overview.tenders.itemCount.toLocaleString()}</strong>
            <span>tenders catalogued</span>
          </div>
          <div>
            <strong>Daily</strong>
            <span>WhatsApp digest, every morning</span>
          </div>
        </section>
      )}

      <section className="feature" id="how">
        <div className="feature-label">Jobs</div>
        <h2 className="feature-title">We read the career pages so you don't have to.</h2>
        <p className="feature-body">
          Most openings at banks, insurers and telcos are posted quietly on the company's own
          careers page and never make it to the big job boards. Our crawler visits those pages
          every night, picks out what's genuinely new, and packages it into one message.
        </p>
        <ul className="feature-list">
          <li>Focused on banking, insurance and telecom employers today, with more sectors on the way</li>
          <li>Duplicate postings across sites are merged into a single line</li>
          <li>One short digest a day, not a stream of one-off alerts</li>
        </ul>
      </section>

      <section className="feature alt">
        <div className="feature-label">Tenders</div>
        <h2 className="feature-title">Public and corporate tenders, watched on their own clock.</h2>
        <p className="feature-body">
          Tenders live and die by their closing dates, so they get their own separate digest.
          Each entry carries the closing date and a short line on the scope, taken straight from
          the original notice, so you can tell at a glance whether it's worth a closer look.
        </p>
        <ul className="feature-list">
          <li>Closing dates called out clearly, so nothing quietly expires on you</li>
          <li>A separate subscription from the jobs feed — take one, or both</li>
        </ul>
      </section>

      <section className="feature" id="pricing">
        <div className="feature-label">Pricing</div>
        <h2 className="feature-title">Two feeds. Subscribe to what you actually need.</h2>
        <p className="feature-body">
          Jobs and tenders are billed separately, so you're never paying for a feed you don't
          use. Message us on WhatsApp to pick a plan — payment is by M-Pesa or card, handled
          right there in the chat, and access opens up the moment it clears.
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
          <WhatsAppCta className="btn">View plans on WhatsApp</WhatsAppCta>
        </div>
        <p className="pricing-note">M-Pesa or card — the whole transaction happens inside the chat.</p>
      </section>

      <section className="closing">
        <h2>Someone else is already reading the boards for you.<br />Might as well make it official.</h2>
        <WhatsAppCta className="btn hero-cta">Start on WhatsApp →</WhatsAppCta>
      </section>
    </div>
  );
}
