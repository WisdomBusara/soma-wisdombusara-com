import { Schema, model, type InferSchemaType } from 'mongoose';

const refreshSessionSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'AdminUser', required: true, index: true },
    sessionId: { type: String, required: true, unique: true, index: true },
    refreshTokenHash: { type: String, required: true },
    userAgent: { type: String, required: false },
    ip: { type: String, required: false },
    lastUsedAt: { type: Date, required: false },
    revokedAt: { type: Date, required: false },
    expiresAt: { type: Date, required: true, index: { expires: 0 } }
  },
  { timestamps: true }
);

export type RefreshSession = InferSchemaType<typeof refreshSessionSchema>;
export const RefreshSessionModel = model('RefreshSession', refreshSessionSchema);
