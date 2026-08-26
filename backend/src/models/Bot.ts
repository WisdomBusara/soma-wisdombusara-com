import { Schema, model, type InferSchemaType } from 'mongoose';

const botSchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    tokenEnc: { type: String, required: true },
    tokenLast4: { type: String, required: true },
    protectedChatId: { type: String, required: true, trim: true },
    isActive: { type: Boolean, required: true, default: true },
    webhookSecret: { type: String, required: true, index: true }
  },
  { timestamps: true }
);

botSchema.index({ name: 1 });

export type Bot = InferSchemaType<typeof botSchema>;
export const BotModel = model('Bot', botSchema);
