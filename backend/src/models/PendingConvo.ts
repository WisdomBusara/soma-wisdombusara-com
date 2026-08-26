import { Schema, model, type InferSchemaType } from 'mongoose';

// Durable bot conversation state. Previously an in-memory Map — a deploy or
// restart wiped it and users mid-signup got dumped back to "send hi".
// TTL: stale conversations expire after 30 minutes of inactivity.

const pendingConvoSchema = new Schema({
  key: { type: String, required: true, unique: true }, // `${waBotId}:${phone}`
  state: { type: Schema.Types.Mixed, required: true },
  updatedAt: { type: Date, required: true, default: Date.now }
});

pendingConvoSchema.index({ updatedAt: 1 }, { expireAfterSeconds: 1800 });

export type PendingConvo = InferSchemaType<typeof pendingConvoSchema>;
export const PendingConvoModel = model('PendingConvo', pendingConvoSchema);
