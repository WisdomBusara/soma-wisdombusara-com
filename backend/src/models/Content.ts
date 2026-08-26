import { Schema, model, type InferSchemaType } from 'mongoose';

const contentSchema = new Schema(
  {
    botId: { type: Schema.Types.ObjectId, ref: 'Bot', required: true, index: true },
    title: { type: String, required: true, trim: true },
    body: { type: String, required: true },
    isActive: { type: Boolean, required: true, default: true }
  },
  { timestamps: true }
);

contentSchema.index({ botId: 1, createdAt: -1 });

export type Content = InferSchemaType<typeof contentSchema>;
export const ContentModel = model('Content', contentSchema);
