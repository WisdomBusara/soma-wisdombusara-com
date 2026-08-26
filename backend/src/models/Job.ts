import crypto from 'crypto';
import { Schema, model } from 'mongoose';

const jobSchema = new Schema(
  {
    bankName: { type: String, required: true, index: true },
    vertical: { type: String, required: true, enum: ['jobs', 'tenders'], default: 'jobs', index: true },
    title:    { type: String, required: true },
    url:      { type: String, required: true },
    location: { type: String, required: false },
    deadline: { type: String, required: false },      // tender closing date (as displayed)
    description: { type: String, required: false },   // short tender description / scope
    hash:     { type: String, required: true, unique: true },
    firstSeenAt: { type: Date, required: true, default: Date.now },
    lastSeenAt:  { type: Date, required: true, default: Date.now },
    // LLM categorization (premium feature)
    category: { type: String, required: false, index: true },
    categoryScore: { type: Number, required: false },   // model confidence 0–1
    categorizedAt: { type: Date, required: false },
    summary: { type: String, required: false }          // LLM-condensed JD
  },
  { timestamps: false }
);

jobSchema.index({ firstSeenAt: 1 });
jobSchema.index({ category: 1, firstSeenAt: -1 });

export function makeJobHash(bankName: string, title: string, url: string): string {
  return crypto.createHash('sha256').update(`${bankName}:${title}:${url}`).digest('hex').slice(0, 16);
}

export const JobModel = model('ScrapedJob', jobSchema);
