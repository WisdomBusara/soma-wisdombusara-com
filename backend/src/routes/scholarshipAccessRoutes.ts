import crypto from 'crypto';
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';

import { env } from '../config/env';
import { logger } from '../config/logger';
import { PlanModel } from '../models/Plan';
import { PaymentModel } from '../models/Payment';
import { ScholarshipAccessModel } from '../models/scholarship/access';
import { AD_PLACEMENTS } from '../models/scholarship/access';
import { initializeTransaction, chargeMpesa, verifyTransaction } from '../services/paystack';
import { serveAd, recordClick } from '../services/scholarship/ads';
import {
  issueAccessToken, setAccessCookie, clearAccessCookie,
  generateRestoreCode, hashRestoreCode, accessSummary
} from '../services/scholarship/paywall';

/**
 * Checkout, access restore, and ad delivery.
 *
 * Mounted inside the public /api router so it inherits that router's permissive
 * CORS and rate limit, with tighter per-route limits on the endpoints that cost
 * money or send messages.
 *
 * Payment flow deliberately mirrors the WhatsApp bot's: create a Payment row
 * first, then hand off to Paystack, then let the *webhook* grant access. The
 * browser is never trusted to confirm its own payment — the client-side verify
 * endpoint is a convenience for instant feedback and re-verifies with Paystack
 * server-side before doing anything.
 */

const KENYAN_PHONE = /^(?:\+?254|0)?(7\d{8}|1\d{8})$/;

/** Normalize any Kenyan input to the 2547XXXXXXXX form Paystack expects. */
function normalizePhone(raw: string): string | null {
  const digits = String(raw ?? '').replace(/[^\d+]/g, '');
  const m = KENYAN_PHONE.exec(digits);
  if (!m) return null;
  return `254${m[1]}`;
}

function reference(): string {
  return `sch_${Date.now().toString(36)}_${crypto.randomBytes(5).toString('hex')}`;
}

/**
 * Paystack requires an email. Readers paying by M-Pesa usually have not given
 * one, so we synthesise a stable, clearly-namespaced placeholder rather than
 * blocking checkout on a field the payment method does not need.
 */
function emailFor(input: { email?: string; phone?: string }): string {
  if (input.email) return input.email.toLowerCase();
  return `${input.phone}@mpesa.scholarships.local`;
}

