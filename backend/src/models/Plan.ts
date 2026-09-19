import { Schema, model, type InferSchemaType } from 'mongoose';

const planSchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    durationMinutes: { type: Number, required: true, min: 1 },
    amountKobo: { type: Number, required: true, min: 0 },
    currency: { type: String, required: true, default: 'NGN' },
    videoUrl: { type: String, required: false, trim: true },
    description: { type: String, required: false, trim: true },
    isActive: { type: Boolean, required: true, default: true },
    isTrial: { type: Boolean, required: true, default: false },
    // Which product this plan belongs to. Defaults to 'jobs' (not required) so
    // existing documents, and every query written before this field existed,
    // keep behaving exactly as they do today — see Payment.vertical and
    // Subscription.vertical for the same convention.
    vertical: { type: String, enum: ['scholarships', 'jobs', 'tenders'], default: 'jobs' }
  },
  { timestamps: true }
);

// One name per vertical, not one name globally — "Monthly" can exist once for
// jobs and once for tenders without colliding.
planSchema.index({ name: 1, vertical: 1 }, { unique: true });

export type Plan = InferSchemaType<typeof planSchema>;
export const PlanModel = model('Plan', planSchema);
