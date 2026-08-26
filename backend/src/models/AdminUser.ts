import { Schema, model, type InferSchemaType } from 'mongoose';

const adminUserSchema = new Schema(
  {
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    passwordHash: { type: String, required: true },
    role: { type: String, required: true, enum: ['owner', 'admin'], default: 'admin' },
    isActive: { type: Boolean, required: true, default: true },
    loginFailures: { type: Number, required: true, default: 0 },
    lockedUntil: { type: Date, required: false },
    lastLoginAt: { type: Date, required: false }
  },
  { timestamps: true }
);

export type AdminUser = InferSchemaType<typeof adminUserSchema>;
export const AdminUserModel = model('AdminUser', adminUserSchema);