export function scholarshipAccessRouter() {
  const router = Router();

  const payLimiter = rateLimit({ windowMs: 60_000, limit: 8, standardHeaders: 'draft-7', legacyHeaders: false });
  const restoreLimiter = rateLimit({ windowMs: 300_000, limit: 6, standardHeaders: 'draft-7', legacyHeaders: false });

  // ── Entitlement ───────────────────────────────────────────────────────────

  router.get('/access/me', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    return res.json(accessSummary(req));
  });

  router.post('/access/signout', (_req, res) => {
    clearAccessCookie(res);
    return res.json({ ok: true });
  });

  // ── Plans ─────────────────────────────────────────────────────────────────

  /**
   * Plans come from the database, so pricing is changed in the admin and the
   * site follows — no redeploy to run a promotion.
   */
  router.get('/access/plans', async (_req, res, next) => {
    try {
      const plans = await PlanModel.find({ isActive: true }).sort({ amountKobo: 1 }).lean();
      res.setHeader('Cache-Control', 'public, max-age=120');
      return res.json({
        plans: plans.map((p) => ({
          id: String(p._id),
          name: p.name,
          description: p.description ?? null,
          amount: p.amountKobo / 100,
          amountKobo: p.amountKobo,
          currency: p.currency,
          durationMinutes: p.durationMinutes,
          durationLabel: humanDuration(p.durationMinutes)
        })),
        freeViewsPerMonth: env.SCHOLARSHIP_FREE_VIEWS_PER_MONTH
      });
    } catch (err) { return next(err); }
  });

  // ── Checkout ──────────────────────────────────────────────────────────────

  const checkoutSchema = z.object({
    planId: z.string().min(1),
    method: z.enum(['mpesa', 'card']),
    phone: z.string().max(20).optional(),
    email: z.string().email().max(160).optional()
  });

  router.post('/access/checkout', payLimiter, async (req, res, next) => {
    try {
      const body = checkoutSchema.parse(req.body ?? {});

      const plan = await PlanModel.findOne({ _id: body.planId, isActive: true }).lean();
      if (!plan) return res.status(404).json({ error: 'Plan not found' });

      let phone: string | undefined;
      if (body.method === 'mpesa') {
        const normalized = body.phone ? normalizePhone(body.phone) : null;
        if (!normalized) {
          return res.status(400).json({ error: 'invalid_phone', message: 'Enter a valid Kenyan phone number, e.g. 0712 345 678.' });
        }
        phone = normalized;
      } else if (!body.email) {
        return res.status(400).json({ error: 'email_required', message: 'An email address is needed for card payment.' });
      }

      const ref = reference();
      const email = emailFor({ email: body.email, phone });

      // The ledger row exists before money moves, so a webhook can never arrive
      // for a payment we have no record of.
      await PaymentModel.create({
        reference: ref,
        planId: plan._id,
        email,
        amountKobo: plan.amountKobo,
        currency: plan.currency,
        status: 'initialized',
        platform: 'web',
        vertical: 'scholarships',
        whatsappPhone: phone
      });

      if (body.method === 'mpesa') {
        const charge = await chargeMpesa({
          amountKobo: plan.amountKobo,
          email,
          phone: phone!,
          reference: ref,
          metadata: { vertical: 'scholarships', planId: String(plan._id), phone }
        });
        return res.json({
          method: 'mpesa',
          reference: ref,
          status: charge.chargeStatus,
          message: 'Check your phone for the M-Pesa prompt and enter your PIN.'
        });
      }

      const init = await initializeTransaction({
        amountKobo: plan.amountKobo,
        email,
        reference: ref,
        currency: plan.currency,
        callbackUrl: `${env.PAYSTACK_CALLBACK_BASE_URL}/upgrade/complete?ref=${ref}`,
        metadata: { vertical: 'scholarships', planId: String(plan._id) }
      });
      return res.json({ method: 'card', reference: ref, authorizationUrl: init.authorizationUrl });
    } catch (err: any) {
      if (err?.status === 502) {
        return res.status(502).json({ error: 'payment_provider', message: 'The payment provider is unavailable. Please try again shortly.' });
      }
      return next(err);
    }
  });

  /**
   * Poll after checkout.
   *
   * Re-verifies with Paystack rather than trusting the client. The webhook is
   * still the authoritative grant path — this endpoint exists so the reader
   * gets their access in two seconds instead of waiting on webhook latency, and
   * it is written to be idempotent with the webhook.
   */
  router.get('/access/status/:reference', payLimiter, async (req, res, next) => {
    try {
      const ref = String(req.params.reference);
      const payment = await PaymentModel.findOne({ reference: ref, vertical: 'scholarships' });
      if (!payment) return res.status(404).json({ error: 'Unknown reference' });

      if (payment.status !== 'paid') {
        const verified = await verifyTransaction(ref).catch(() => null);
        if (!verified || verified.status !== 'success') {
          return res.json({ status: payment.status === 'failed' ? 'failed' : 'pending' });
        }
        if (verified.amountKobo !== payment.amountKobo) {
          logger.warn({ ref }, 'scholarship: payment amount mismatch');
          return res.json({ status: 'pending' });
        }
        payment.status = 'paid';
        await payment.save();
      }

      const granted = await grantAccessForPayment(ref);
      if (!granted) return res.json({ status: 'pending' });

      setAccessCookie(res, issueAccessToken(granted.id, granted.endsAt), granted.endsAt);
      res.setHeader('Cache-Control', 'no-store');
      return res.json({
        status: 'paid',
        endsAt: granted.endsAt,
        restoreCode: granted.restoreCode,
        planName: granted.planName
      });
    } catch (err) { return next(err); }
  });

  // ── Restore on another device ─────────────────────────────────────────────

  router.post('/access/restore', restoreLimiter, async (req, res, next) => {
    try {
      const body = z.object({ code: z.string().min(4).max(16) }).parse(req.body ?? {});
      const grant = await ScholarshipAccessModel.findOne({
        restoreCodeHash: hashRestoreCode(body.code),
        status: 'active',
        endsAt: { $gt: new Date() }
      }).lean();

      if (!grant) {
        // Same response shape and timing for wrong code vs expired grant — no
        // oracle for probing which codes exist.
        return res.status(404).json({ error: 'invalid_code', message: 'That code is not valid or has expired.' });
      }

      await ScholarshipAccessModel.updateOne({ _id: grant._id }, { $inc: { deviceCount: 1 }, $set: { lastSeenAt: new Date() } });
      setAccessCookie(res, issueAccessToken(String(grant._id), grant.endsAt), grant.endsAt);
      res.setHeader('Cache-Control', 'no-store');
      return res.json({ ok: true, endsAt: grant.endsAt, planName: grant.planName ?? null });
    } catch (err) { return next(err); }
  });

  // ── Ads ───────────────────────────────────────────────────────────────────

  router.get('/ads', async (req, res, next) => {
    try {
      // Premium readers are why the paid tier exists. Checked here, not in the
      // component, so it cannot be bypassed by calling the API directly.
      if (req.access?.tier === 'premium' || !env.ADS_ENABLED) {
        res.setHeader('Cache-Control', 'no-store');
        return res.json({ ad: null });
      }
      const q = z.object({
        placement: z.enum(AD_PLACEMENTS),
        country: z.string().max(2).optional(),
        degree: z.string().max(30).optional()
      }).parse(req.query);

      const ad = await serveAd({
        placement: q.placement,
        countryCode: q.country?.toUpperCase() ?? null,
        degreeLevel: q.degree?.toUpperCase() ?? null
      });
      res.setHeader('Cache-Control', 'no-store');
      return res.json({ ad });
    } catch (err) { return next(err); }
  });

  router.get('/ads/:id/click', async (req, res, next) => {
    try {
      const target = await recordClick(String(req.params.id));
      if (!target) return res.status(404).send('Not found');
      return res.redirect(302, target);
    } catch (err) { return next(err); }
  });

  return router;
}

