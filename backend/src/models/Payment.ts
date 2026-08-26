import { Schema, model, type InferSchemaType } from 'mongoose';

const paymentSchema = new Schema(
  {
    reference: { type: String, required: true, unique: true, index: true },
    // Optional as of the scholarship web vertical: a browser checkout has no
    // bot and no Telegram user. Loosening `required` is backwards-compatible —
    // every existing document already supplies both, and every existing writer
    // still does.
    botId: { type: Schema.Types.ObjectId, ref: 'Bot', required: false, index: true },
    planId: { type: Schema.Types.ObjectId, ref: 'Plan', required: true, index: true },
    telegramUserId: { type: Number, required: false, index: true },
    email: { type: String, required: true, lowercase: true, trim: true },
    amountKobo: { type: Number, required: true },
    currency: { type: String, required: true, default: 'NGN' },
    authorizationUrl: { type: String, required: false },
    status: { type: String, required: true, enum: ['initialized', 'paid', 'failed'], default: 'initialized' },
    platform: { type: String, required: true, enum: ['telegram', 'whatsapp', 'web'], default: 'telegram' },
    vertical: { type: String, required: false, enum: ['jobs', 'tenders', 'scholarships'], default: 'jobs' },
    waBotId: { type: Schema.Types.ObjectId, ref: 'WhatsAppBot', required: false },
    whatsappPhone: { type: String, required: false },
    whatsappChatId: { type: String, required: false } // full JID e.g. 254712345678@c.us or LID@lid
  },
  { timestamps: true }
);

export type Payment = InferSchemaType<typeof paymentSchema>;
export const PaymentModel = model('Payment', paymentSchema);
