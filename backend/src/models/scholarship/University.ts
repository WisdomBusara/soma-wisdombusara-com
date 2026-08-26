import { Schema, model, type InferSchemaType } from 'mongoose';

/**
 * Global university registry (§5).
 *
 * `domain` is the canonical identity: an institution is the same institution
 * if it serves from the same registrable domain. That is the only dedup key
 * that survives name variations ("Univ. of Nairobi", "The University of
 * Nairobi", "UoN") and translation.
 */
const universitySchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    officialName: { type: String, trim: true },
    aliases: { type: [String], default: [] },

    country: { type: String, required: true, trim: true },
    countryCode: { type: String, trim: true, uppercase: true, minlength: 2, maxlength: 2 },
    region: { type: String, trim: true },
    city: { type: String, trim: true },

    website: { type: String, required: true, trim: true },
    // normalized: lowercase, no scheme, no www., no trailing slash
    domain: { type: String, required: true, trim: true, lowercase: true },

    scholarshipUrls: { type: [String], default: [] },
    admissionsUrl: { type: String, trim: true },
    internationalStudentsUrl: { type: String, trim: true },

    type: { type: String, enum: ['PUBLIC', 'PRIVATE', 'OTHER'], default: 'OTHER' },

    status: {
      type: String,
      enum: ['ACTIVE', 'INACTIVE', 'UNVERIFIED'],
      required: true,
      default: 'UNVERIFIED',
      index: true
    },

    // Why we believe this is a university at all — provider id, dataset name,
    // or the page we found the link on.
    discoverySource: { type: String, trim: true },
    // Result of the live domain check performed before promotion to ACTIVE.
    verification: {
      type: new Schema(
        {
          httpStatus: { type: Number },
          resolvedUrl: { type: String },
          titleMatch: { type: Boolean, default: false },
          checkedAt: { type: Date },
          reason: { type: String }
        },
        { _id: false }
      ),
      default: () => ({})
    },

    // Operational controls surfaced in the admin UI (§33)
    crawlEnabled: { type: Boolean, default: true, index: true },
    crawlIntervalHours: { type: Number, default: 24 * 7 },
    consecutiveFailures: { type: Number, default: 0 },
    blockedReason: { type: String },

    discoveredAt: { type: Date, required: true, default: Date.now },
    lastVerifiedAt: { type: Date },
    lastCrawledAt: { type: Date },
    nextCrawlAt: { type: Date, index: true },

    stats: {
      type: new Schema(
        {
          scholarshipUrlsFound: { type: Number, default: 0 },
          scholarshipsFound: { type: Number, default: 0 },
          lastCrawlDurationMs: { type: Number, default: 0 }
        },
        { _id: false }
      ),
      default: () => ({})
    }
  },
  { timestamps: true }
);

// Identity. A domain may only ever map to one institution.
universitySchema.index({ domain: 1 }, { unique: true });
universitySchema.index({ countryCode: 1, status: 1 });
universitySchema.index({ country: 1, status: 1 });
universitySchema.index({ status: 1, crawlEnabled: 1, nextCrawlAt: 1 });
universitySchema.index({ name: 'text', officialName: 'text', aliases: 'text' });

export type University = InferSchemaType<typeof universitySchema>;
export const UniversityModel = model('University', universitySchema);
