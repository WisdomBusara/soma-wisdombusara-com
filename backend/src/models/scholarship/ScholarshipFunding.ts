import { Schema } from 'mongoose';
import { FUNDING_TYPES, CERTAINTY } from './types';
import { provenanceField, moneyProvenanceSchema } from './provenance';

/**
 * Funding (§15, §16).
 *
 * Embedded rather than a separate collection: funding is 1:1 with a
 * scholarship, is always read with it, and is never queried independently.
 * Splitting it out would buy nothing and cost a join on every search.
 *
 * Every boolean is `Boolean | null` inside a provenance envelope. `null` means
 * the source never said — which is NOT the same as "not covered" (§56).
 */
export const scholarshipFundingSchema = new Schema(
  {
    // Coarse label used for the fullyFunded=true style filters
    types: { type: [String], enum: FUNDING_TYPES, default: [] },
    primaryType: { type: String, enum: FUNDING_TYPES, default: 'UNKNOWN', index: true },
    primaryTypeCertainty: { type: String, enum: CERTAINTY, default: 'UNKNOWN' },

    tuitionCovered: { type: provenanceField(Boolean, { default: null }), default: () => ({}) },
    tuitionPercentage: { type: provenanceField(Number, { default: null }), default: () => ({}) },
    tuitionAmount: { type: moneyProvenanceSchema, default: () => ({}) },

    livingStipend: { type: provenanceField(Boolean, { default: null }), default: () => ({}) },
    stipendAmount: { type: moneyProvenanceSchema, default: () => ({}) },

    travelCovered: { type: provenanceField(Boolean, { default: null }), default: () => ({}) },
    airfareCovered: { type: provenanceField(Boolean, { default: null }), default: () => ({}) },
    accommodationCovered: { type: provenanceField(Boolean, { default: null }), default: () => ({}) },
    healthInsurance: { type: provenanceField(Boolean, { default: null }), default: () => ({}) },
    researchAllowance: { type: provenanceField(Boolean, { default: null }), default: () => ({}) },
    booksAllowance: { type: provenanceField(Boolean, { default: null }), default: () => ({}) },
    equipmentAllowance: { type: provenanceField(Boolean, { default: null }), default: () => ({}) },
    applicationFeeWaiver: { type: provenanceField(Boolean, { default: null }), default: () => ({}) },
    visaSupport: { type: provenanceField(Boolean, { default: null }), default: () => ({}) },

    // Number of awards, when stated
    awardCount: { type: provenanceField(Number, { default: null }), default: () => ({}) },

    // Verbatim funding paragraph(s) — the ground truth an admin reviews against
    rawFundingText: { type: [String], default: [] }
  },
  { _id: false }
);
