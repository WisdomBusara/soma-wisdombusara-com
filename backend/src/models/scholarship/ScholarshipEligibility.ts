import { Schema } from 'mongoose';
import { ELIGIBILITY_SCOPES, CERTAINTY } from './types';
import { provenanceField } from './provenance';

/**
 * Eligibility (§17, §58).
 *
 * The critical rule encoded here: `scope: INTERNATIONAL` does NOT populate
 * `countries`. "Open to international students" is a statement about residency
 * status, not a list of 195 nationalities. Nationality matching therefore has
 * to reason about scope + explicit lists + exclusions separately, which is why
 * they are three different fields instead of one flattened array.
 */
export const scholarshipEligibilitySchema = new Schema(
  {
    scope: { type: String, enum: ELIGIBILITY_SCOPES, default: 'UNKNOWN', index: true },
    scopeCertainty: { type: String, enum: CERTAINTY, default: 'UNKNOWN' },
    scopeSourceText: { type: String, maxlength: 1200 },

    // ISO-3166-1 alpha-2, only when the page names countries explicitly
    countries: { type: [String], default: [], index: true },
    excludedCountries: { type: [String], default: [] },
    // "EU", "EEA", "Commonwealth", "Sub-Saharan Africa", "Developing Countries"
    regions: { type: [String], default: [] },

    // Free-form demographic categories, preserved as written
    categories: { type: [String], default: [] }, // e.g. "women in STEM", "refugees"

    womenOnly: { type: provenanceField(Boolean, { default: null }), default: () => ({}) },
    refugeesEligible: { type: provenanceField(Boolean, { default: null }), default: () => ({}) },
    developingCountriesOnly: {
      type: provenanceField(Boolean, { default: null }),
      default: () => ({})
    },

    ageMin: { type: provenanceField(Number, { default: null }), default: () => ({}) },
    ageMax: { type: provenanceField(Number, { default: null }), default: () => ({}) },

    residencyRequirement: { type: provenanceField(String, { default: null }), default: () => ({}) },
    citizenshipRequirement: {
      type: provenanceField(String, { default: null }),
      default: () => ({})
    },

    rawEligibilityText: { type: [String], default: [] }
  },
  { _id: false }
);
