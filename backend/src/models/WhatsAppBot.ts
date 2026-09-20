import { Schema, model, type InferSchemaType } from 'mongoose';
import { nanoid } from 'nanoid';

const whatsAppBotSchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    wahaUrl: { type: String, required: true, trim: true },
    wahaSessionName: { type: String, required: true, trim: true },
    wahaApiKeyEnc: { type: String, required: false }, // AES-256-GCM encrypted
    groupId: { type: String, required: true, trim: true }, // e.g. 120363000000000001@g.us
    jobReportGroupId: { type: String, required: false, trim: true }, // group to send daily job reports to
    tendersGroupId: { type: String, required: false, trim: true }, // group for the daily tenders digest
    scholarshipGroupId: { type: String, required: false, trim: true }, // group for scholarship broadcasts + paid-member adds
    webhookSecret: { type: String, required: true, default: () => nanoid(32) },
    isActive: { type: Boolean, required: true, default: true }
  },
  { timestamps: true }
);

export type WhatsAppBot = InferSchemaType<typeof whatsAppBotSchema>;
export const WhatsAppBotModel = model('WhatsAppBot', whatsAppBotSchema);
