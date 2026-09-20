import { Schema, model, type InferSchemaType } from 'mongoose';

const subscriptionSchema = new Schema(
  {
    botId: { type: Schema.Types.ObjectId, ref: 'Bot', required: true, index: true },
    planId: { type: Schema.Types.ObjectId, ref: 'Plan', required: true, index: true },
    telegramUserId: { type: Number, required: true, index: true },
    startsAt: { type: Date, required: true },
    endsAt: { type: Date, required: true, index: true },
    status: { type: String, required: true, enum: ['active', 'expired', 'canceled'], default: 'active', index: true },
    paystackReference: { type: String, required: false, index: true },
    revokedAt: { type: Date, required: false },
    revokeAttempts: { type: Number, required: true, default: 0 },
    lastRevokeError: { type: String, required: false },
    platform: { type: String, required: true, enum: ['telegram', 'whatsapp'], default: 'telegram' },
    waBotId: { type: Schema.Types.ObjectId, ref: 'WhatsAppBot', required: false },
    whatsappPhone: { type: String, required: false },
    whatsappChatId: { type: String, required: false }, // full JID for group add/remove
    vertical: { type: String, required: false, enum: ['jobs', 'tenders', 'scholarships'], default: 'jobs' }
  },
  { timestamps: true }
);

subscriptionSchema.index({ botId: 1, telegramUserId: 1, status: 1, endsAt: 1 });

export type Subscription = InferSchemaType<typeof subscriptionSchema>;
export const SubscriptionModel = model('Subscription', subscriptionSchema);
