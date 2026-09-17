import nodemailer, { type Transporter } from 'nodemailer';
import { env } from '../../../config/env';
import { logger } from '../../../config/logger';

/**
 * Email delivery channel.
 *
 * Uses SMTP (Brevo, Resend, or any provider) via nodemailer. Configured through
 * env: SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, EMAIL_FROM. Disabled and a
 * no-op if SMTP is not configured, so the rest of the system runs without it.
 *
 * This is the safest delivery channel — no phone number, no platform that bans
 * automation, works the day it is configured.
 */

let transporter: Transporter | null = null;
let transporterFailed = false;

function getTransporter(): Transporter | null {
  if (transporterFailed) return null;
  if (transporter) return transporter;
  if (!env.SMTP_HOST || !env.SMTP_USER || !env.SMTP_PASS) {
    return null; // not configured — email delivery is simply off
  }
  try {
    transporter = nodemailer.createTransport({
      host: env.SMTP_HOST,
      port: env.SMTP_PORT ?? 587,
      secure: (env.SMTP_PORT ?? 587) === 465,
      auth: { user: env.SMTP_USER, pass: env.SMTP_PASS }
    });
    return transporter;
  } catch (err) {
    logger.error({ err }, 'scholarship-email: failed to create SMTP transport');
    transporterFailed = true;
    return null;
  }
}

export function emailConfigured(): boolean {
  return Boolean(env.SMTP_HOST && env.SMTP_USER && env.SMTP_PASS && env.EMAIL_FROM);
}

export interface EmailScholarship {
  id: string;
  title: string;
  university: string | null;
  country: string | null;
  deadline: string | null;
  fundingType: string;
  url: string;
}

function renderHtml(scholarships: EmailScholarship[], siteUrl: string): string {
  const rows = scholarships
    .map(
      (s) => `
      <tr>
        <td style="padding:14px 0;border-bottom:1px solid #e3ded2;">
          <a href="${siteUrl}/scholarships/${s.id}" style="color:#1f6f4a;font-weight:600;font-size:16px;text-decoration:none;">${escapeHtml(s.title)}</a>
          <div style="color:#6b6862;font-size:13px;margin-top:4px;">
            ${escapeHtml(s.university ?? s.country ?? '')}${s.country && s.university ? ` &middot; ${escapeHtml(s.country)}` : ''}
          </div>
          <div style="color:#45423d;font-size:13px;margin-top:6px;">
            ${s.fundingType !== 'UNKNOWN' ? `<span style="background:#e6f0ea;color:#1f6f4a;padding:2px 8px;border-radius:10px;font-size:12px;">${escapeHtml(prettyFunding(s.fundingType))}</span>` : ''}
            ${s.deadline ? `<span style="margin-left:8px;color:#b45309;">Closes ${new Date(s.deadline).toLocaleDateString()}</span>` : ''}
          </div>
        </td>
      </tr>`
    )
    .join('');

  return `
  <div style="font-family:Georgia,serif;max-width:600px;margin:0 auto;background:#faf9f6;padding:24px;">
    <h1 style="font-size:22px;color:#1a1a18;margin-bottom:4px;">New scholarships for you</h1>
    <p style="color:#6b6862;font-size:14px;margin-top:0;">Straight from the source, found overnight.</p>
    <table style="width:100%;border-collapse:collapse;">${rows}</table>
    <p style="color:#8a8781;font-size:12px;margin-top:24px;">
      You are receiving this because you subscribed at <a href="${siteUrl}" style="color:#1f6f4a;">Wisdom Busara</a>.
      Always confirm details on the official page before applying.
    </p>
  </div>`;
}

function renderText(scholarships: EmailScholarship[], siteUrl: string): string {
  return (
    `New scholarships for you\n\n` +
    scholarships
      .map(
        (s) =>
          `• ${s.title}\n  ${s.university ?? s.country ?? ''}${s.deadline ? `\n  Closes: ${new Date(s.deadline).toLocaleDateString()}` : ''}\n  ${siteUrl}/scholarships/${s.id}`
      )
      .join('\n\n') +
    `\n\nYou subscribed at ${siteUrl}. Confirm details on the official page before applying.`
  );
}

