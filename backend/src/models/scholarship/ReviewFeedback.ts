import { Schema, model, type InferSchemaType } from 'mongoose';

/**
 * One row per admin APPROVE/REJECT decision on a NEEDS_REVIEW scholarship.
 *
 * This is the raw material for the self-learning loop (services/scholarship/
 * learning.ts): a snapshot of what the classifier believed (score, reasons,
 * confidence) alongside what the human actually decided, so later analysis
 * can tell which signals the classifier over- or under-weighted without
 * re-deriving them from the (mutable) Scholarship document.
 */

const reviewFeedbackSchema = new Schema(
  {
    scholarshipId: { type: Schema.Types.ObjectId, ref: 'Scholarship', required: true, index: true },
    decision: { type: String, enum: ['APPROVED', 'REJECTED'], required: true, index: true },

    domain: { type: String, lowercase: true, index: true },
    confidence: { type: Number, default: 0 },
    classificationScore: { type: Number, default: 0 },
    classificationReasons: { type: [String], default: [] },
    extractionMethod: { type: String, enum: ['RULES', 'AI', 'HYBRID', 'MANUAL'], default: 'RULES' },

    reviewedBy: { type: Schema.Types.ObjectId, ref: 'AdminUser' },
    // True once learnFromFeedback() has folded this row into the weight/priority
    // adjustment — lets the learner process only what's new each pass.
    consumedAt: { type: Date, default: null, index: true }
  },
  { timestamps: true }
);

reviewFeedbackSchema.index({ consumedAt: 1, createdAt: 1 });
reviewFeedbackSchema.index({ domain: 1, decision: 1 });

export type ReviewFeedback = InferSchemaType<typeof reviewFeedbackSchema>;
export const ReviewFeedbackModel = model('ScholarshipReviewFeedback', reviewFeedbackSchema);