// ── Fulfilment ──────────────────────────────────────────────────────────────

function humanDuration(minutes: number): string {
  if (minutes >= 43_200) {
    const months = Math.round(minutes / 43_200);
    return `${months} month${months === 1 ? '' : 's'}`;
  }
  if (minutes >= 1_440) {
    const days = Math.round(minutes / 1_440);
    return `${days} day${days === 1 ? '' : 's'}`;
  }
  const hours = Math.round(minutes / 60);
  return `${hours} hour${hours === 1 ? '' : 's'}`;
}

export interface GrantResult {
  id: string;
  endsAt: Date;
  planName: string;
  /** Only returned on first creation — never re-shown for an existing grant */
  restoreCode?: string;
}

/**
 * Turn a paid Payment into a ScholarshipAccess grant.
 *
 * Idempotent by paystackReference: the webhook and the client poll both call
 * this and exactly one grant results. Exported so the Paystack webhook can
 * reuse it rather than reimplementing fulfilment.
 */
export async function grantAccessForPayment(ref: string): Promise<GrantResult | null> {
  const payment = await PaymentModel.findOne({ reference: ref }).lean();
  if (!payment || payment.status !== 'paid') return null;

  const existing = await ScholarshipAccessModel.findOne({ paystackReference: ref }).lean();
  if (existing) {
    return { id: String(existing._id), endsAt: existing.endsAt, planName: existing.planName ?? '' };
  }

  const plan = await PlanModel.findById(payment.planId).lean();
  if (!plan) {
    logger.error({ ref }, 'scholarship: paid payment has no plan');
    return null;
  }

  const now = new Date();
  const endsAt = new Date(now.getTime() + plan.durationMinutes * 60_000);
  const restoreCode = generateRestoreCode();

  try {
    const grant = await ScholarshipAccessModel.create({
      email: payment.email?.endsWith('@mpesa.scholarships.local') ? undefined : payment.email,
      phone: payment.whatsappPhone ?? undefined,
      planId: plan._id,
      planName: plan.name,
      startsAt: now,
      endsAt,
      status: 'active',
      paystackReference: ref,
      amountKobo: payment.amountKobo,
      currency: payment.currency,
      restoreCodeHash: hashRestoreCode(restoreCode),
      restoreCodeSentAt: now,
      source: 'web'
    });
    logger.info({ ref, plan: plan.name }, 'scholarship: web access granted');
    return { id: String(grant._id), endsAt, planName: plan.name, restoreCode };
  } catch (err: any) {
    // Lost a race with the webhook — re-read rather than fail the reader
    const winner = await ScholarshipAccessModel.findOne({ paystackReference: ref }).lean();
    if (winner) return { id: String(winner._id), endsAt: winner.endsAt, planName: winner.planName ?? '' };
    logger.error({ err, ref }, 'scholarship: access grant failed');
    return null;
  }
}