export async function sendScholarshipEmail(
  to: string,
  scholarships: EmailScholarship[]
): Promise<{ ok: boolean; error?: string }> {
  const t = getTransporter();
  if (!t || !env.EMAIL_FROM) return { ok: false, error: 'email_not_configured' };
  if (scholarships.length === 0) return { ok: true };

  const siteUrl = (env.SCHOLARSHIP_SITE_URL ?? '').replace(/\/$/, '');
  try {
    await t.sendMail({
      from: env.EMAIL_FROM,
      to,
      subject: `${scholarships.length} new scholarship${scholarships.length === 1 ? '' : 's'} — Wisdom Busara`,
      text: renderText(scholarships, siteUrl),
      html: renderHtml(scholarships, siteUrl)
    });
    return { ok: true };
  } catch (err: any) {
    logger.error({ err, to }, 'scholarship-email: send failed');
    return { ok: false, error: String(err?.message ?? 'send_failed') };
  }
}

/** A one-off welcome email confirming a new subscription. */
export async function sendWelcomeEmail(to: string, restoreCode?: string): Promise<{ ok: boolean; error?: string }> {
  const t = getTransporter();
  if (!t || !env.EMAIL_FROM) return { ok: false, error: 'email_not_configured' };
  const siteUrl = (env.SCHOLARSHIP_SITE_URL ?? '').replace(/\/$/, '');
  try {
    await t.sendMail({
      from: env.EMAIL_FROM,
      to,
      subject: 'You are subscribed — Wisdom Busara Scholarships',
      html: `
      <div style="font-family:Georgia,serif;max-width:600px;margin:0 auto;background:#faf9f6;padding:24px;">
        <h1 style="font-size:22px;color:#1a1a18;">You are in.</h1>
        <p style="color:#45423d;font-size:15px;line-height:1.6;">
          You will now receive new scholarships by email as our engine finds them.
        </p>
        ${restoreCode ? `<div style="background:#fff;border:1px dashed #1f6f4a;border-radius:12px;padding:18px;margin:18px 0;">
          <div style="color:#6b6862;font-size:12px;text-transform:uppercase;letter-spacing:0.5px;">Your restore code</div>
          <div style="font-family:monospace;font-size:26px;font-weight:700;letter-spacing:4px;color:#1f6f4a;">${escapeHtml(restoreCode)}</div>
          <p style="color:#6b6862;font-size:13px;">Keep this to restore access on another device.</p>
        </div>` : ''}
        <a href="${siteUrl}/scholarships" style="display:inline-block;background:#1f6f4a;color:#fff;padding:12px 24px;border-radius:999px;text-decoration:none;font-family:sans-serif;">Browse scholarships</a>
      </div>`,
      text: `You are subscribed to Wisdom Busara scholarships.${restoreCode ? `\n\nYour restore code: ${restoreCode}\nKeep it to restore access on another device.` : ''}\n\n${siteUrl}/scholarships`
    });
    return { ok: true };
  } catch (err: any) {
    logger.error({ err, to }, 'scholarship-email: welcome send failed');
    return { ok: false, error: String(err?.message ?? 'send_failed') };
  }
}

// ── helpers ──────────────────────────────────────────────────────────────────

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
}

function prettyFunding(t: string): string {
  const map: Record<string, string> = {
    FULLY_FUNDED: 'Fully funded',
    PARTIAL: 'Partial funding',
    TUITION_ONLY: 'Tuition only',
    STIPEND_ONLY: 'Stipend only',
    FEE_WAIVER: 'Fee waiver'
  };
  return map[t] ?? t.replace(/_/g, ' ').toLowerCase();
}
