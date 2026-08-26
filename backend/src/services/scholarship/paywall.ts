import crypto from 'crypto';
import type { Request, Response, NextFunction } from 'express';
import { env } from '../../config/env';
import { ScholarshipAccessModel } from '../../models/scholarship/access';

/**
 * Paywall (freemium, metered).
 *
 * The product shape, and why:
 *
 *   Anonymous / free  — full search, full listings, a limited number of detail
 *                       views per month, ads shown.
 *   Premium           — unlimited detail views, the matching engine, no ads.
 *
 * Listings stay open on purpose. A scholarship index that search engines cannot
 * crawl has no audience, and an applicant who cannot see what exists will not
 * pay to see more. The paywall sits at *depth of use*, not at the front door.
 *
 * There are no passwords and no accounts. Payment issues a signed token in an
 * httpOnly cookie plus a short restore code, which is the least friction that
 * still works across devices.
 */

export const ACCESS_COOKIE = 'sch_access';
export const QUOTA_COOKIE = 'sch_q';

export type Tier = 'free' | 'premium';

export interface AccessContext {
  tier: Tier;
  accessId?: string;
  endsAt?: Date;
  /** Detail views used this calendar month (free tier only) */
  used: number;
  limit: number;
  remaining: number;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      access?: AccessContext;
    }
  }
}

// ── Signing ─────────────────────────────────────────────────────────────────

/**
 * Signed with a paywall-specific key derived from JWT_ACCESS_SECRET rather than
 * the secret itself, so a reader's browsing token can never be confused with an
 * admin session token even if one is replayed at the other endpoint.
 */
const PAYWALL_KEY = crypto
  .createHmac('sha256', env.JWT_ACCESS_SECRET)
  .update('scholarship-paywall-v1')
  .digest();

function sign(payload: string): string {
  return crypto.createHmac('sha256', PAYWALL_KEY).update(payload).digest('base64url');
}

function pack(obj: Record<string, unknown>): string {
  const body = Buffer.from(JSON.stringify(obj)).toString('base64url');
  return `${body}.${sign(body)}`;
}

function unpack<T>(token: string | undefined): T | null {
  if (!token || !token.includes('.')) return null;
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  const expected = sign(body);
  // Constant-time compare — a timing oracle here would let someone forge access
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    return JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as T;
  } catch {
    return null;
  }
}

// ── Access tokens ───────────────────────────────────────────────────────────

interface AccessToken {
  id: string;
  exp: number;
}

export function issueAccessToken(accessId: string, endsAt: Date): string {
  return pack({ id: accessId, exp: Math.floor(endsAt.getTime() / 1000) } satisfies AccessToken);
}

export function setAccessCookie(res: Response, token: string, endsAt: Date): void {
  res.cookie(ACCESS_COOKIE, token, {
    httpOnly: true,
    secure: env.COOKIE_SECURE,
    sameSite: (env.COOKIE_SAMESITE?.toLowerCase() as 'lax' | 'strict' | 'none') ?? 'lax',
    expires: endsAt,
    path: '/'
  });
}

export function clearAccessCookie(res: Response): void {
  res.clearCookie(ACCESS_COOKIE, { path: '/' });
}

// ── Restore codes ───────────────────────────────────────────────────────────

