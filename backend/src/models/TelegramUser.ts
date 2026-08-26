import { Schema, model, type InferSchemaType } from 'mongoose';

const telegramUserSchema = new Schema(
  {
    telegramUserId: { type: Number, required: true, unique: true, index: true },
    username: { type: String, required: false },
    firstName: { type: String, required: false },
    lastName: { type: String, required: false },
    email: { type: String, required: false, lowercase: true, trim: true },
    lastSeenAt: { type: Date, required: false }
  },
  { timestamps: true }
);

export type TelegramUser = InferSchemaType<typeof telegramUserSchema>;
export const TelegramUserModel = model('TelegramUser', telegramUserSchema);
