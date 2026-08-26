import { Schema, type SchemaDefinitionProperty } from 'mongoose';
import { CERTAINTY } from './types';

/**
 * Wraps any value type in the provenance envelope required by §19/§55.
 *
 * Usage:  tuitionCovered: provenanceField(Boolean, { default: null })
 *
 * `_id: false` keeps these as plain embedded objects — Mongo will not mint an
 * ObjectId for every extracted field, which matters a lot at 100k+ documents.
 */
export function provenanceField(
  valueType: SchemaDefinitionProperty<any>,
  valueOpts: Record<string, unknown> = {}
): Schema {
  return new Schema(
    {
      value: { type: valueType, ...valueOpts },
      confidence: { type: Number, default: 0, min: 0, max: 1 },
      certainty: { type: String, enum: CERTAINTY, default: 'UNKNOWN' },
      sourceUrl: { type: String },
      // The literal sentence the value was read from. Never paraphrased —
      // admins need to compare against the live page.
      sourceText: { type: String, maxlength: 1200 },
      method: { type: String, enum: ['RULES', 'AI', 'HYBRID', 'MANUAL'], default: 'RULES' }
    },
    { _id: false }
  );
}

/** Money-shaped provenance: keeps amount, currency AND the original wording (§16). */
export const moneyProvenanceSchema = new Schema(
  {
    amount: { type: Number, default: null },
    currency: { type: String, default: null },
    period: { type: String, default: null }, // "per year", "per month", …
    originalText: { type: String, maxlength: 600 },
    confidence: { type: Number, default: 0, min: 0, max: 1 },
    certainty: { type: String, enum: CERTAINTY, default: 'UNKNOWN' },
    sourceUrl: { type: String },
    method: { type: String, enum: ['RULES', 'AI', 'HYBRID', 'MANUAL'], default: 'RULES' }
  },
  { _id: false }
);
