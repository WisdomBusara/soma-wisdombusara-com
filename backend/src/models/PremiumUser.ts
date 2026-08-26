import { Schema, model, type InferSchemaType } from 'mongoose';

// Premium subscribers get the LLM-categorized job feed via the bot
// ("hi" → pick a category → today's jobs in that category as a DM).
// Managed from the portal's Premium tab.

const premiumUserSchema = new Schema(
  {
    // phone digits (2547…) for @c.us contacts, or the LID digits for @lid
    phone: { type: String, required: true, trim: true },
    name: { type: String, required: false, trim: true },
    email: { type: String, required: false, trim: true, lowercase: true },
    notes: { type: String, required: false, trim: true },
    isActive: { type: Boolean, required: true, default: true },
    expiresAt: { type: Date, required: false }   // optional hard end date
  },
  { timestamps: true }
);

premiumUserSchema.index({ phone: 1 }, { unique: true });

export type PremiumUser = InferSchemaType<typeof premiumUserSchema>;
export const PremiumUserModel = model('PremiumUser', premiumUserSchema);
