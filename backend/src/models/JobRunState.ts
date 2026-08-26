import { Schema, model, type InferSchemaType } from 'mongoose';

// Singleton document (_id: 'job-report') holding the run lock and live status.
// With multiple backend machines, the 07:00 cron fires on every machine —
// the lock ensures exactly one runs the scrape, and status in Mongo means
// the dashboard progress bar works no matter which machine serves the request.

const jobRunStateSchema = new Schema(
  {
    _id: { type: String, default: 'job-report' },
    lockedUntil: { type: Date, default: null },
    state: { type: String, enum: ['idle', 'scraping', 'sending', 'done', 'failed'], default: 'idle' },
    startedAt: { type: Date, default: null },
    finishedAt: { type: Date, default: null },
    banksDone: { type: Number, default: 0 },
    banksTotal: { type: Number, default: 0 },
    currentBank: { type: String, default: null },
    newJobs: { type: Number, default: 0 },
    banksWithNew: { type: Number, default: 0 },
    error: { type: String, default: null }
  },
  { _id: false }
);

export type JobRunState = InferSchemaType<typeof jobRunStateSchema>;
export const JobRunStateModel = model('JobRunState', jobRunStateSchema);
