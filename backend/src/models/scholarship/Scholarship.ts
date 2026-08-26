import { Schema, model, type InferSchemaType } from 'mongoose';
import {
  DEGREE_LEVELS,
  STUDY_MODES,
  ATTENDANCE_MODES,
  DELIVERY_MODES,
  SCHOLARSHIP_STATUSES,
  REVIEW_STATUSES,
  DEADLINE_KINDS,
  CERTAINTY
} from './types';
import { provenanceField } from './provenance';
import { scholarshipFundingSchema } from './ScholarshipFunding';
import { scholarshipEligibilitySchema } from './ScholarshipEligibility';
import { scholarshipRequirementSchema } from './ScholarshipRequirement';

const deadlineSchema = new Schema(
  {
    kind: { type: String, enum: DEADLINE_KINDS, default: 'UNKNOWN' },
    // Parsed instant. Null for ROLLING/UNKNOWN — those are legitimate states,
    // not failures.
    date: { type: Date, default: null },
    // Extra rounds for MULTIPLE_ROUNDS
    additionalDates: { type: [Date], default: [] },
    // Never discarded: "Applications close at 23:59 GMT on 15 January 2027"
    originalText: { type: String, maxlength: 600 },
    timezoneStated: { type: String, default: null },
    confidence: { type: Number, default: 0, min: 0, max: 1 },
    certainty: { type: String, enum: CERTAINTY, default: 'UNKNOWN' },
    sourceUrl: { type: String }
  },
  { _id: false }
);

const scholarshipSchema = new Schema(
  {
    title: { type: String, required: true, trim: true },
    // lowercase, punctuation-stripped, stop-words removed — the dedup input
    normalizedTitle: { type: String, required: true, index: true },

    universityId: { type: Schema.Types.ObjectId, ref: 'University', index: true },
    universityName: { type: String, trim: true }, // denormalized for list views
    provider: { type: String, trim: true },

    country: { type: String, required: true, trim: true },
    countryCode: { type: String, uppercase: true, minlength: 2, maxlength: 2, index: true },
    city: { type: String, trim: true },

    degreeLevels: { type: [String], enum: DEGREE_LEVELS, default: [], index: true },
    degreeLevelSourceText: { type: [String], default: [] },

    fieldsOfStudy: { type: [String], default: [], index: true },

    studyMode: { type: [String], enum: STUDY_MODES, default: ['UNKNOWN'] },
    attendance: { type: [String], enum: ATTENDANCE_MODES, default: ['UNKNOWN'] },
    deliveryMode: { type: [String], enum: DELIVERY_MODES, default: ['UNKNOWN'] },

    funding: { type: scholarshipFundingSchema, default: () => ({}) },
    eligibility: { type: scholarshipEligibilitySchema, default: () => ({}) },
    requirements: { type: scholarshipRequirementSchema, default: () => ({}) },

    deadline: { type: deadlineSchema, default: () => ({}) },

    intake: { type: String, trim: true },
    academicYear: { type: String, trim: true, index: true },
    duration: { type: String, trim: true },

    applicationUrl: { type: provenanceField(String, { default: null }), default: () => ({}) },
    sourceUrl: { type: String, required: true },

    description: { type: String, maxlength: 4000 },

    status: {
      type: String,
      enum: SCHOLARSHIP_STATUSES,
      required: true,
      default: 'DISCOVERED',
      index: true
    },
    reviewStatus: {
      type: String,
      enum: REVIEW_STATUSES,
      required: true,
      default: 'NEEDS_REVIEW',
      index: true
    },
    reviewedBy: { type: Schema.Types.ObjectId, ref: 'AdminUser' },
    reviewedAt: { type: Date },
    reviewNote: { type: String, maxlength: 1000 },

    // Operational signals, NOT correctness guarantees (§35, §60)
    confidence: { type: Number, default: 0, min: 0, max: 1, index: true },
    qualityScore: { type: Number, default: 0, min: 0, max: 1 },
    classificationScore: { type: Number, default: 0, min: 0, max: 1 },
    classificationReasons: { type: [String], default: [] },

    /**
     * Canonical dedup key (§23): sha256 of
     *   universityId|normalizedTitle|academicYear|sortedDegreeLevels|provider
     * Unique — the same award crawled from six URLs collapses to one document
     * with six ScholarshipSource rows.
     */
    fingerprint: { type: String, required: true },

    // Superseded records point at their replacement rather than being deleted
    replacedBy: { type: Schema.Types.ObjectId, ref: 'Scholarship', default: null },

    discoveredAt: { type: Date, required: true, default: Date.now },
    lastCrawledAt: { type: Date, required: true, default: Date.now },
    lastVerifiedAt: { type: Date },
    lastChangedAt: { type: Date },

    sourceCount: { type: Number, default: 1 },
    // Whether any surviving source is an official institution/government page
    hasOfficialSource: { type: Boolean, default: false, index: true },
    extractionMethod: { type: String, enum: ['RULES', 'AI', 'HYBRID', 'MANUAL'], default: 'RULES' }
  },
  { timestamps: true }
);

// ── Indexes (§45) ───────────────────────────────────────────────────────────
scholarshipSchema.index({ fingerprint: 1 }, { unique: true });
// The primary search path: degree + country + status + deadline ordering.
scholarshipSchema.index({ status: 1, countryCode: 1, degreeLevels: 1, 'deadline.date': 1 });
scholarshipSchema.index({ status: 1, 'funding.primaryType': 1, 'deadline.date': 1 });
scholarshipSchema.index({ universityId: 1, status: 1 });
scholarshipSchema.index({ 'eligibility.countries': 1, status: 1 });
scholarshipSchema.index({ 'eligibility.scope': 1, status: 1 });
scholarshipSchema.index({ 'deadline.date': 1, status: 1 });
scholarshipSchema.index({ reviewStatus: 1, confidence: 1 });
scholarshipSchema.index({ sourceUrl: 1 });
scholarshipSchema.index({ title: 'text', description: 'text', fieldsOfStudy: 'text' });

export type Scholarship = InferSchemaType<typeof scholarshipSchema>;
export const ScholarshipModel = model('Scholarship', scholarshipSchema);
