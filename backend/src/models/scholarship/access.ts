import { Schema, model, type InferSchemaType } from 'mongoose';

/**
 * Web access + advertising models.
 *
 * Deliberately NOT reusing `Subscription`: that model is bot-centric (botId and
 * telegramUserId are required, and it manages group add/remove). A web reader
 * has neither. What IS reused is everything that matters commercially — the
 * `Plan` model, the `Payment` ledger, the Paystack service and the existing
 * signed webhook — so revenue stays in one place and reconciliation does not
 * fork.
 */

// ─────────────────────────────────────────────────────────────────────────────
// ScholarshipAccess — a paid grant for one reader
// ─────────────────────────────────────────────────────────────────────────────

const scholarshipAccessSchema = new Schema(
  {
    // At least one of these is present. Phone is the common case in Kenya
    // (M-Pesa), email the common case for card.
    email: { type: String, trim: true, lowercase: true, index: true },
    phone: { type: String, trim: true, index: true },

    planId: { type: Schema.Types.ObjectId, ref: 'Plan', required: true },
    planName: { type: String },

    startsAt: { type: Date, required: true, default: Date.now },
    endsAt: { type: Date, required: true, index: true },

    status: {
      type: String,
      enum: ['active', 'expired', 'refunded', 'revoked'],
      required: true,
      default: 'active',
      index: true
    },

    paystackReference: { type: String, index: true },
    amountKobo: { type: Number },
    currency: { type: String, default: 'KES' },

    /**
     * Short human-typeable code that restores access on another device.
     * Stored hashed — a database leak must not hand out live access.
     */
    restoreCodeHash: { type: String, index: true },
    restoreCodeSentAt: { type: Date },

    lastSeenAt: { type: Date },
    deviceCount: { type: Number, default: 0 },

    source: { type: String, default: 'web' }
  },
  { timestamps: true }
);

scholarshipAccessSchema.index({ status: 1, endsAt: 1 });
scholarshipAccessSchema.index({ email: 1, status: 1 });
scholarshipAccessSchema.index({ phone: 1, status: 1 });

export type ScholarshipAccess = InferSchemaType<typeof scholarshipAccessSchema>;
export const ScholarshipAccessModel = model('ScholarshipAccess', scholarshipAccessSchema);

// ─────────────────────────────────────────────────────────────────────────────
// AdSlot — house ads and network placements, managed from the admin
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Placements are a fixed vocabulary rather than free text so the frontend can
 * declare where an ad may appear and the admin can only target real positions.
 * Adding one means adding a component, so it should be a deliberate change.
 */
export const AD_PLACEMENTS = [
  'listing_inline',   // between result cards
  'listing_sidebar',  // under the filter panel
  'detail_sidebar',   // under the apply button
  'detail_footer',    // below the requirements
  'landing_banner'    // marketing page
] as const;
export type AdPlacement = (typeof AD_PLACEMENTS)[number];

const adSlotSchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    placement: { type: String, enum: AD_PLACEMENTS, required: true, index: true },

    /**
     * HOUSE   — self-served creative rendered by our own component
     * NETWORK — a third-party script slot (AdSense et al.)
     * CUSTOM  — raw HTML, admin-authored
     */
    type: { type: String, enum: ['HOUSE', 'NETWORK', 'CUSTOM'], required: true, default: 'HOUSE' },

    // HOUSE fields
    headline: { type: String, trim: true, maxlength: 120 },
    body: { type: String, trim: true, maxlength: 300 },
    ctaLabel: { type: String, trim: true, maxlength: 40 },
    imageUrl: { type: String, trim: true },
    targetUrl: { type: String, trim: true },
    advertiser: { type: String, trim: true },

    // NETWORK fields — the numeric slot id from the ad network
    networkSlotId: { type: String, trim: true },

    // CUSTOM field. Rendered into the page, so admin-only by definition.
    html: { type: String, maxlength: 8000 },

    // Targeting
    countries: { type: [String], default: [] },      // empty = everywhere
    degreeLevels: { type: [String], default: [] },   // empty = all

    // Weighted rotation; higher weight wins more often
    weight: { type: Number, default: 1, min: 0, max: 100 },

    isActive: { type: Boolean, default: true, index: true },
    startsAt: { type: Date },
    endsAt: { type: Date },

    impressions: { type: Number, default: 0 },
    clicks: { type: Number, default: 0 }
  },
  { timestamps: true }
);

adSlotSchema.index({ placement: 1, isActive: 1, weight: -1 });

export type AdSlot = InferSchemaType<typeof adSlotSchema>;
export const AdSlotModel = model('AdSlot', adSlotSchema);
