import { env } from '../../config/env';
import { logger } from '../../config/logger';
import { AdSlotModel, type AdPlacement } from '../../models/scholarship/access';

/**
 * Ad serving.
 *
 * Two supply types, chosen per slot from the admin:
 *
 *   HOUSE / CUSTOM — served from our own database. Full control, no third-party
 *                    script, no tracking cookies, and it works on day one when
 *                    there is no network fill.
 *   NETWORK        — a slot id handed to an ad network's script (AdSense).
 *                    Configured globally via ADS_NETWORK_CLIENT_ID.
 *
 * Premium readers never reach this module — the route checks tier first. That
 * is the entire value proposition of the paid tier, so it is enforced at the
 * boundary rather than as a rendering detail.
 */

export interface ServedAd {
  id: string;
  type: 'HOUSE' | 'NETWORK' | 'CUSTOM';
  placement: string;
  headline?: string;
  body?: string;
  ctaLabel?: string;
  imageUrl?: string;
  /** Click-through goes via our redirect so clicks can be counted */
  clickUrl?: string;
  advertiser?: string;
  networkSlotId?: string;
  networkClientId?: string;
  html?: string;
}

export interface AdContext {
  placement: AdPlacement;
  countryCode?: string | null;
  degreeLevel?: string | null;
}

/**
 * Weighted random pick.
 *
 * Weighted rather than round-robin so an advertiser who pays more genuinely
 * gets more delivery, and so a house ad can be given weight 1 as filler behind
 * a weight-20 paid placement.
 */
function pickWeighted<T extends { weight?: number }>(items: T[]): T | null {
  if (items.length === 0) return null;
  const total = items.reduce((sum, i) => sum + Math.max(0, i.weight ?? 1), 0);
  if (total <= 0) return items[0];
  let r = Math.random() * total;
  for (const item of items) {
    r -= Math.max(0, item.weight ?? 1);
    if (r <= 0) return item;
  }
  return items[items.length - 1];
}

/**
 * Select an ad for a placement.
 *
 * Returns null when ads are disabled, nothing is booked, or nothing targets
 * this context — the frontend then renders nothing at all rather than an empty
 * box, which is the difference between a clean page and a broken-looking one.
 */
export async function serveAd(ctx: AdContext): Promise<ServedAd | null> {
  if (!env.ADS_ENABLED) return null;

  const now = new Date();
  const candidates = await AdSlotModel.find({
    placement: ctx.placement,
    isActive: true,
    $and: [
      { $or: [{ startsAt: null }, { startsAt: { $exists: false } }, { startsAt: { $lte: now } }] },
      { $or: [{ endsAt: null }, { endsAt: { $exists: false } }, { endsAt: { $gte: now } }] }
    ]
  })
    .limit(50)
    .lean();

  if (candidates.length === 0) return null;

  // Empty targeting array means "everywhere" — an unset filter must never
  // exclude, or a newly created ad would silently never serve.
  const targeted = candidates.filter((ad) => {
    if (ad.countries?.length && ctx.countryCode && !ad.countries.includes(ctx.countryCode)) return false;
    if (ad.degreeLevels?.length && ctx.degreeLevel && !ad.degreeLevels.includes(ctx.degreeLevel)) return false;
    return true;
  });

  const chosen = pickWeighted(targeted.length > 0 ? targeted : candidates);
  if (!chosen) return null;

  // Impression counting is fire-and-forget. An ad served but not counted is a
  // reporting inaccuracy; a request blocked on a counter write is an outage.
  void AdSlotModel.updateOne({ _id: chosen._id }, { $inc: { impressions: 1 } }).catch((err) =>
    logger.debug({ err }, 'ads: impression increment failed')
  );

  return {
    id: String(chosen._id),
    type: chosen.type as ServedAd['type'],
    placement: chosen.placement,
    headline: chosen.headline ?? undefined,
    body: chosen.body ?? undefined,
    ctaLabel: chosen.ctaLabel ?? undefined,
    imageUrl: chosen.imageUrl ?? undefined,
    advertiser: chosen.advertiser ?? undefined,
    clickUrl: chosen.targetUrl ? `/api/ads/${String(chosen._id)}/click` : undefined,
    networkSlotId: chosen.networkSlotId ?? undefined,
    networkClientId: chosen.type === 'NETWORK' ? env.ADS_NETWORK_CLIENT_ID : undefined,
    html: chosen.type === 'CUSTOM' ? chosen.html ?? undefined : undefined
  };
}

/**
 * Record a click and hand back the destination.
 *
 * The destination is re-read from the database rather than taken from the
 * request, so this endpoint can never be turned into an open redirect.
 */
export async function recordClick(adId: string): Promise<string | null> {
  const ad = await AdSlotModel.findByIdAndUpdate(
    adId,
    { $inc: { clicks: 1 } },
    { new: true }
  )
    .select('targetUrl')
    .lean();
  if (!ad?.targetUrl) return null;
  try {
    const url = new URL(ad.targetUrl);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    return url.href;
  } catch {
    return null;
  }
}