/**
 * Six characters, uppercase, ambiguous glyphs removed (no O/0, I/1).
 * Short enough to read over the phone, long enough that guessing is pointless
 * given it is scoped to a single email/phone lookup.
 */
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function generateRestoreCode(): string {
  const bytes = crypto.randomBytes(6);
  return Array.from(bytes).map((b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
}

export function hashRestoreCode(code: string): string {
  return crypto.createHmac('sha256', PAYWALL_KEY).update(code.trim().toUpperCase()).digest('hex');
}

// ── Free-tier metering ──────────────────────────────────────────────────────

interface QuotaCookie {
  m: string; // "2026-08"
  n: number;
  /** Ids already counted this month, so a reload or a back-button is free */
  s: string[];
}

function currentMonth(now = new Date()): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
}

function readQuota(req: Request): QuotaCookie {
  const parsed = unpack<QuotaCookie>(req.cookies?.[QUOTA_COOKIE]);
  const month = currentMonth();
  // A tampered or stale cookie resets rather than errors — the downside of a
  // free extra view is trivial next to blocking a legitimate reader.
  if (!parsed || parsed.m !== month || !Array.isArray(parsed.s)) {
    return { m: month, n: 0, s: [] };
  }
  return parsed;
}

function writeQuota(res: Response, quota: QuotaCookie): void {
  const expires = new Date();
  expires.setUTCMonth(expires.getUTCMonth() + 2);
  res.cookie(QUOTA_COOKIE, pack(quota as unknown as Record<string, unknown>), {
    httpOnly: true,
    secure: env.COOKIE_SECURE,
    sameSite: 'lax',
    expires,
    path: '/'
  });
}

/**
 * Count a detail view against the free allowance.
 *
 * Re-viewing the same scholarship is free — charging twice for the same page
 * punishes normal behaviour (opening a tab, coming back tomorrow) and produces
 * angry users rather than paying ones. Only distinct records count.
 *
 * Returns whether the view is allowed.
 */
export function consumeFreeView(req: Request, res: Response, scholarshipId: string): boolean {
  if (req.access?.tier === 'premium') return true;

  const quota = readQuota(req);
  if (quota.s.includes(scholarshipId)) return true;

  if (quota.n >= env.SCHOLARSHIP_FREE_VIEWS_PER_MONTH) return false;

  quota.n += 1;
  quota.s.push(scholarshipId);
  // Bound the cookie — keep only the ids we still need to recognise
  if (quota.s.length > env.SCHOLARSHIP_FREE_VIEWS_PER_MONTH) {
    quota.s = quota.s.slice(-env.SCHOLARSHIP_FREE_VIEWS_PER_MONTH);
  }
  writeQuota(res, quota);
  if (req.access) {
    req.access.used = quota.n;
    req.access.remaining = Math.max(0, env.SCHOLARSHIP_FREE_VIEWS_PER_MONTH - quota.n);
  }
  return true;
}

// ── Middleware ──────────────────────────────────────────────────────────────

/**
 * Resolve the reader's tier onto `req.access`.
 *
 * Never rejects. A failed lookup degrades to the free tier, because a database
 * blip must not take the public site down — it should quietly show ads instead.
 */
export async function resolveAccess(req: Request, _res: Response, next: NextFunction): Promise<void> {
  const limit = env.SCHOLARSHIP_FREE_VIEWS_PER_MONTH;
  const quota = readQuota(req);
  const base: AccessContext = {
    tier: 'free',
    used: quota.n,
    limit,
    remaining: Math.max(0, limit - quota.n)
  };

  const token = unpack<AccessToken>(req.cookies?.[ACCESS_COOKIE]);
  if (!token || token.exp * 1000 < Date.now()) {
    req.access = base;
    return next();
  }

  try {
    const grant = await ScholarshipAccessModel.findById(token.id)
      .select('status endsAt')
      .lean();
    if (grant && grant.status === 'active' && new Date(grant.endsAt).getTime() > Date.now()) {
      req.access = {
        tier: 'premium',
        accessId: String(grant._id),
        endsAt: grant.endsAt,
        used: 0,
        limit: Infinity,
        remaining: Infinity
      };
      // Fire-and-forget: last-seen is analytics, never worth blocking a request
      void ScholarshipAccessModel.updateOne({ _id: token.id }, { $set: { lastSeenAt: new Date() } }).catch(() => undefined);
      return next();
    }
  } catch {
    /* fall through to free */
  }

  req.access = base;
  return next();
}

/** Hard gate for premium-only endpoints (the matcher). */
export function requirePremium(req: Request, res: Response, next: NextFunction): void {
  if (req.access?.tier === 'premium') return next();
  res.status(402).json({
    error: 'premium_required',
    message: 'This feature is available on a paid plan.',
    upgradeUrl: '/upgrade'
  });
}

/** Public shape of the reader's entitlement, safe to send to the browser. */
export function accessSummary(req: Request): Record<string, unknown> {
  const a = req.access;
  if (!a) return { tier: 'free', used: 0, limit: env.SCHOLARSHIP_FREE_VIEWS_PER_MONTH, remaining: env.SCHOLARSHIP_FREE_VIEWS_PER_MONTH, adsEnabled: true };
  return {
    tier: a.tier,
    used: a.tier === 'premium' ? 0 : a.used,
    limit: a.tier === 'premium' ? null : a.limit,
    remaining: a.tier === 'premium' ? null : a.remaining,
    endsAt: a.endsAt ?? null,
    adsEnabled: a.tier !== 'premium' && env.ADS_ENABLED
  };
}
