import { Schema, model, type InferSchemaType } from 'mongoose';

/**
 * Singleton document (_id fixed to 'default') holding a multiplier per
 * classifier scoring reason (see scholarshipClassifier.ts's `reasons` labels
 * — the map keys are exactly those strings).
 *
 * Multipliers start at 1.0 (no-op) and are nudged by services/scholarship/
 * learning.ts based on admin approve/reject outcomes. Deliberately just a
 * flat map rather than a model retrain: every adjustment is a single bounded
 * number an operator can read, reset, or override by hand.
 */

const classifierWeightSchema = new Schema(
  {
    _id: { type: String, default: 'default' },
    weights: { type: Map, of: Number, default: () => new Map() },
    updatedAt: { type: Date, default: Date.now }
  },
  { versionKey: false }
);

export type ClassifierWeightDoc = InferSchemaType<typeof classifierWeightSchema>;
export const ClassifierWeightModel = model('ScholarshipClassifierWeight', classifierWeightSchema);
