import { Schema, model, type InferSchemaType } from 'mongoose';

const querySchema = new Schema(
  {
    botId: { type: Schema.Types.ObjectId, ref: 'Bot', required: true, index: true },
    telegramUserId: { type: Number, required: true, index: true },
    text: { type: String, required: true },
    status: { type: String, required: true, enum: ['open', 'closed'], default: 'open', index: true }
  },
  { timestamps: true }
);

querySchema.index({ botId: 1, status: 1, createdAt: -1 });

export type Query = InferSchemaType<typeof querySchema>;
export const QueryModel = model('Query', querySchema);
