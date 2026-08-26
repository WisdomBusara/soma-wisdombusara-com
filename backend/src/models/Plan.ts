import { Schema, model, type InferSchemaType } from 'mongoose';

const planSchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    durationMinutes: { type: Number, required: true, min: 1 },
    amountKobo: { type: Number, required: true, min: 0 },
    currency: { type: String, required: true, default: 'NGN' },
    videoUrl: { type: String, required: false, trim: true },
    description: { type: String, required: false, trim: true },
    isActive: { type: Boolean, required: true, default: true }
  },
  { timestamps: true }
);

planSchema.index({ name: 1 }, { unique: true });

export type Plan = InferSchemaType<typeof planSchema>;
export const PlanModel = model('Plan', planSchema);
