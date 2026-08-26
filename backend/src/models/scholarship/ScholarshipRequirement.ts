import { Schema } from 'mongoose';
import { DEGREE_LEVELS } from './types';
import { provenanceField } from './provenance';

/**
 * Requirements (§18).
 *
 * Explicitly NOT one giant text blob. Each English test gets its own
 * provenance-wrapped score so "IELTS 6.5 overall with no band below 6.0" can
 * be matched numerically while the original wording stays retrievable.
 *
 * `required: null` on a test means the page never mentioned it. A matcher must
 * render that as "not confirmed", never as "not required" (§56).
 */
const englishTestSchema = new Schema(
  {
    required: { type: Boolean, default: null },
    minScore: { type: Number, default: null },
    // "6.5 overall, no band below 6.0"
    detail: { type: String, maxlength: 400 },
    waiverAvailable: { type: Boolean, default: null },
    confidence: { type: Number, default: 0, min: 0, max: 1 },
    sourceText: { type: String, maxlength: 600 },
    sourceUrl: { type: String }
  },
  { _id: false }
);

const documentSchema = new Schema(
  {
    // canonical slug: CV, TRANSCRIPT, STATEMENT_OF_PURPOSE, …
    code: { type: String, required: true },
    label: { type: String, required: true }, // as written on the page
    count: { type: Number, default: null }, // "2 references" → 2
    mandatory: { type: Boolean, default: null },
    sourceText: { type: String, maxlength: 600 }
  },
  { _id: false }
);

export const scholarshipRequirementSchema = new Schema(
  {
    // ── Academic ──────────────────────────────────────────────────────────
    minimumDegree: { type: provenanceField(String, { enum: [...DEGREE_LEVELS, null], default: null }), default: () => ({}) },
    minimumGpa: { type: provenanceField(Number, { default: null }), default: () => ({}) },
    gpaScale: { type: provenanceField(Number, { default: null }), default: () => ({}) },
    // UK classification etc., kept as written: "2:1", "First Class", "B+"
    minimumGrade: { type: provenanceField(String, { default: null }), default: () => ({}) },
    requiredFields: { type: [String], default: [] },
    academicRanking: { type: provenanceField(String, { default: null }), default: () => ({}) },

    // ── English language ──────────────────────────────────────────────────
    english: {
      type: new Schema(
        {
          ielts: { type: englishTestSchema, default: () => ({}) },
          toefl: { type: englishTestSchema, default: () => ({}) },
          pte: { type: englishTestSchema, default: () => ({}) },
          cambridge: { type: englishTestSchema, default: () => ({}) },
          duolingo: { type: englishTestSchema, default: () => ({}) },
          anyTestRequired: { type: Boolean, default: null },
          rawText: { type: [String], default: [] }
        },
        { _id: false }
      ),
      default: () => ({})
    },

    // ── Documents ─────────────────────────────────────────────────────────
    documents: { type: [documentSchema], default: [] },

    // ── Professional ──────────────────────────────────────────────────────
    workExperienceRequired: { type: provenanceField(Boolean, { default: null }), default: () => ({}) },
    workExperienceYears: { type: provenanceField(Number, { default: null }), default: () => ({}) },
    professionalRegistration: { type: provenanceField(String, { default: null }), default: () => ({}) },

    // ── Other ─────────────────────────────────────────────────────────────
    supervisorRequired: { type: provenanceField(Boolean, { default: null }), default: () => ({}) },
    admissionOfferRequired: { type: provenanceField(Boolean, { default: null }), default: () => ({}) },

    rawRequirementText: { type: [String], default: [] }
  },
  { _id: false }
);
