import { Schema, model, type InferSchemaType } from 'mongoose';

/**
 * Scholarship delivery subscriber.
 *
 * After a reader pays, they choose how they want new scholarships delivered:
 * email and/or Telegram, individually. WhatsApp is deliberately NOT one of
 * these per-subscriber push channels — a paid WhatsApp payer is instead added
 * directly to the shared WhatsApp group (see waFulfillment/provisionDeliveryOnGrant),
 * and new scholarships reach them via the group broadcast, never an individual
 * DM. Messaging many individual numbers on a recurring schedule from one WAHA
 * session is exactly the pattern that risks a WhatsApp ban; group posts don't
 * carry that risk. `whatsappPhone` below is retained purely for group
 * add/remove — it is not a delivery channel choice.
 *
 * Deliberately separate from ScholarshipAccess (the paywall grant): access
 * governs *reading the site*, this governs *push delivery*. A reader can have
 * access without subscribing to delivery, and the two are updated
 * independently.
 */

export const DELIVERY_CHANNELS = ['email', 'telegram'] as const;
export type DeliveryChannel = (typeof DELIVERY_CHANNELS)[number];

const subscriberSchema = new Schema(
  {
    // Link back to the paid grant, so delivery stops when access lapses.
    accessId: { type: Schema.Types.ObjectId, ref: 'ScholarshipAccess', index: true },

    // The channels this subscriber wants, and the address for each.
    channels: {
      type: [String],
      enum: DELIVERY_CHANNELS,
      default: []
    },

    email: { type: String, trim: true, lowercase: true, index: true },

    // Telegram: we store the chat id once they message the bot (the bot learns
    // it from the incoming message). Until then telegramHandle is a hint.
    telegramHandle: { type: String, trim: true },
    telegramChatId: { type: String, trim: true, index: true },

    // WhatsApp: the number in 2547XXXXXXXX form (no +), used by WAHA.
    whatsappPhone: { type: String, trim: true, index: true },

    // Delivery preferences
    countries: { type: [String], default: [] },       // empty = all
    degreeLevels: { type: [String], default: [] },     // empty = all
    fundingOnly: { type: Boolean, default: false },    // only fully-funded

    status: {
      type: String,
      enum: ['active', 'paused', 'expired'],
      default: 'active',
      index: true
    },

    // The last scholarship batch time we delivered, so we never resend.
    lastDeliveredAt: { type: Date },

    // Group-membership enforcement (Telegram): when the "top up" reminder was
    // last sent, and when they were last removed from the group for lapsing.
    // Compared against the linked grant's startsAt/endsAt so a renewal's fresh
    // period is never suppressed by a reminder sent for a prior one.
    renewalReminderSentAt: { type: Date },
    removedFromGroupAt: { type: Date },

    // Counters for observability
    deliveredCount: { type: Number, default: 0 },
    failureCount: { type: Number, default: 0 },
    lastError: { type: String }
  },
  { timestamps: true }
);

subscriberSchema.index({ status: 1, 'channels': 1 });

export type Subscriber = InferSchemaType<typeof subscriberSchema>;
export const SubscriberModel = model('ScholarshipSubscriber', subscriberSchema);

/**
 * Delivery log — one row per scholarship sent to one subscriber on one channel.
 * Used both as an idempotency guard (never send the same scholarship twice to
 * the same subscriber) and as an audit trail.
 */
const deliveryLogSchema = new Schema(
  {
    subscriberId: { type: Schema.Types.ObjectId, ref: 'ScholarshipSubscriber', required: true, index: true },
    scholarshipId: { type: Schema.Types.ObjectId, ref: 'Scholarship', required: true, index: true },
    channel: { type: String, enum: DELIVERY_CHANNELS, required: true },
    status: { type: String, enum: ['sent', 'failed'], required: true },
    error: { type: String },
    sentAt: { type: Date, default: Date.now }
  },
  { timestamps: true }
);

// One scholarship goes to one subscriber on one channel at most once.
deliveryLogSchema.index({ subscriberId: 1, scholarshipId: 1, channel: 1 }, { unique: true });

export type DeliveryLog = InferSchemaType<typeof deliveryLogSchema>;
export const DeliveryLogModel = model('ScholarshipDeliveryLog', deliveryLogSchema);
