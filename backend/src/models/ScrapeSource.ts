import { Schema, model, type InferSchemaType } from 'mongoose';

// A career page (or ATS tenant) that the job scraper monitors.
// Sources are grouped by industry so new verticals can be added
// from the admin portal without a deploy.

const scrapeSourceSchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    industry: { type: String, required: true, trim: true, lowercase: true, default: 'banking' },
    vertical: { type: String, required: true, enum: ['jobs', 'tenders'], default: 'jobs', index: true },
    kind: { type: String, required: true, enum: ['html', 'oracle', 'workday'], default: 'html' },
    homepage: { type: String, required: true, trim: true },

    // kind: 'html'
    url: { type: String, trim: true },
    jobSelector: { type: String, trim: true },
    dynamic: { type: Boolean, default: false },
    // optional regex — extracted job URLs must match (e.g. "/job/nairobi/" to
    // keep only Nairobi roles from a multi-country listing like Citi's)
    urlFilter: { type: String, trim: true },

    // kind: 'oracle' (Oracle HCM CandidateExperience REST API)
    tenant: { type: String, trim: true },
    siteNumber: { type: String, trim: true },
    locationId: { type: Number },
    domain: { type: String, trim: true },

    isActive: { type: Boolean, required: true, default: true }
  },
  { timestamps: true }
);

scrapeSourceSchema.index({ name: 1 }, { unique: true });
scrapeSourceSchema.index({ industry: 1, isActive: 1 });

export type ScrapeSource = InferSchemaType<typeof scrapeSourceSchema>;
export const ScrapeSourceModel = model('ScrapeSource', scrapeSourceSchema);
