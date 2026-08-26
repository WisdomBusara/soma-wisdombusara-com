import { Schema, model, type InferSchemaType } from 'mongoose';
import { SOURCE_TYPES, TARGET_TYPES, TARGET_STATUSES, EXTRACTION_METHODS } from './types';

// ─────────────────────────────────────────────────────────────────────────────
// ScholarshipSource (§24) — one scholarship, many places it was found.
// ─────────────────────────────────────────────────────────────────────────────

const scholarshipSourceSchema = new Schema(
  {
    scholarshipId: { type: Schema.Types.ObjectId, ref: 'Scholarship', required: true, index: true },
    universityId: { type: Schema.Types.ObjectId, ref: 'University' },

    sourceUrl: { type: String, required: true },
    canonicalUrl: { type: String, required: true },
    sourceType: { type: String, enum: SOURCE_TYPES, required: true, default: 'OTHER' },
    contentType: { type: String, default: 'text/html' },

    title: { type: String },
    contentHash: { type: String, index: true },

    firstSeen: { type: Date, required: true, default: Date.now },
    lastSeen: { type: Date, required: true, default: Date.now },

    // Exactly one primary per scholarship; chosen by SOURCE_AUTHORITY (§47)
    isPrimary: { type: Boolean, default: false },
    verificationStatus: {
      type: String,
      enum: ['UNVERIFIED', 'REACHABLE', 'UNREACHABLE', 'CHANGED', 'GONE'],
      default: 'UNVERIFIED'
    },
    lastHttpStatus: { type: Number }
  },
  { timestamps: true }
);

scholarshipSourceSchema.index({ scholarshipId: 1, canonicalUrl: 1 }, { unique: true });
scholarshipSourceSchema.index({ canonicalUrl: 1 });
scholarshipSourceSchema.index({ scholarshipId: 1, isPrimary: -1 });

export type ScholarshipSource = InferSchemaType<typeof scholarshipSourceSchema>;
export const ScholarshipSourceModel = model('ScholarshipSource', scholarshipSourceSchema);

// ─────────────────────────────────────────────────────────────────────────────
// CrawlTarget (§9) — the work queue.
// ─────────────────────────────────────────────────────────────────────────────

const crawlTargetSchema = new Schema(
  {
    url: { type: String, required: true },
    // Deduplication key: scheme+host+path with tracking params stripped
    canonicalUrl: { type: String, required: true },
    domain: { type: String, required: true, lowercase: true, index: true },

    universityId: { type: Schema.Types.ObjectId, ref: 'University', index: true },

    targetType: { type: String, enum: TARGET_TYPES, required: true, default: 'OTHER' },
    // Higher runs first. Open scholarships ~100, landing pages ~50, discovery ~10.
    priority: { type: Number, required: true, default: 50, index: true },
    depth: { type: Number, default: 0 },

    discoveredFrom: { type: String },

    status: {
      type: String,
      enum: TARGET_STATUSES,
      required: true,
      default: 'PENDING',
      index: true
    },
    attempts: { type: Number, default: 0 },
    lastError: { type: String, maxlength: 600 },

    lastCrawledAt: { type: Date },
    nextCrawlAt: { type: Date, default: Date.now, index: true },
    // Set when a worker claims the row; lets a crashed run self-heal.
    leaseUntil: { type: Date, default: null },

    httpStatus: { type: Number },
    contentHash: { type: String },
    contentType: { type: String },
    renderedWithBrowser: { type: Boolean, default: false },

    // Cheap outcome summary so the admin queue view needs no joins
    candidateScore: { type: Number, default: 0 },
    scholarshipsFound: { type: Number, default: 0 }
  },
  { timestamps: true }
);

crawlTargetSchema.index({ canonicalUrl: 1 }, { unique: true });
crawlTargetSchema.index({ status: 1, nextCrawlAt: 1, priority: -1 });
crawlTargetSchema.index({ domain: 1, status: 1 });
crawlTargetSchema.index({ universityId: 1, targetType: 1 });

export type CrawlTarget = InferSchemaType<typeof crawlTargetSchema>;
export const CrawlTargetModel = model('CrawlTarget', crawlTargetSchema);

// ─────────────────────────────────────────────────────────────────────────────
// CrawlRun (§36) — one execution of the pipeline, with summary metrics.
// ─────────────────────────────────────────────────────────────────────────────

const crawlRunSchema = new Schema(
  {
    kind: {
      type: String,
      enum: ['UNIVERSITY_DISCOVERY', 'SCHOLARSHIP_DISCOVERY', 'CRAWL', 'VERIFY', 'MANUAL'],
      required: true,
      index: true
    },
    trigger: { type: String, enum: ['CRON', 'ADMIN', 'CLI'], default: 'CRON' },
    dryRun: { type: Boolean, default: false },

    state: {
      type: String,
      enum: ['RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED'],
      required: true,
      default: 'RUNNING',
      index: true
    },

    startedAt: { type: Date, required: true, default: Date.now },
    finishedAt: { type: Date },
    durationMs: { type: Number },

    scope: {
      type: new Schema(
        {
          universityId: { type: Schema.Types.ObjectId, ref: 'University' },
          countryCode: { type: String },
          url: { type: String }
        },
        { _id: false }
      ),
      default: () => ({})
    },

    metrics: {
      type: new Schema(
        {
          universitiesDiscovered: { type: Number, default: 0 },
          universitiesVerified: { type: Number, default: 0 },
          universitiesCrawled: { type: Number, default: 0 },
          urlsDiscovered: { type: Number, default: 0 },
          urlsCrawled: { type: Number, default: 0 },
          urlsSkippedUnchanged: { type: Number, default: 0 },
          bytesFetched: { type: Number, default: 0 },
          browserRenders: { type: Number, default: 0 },
          pdfsParsed: { type: Number, default: 0 },
          candidates: { type: Number, default: 0 },
          scholarshipsCreated: { type: Number, default: 0 },
          scholarshipsUpdated: { type: Number, default: 0 },
          duplicatesMerged: { type: Number, default: 0 },
          changesDetected: { type: Number, default: 0 },
          aiCalls: { type: Number, default: 0 },
          aiFailures: { type: Number, default: 0 },
          validationFailures: { type: Number, default: 0 },
          httpFailures: { type: Number, default: 0 },
          blocked: { type: Number, default: 0 }
        },
        { _id: false }
      ),
      default: () => ({})
    },

    error: { type: String, maxlength: 1000 },
    // Bounded — a run log must never grow unboundedly in a single document
    log: { type: [String], default: [] }
  },
  { timestamps: true }
);

crawlRunSchema.index({ startedAt: -1 });
crawlRunSchema.index({ kind: 1, startedAt: -1 });

export type CrawlRun = InferSchemaType<typeof crawlRunSchema>;
export const CrawlRunModel = model('CrawlRun', crawlRunSchema);

// ─────────────────────────────────────────────────────────────────────────────
// ExtractionRun (§20) — audit trail for every extraction attempt, AI or rules.
// ─────────────────────────────────────────────────────────────────────────────

const extractionRunSchema = new Schema(
  {
    crawlRunId: { type: Schema.Types.ObjectId, ref: 'CrawlRun', index: true },
    crawlTargetId: { type: Schema.Types.ObjectId, ref: 'CrawlTarget' },
    scholarshipId: { type: Schema.Types.ObjectId, ref: 'Scholarship', index: true },

    sourceUrl: { type: String, required: true },
    contentHash: { type: String, index: true },

    method: { type: String, enum: EXTRACTION_METHODS, required: true },
    provider: { type: String },
    model: { type: String },

    state: {
      type: String,
      enum: ['SUCCESS', 'VALIDATION_FAILED', 'PROVIDER_FAILED', 'TIMEOUT', 'SKIPPED'],
      required: true,
      index: true
    },

    durationMs: { type: Number },
    promptTokens: { type: Number },
    completionTokens: { type: Number },

    // Raw provider output, truncated. Kept so an admin can see exactly what the
    // model said before validation rejected it (§34).
    rawOutput: { type: String, maxlength: 20000 },
    validationErrors: { type: [String], default: [] },
    error: { type: String, maxlength: 1000 },

    fieldsExtracted: { type: Number, default: 0 },
    confidence: { type: Number, default: 0 }
  },
  { timestamps: true }
);

extractionRunSchema.index({ createdAt: -1 });
extractionRunSchema.index({ state: 1, createdAt: -1 });

export type ExtractionRun = InferSchemaType<typeof extractionRunSchema>;
export const ExtractionRunModel = model('ExtractionRun', extractionRunSchema);

// ─────────────────────────────────────────────────────────────────────────────
// ScholarshipChange (§26) — field-level history; the substrate for alerts (§63).
// ─────────────────────────────────────────────────────────────────────────────

const scholarshipChangeSchema = new Schema(
  {
    scholarshipId: { type: Schema.Types.ObjectId, ref: 'Scholarship', required: true, index: true },
    field: { type: String, required: true, index: true },
    oldValue: { type: Schema.Types.Mixed },
    newValue: { type: Schema.Types.Mixed },

    changeType: {
      type: String,
      enum: ['CREATED', 'UPDATED', 'REMOVED', 'STATUS_CHANGED', 'REOPENED'],
      required: true,
      default: 'UPDATED'
    },
    significance: { type: String, enum: ['MAJOR', 'MINOR'], default: 'MINOR', index: true },

    detectedAt: { type: Date, required: true, default: Date.now },
    sourceUrl: { type: String },
    crawlRunId: { type: Schema.Types.ObjectId, ref: 'CrawlRun' },

    // Future alerting hook (§63) — no channel implementation yet, by design
    notified: { type: Boolean, default: false, index: true }
  },
  { timestamps: false }
);

scholarshipChangeSchema.index({ detectedAt: -1 });
scholarshipChangeSchema.index({ scholarshipId: 1, detectedAt: -1 });
scholarshipChangeSchema.index({ notified: 1, significance: 1, detectedAt: -1 });

export type ScholarshipChange = InferSchemaType<typeof scholarshipChangeSchema>;
export const ScholarshipChangeModel = model('ScholarshipChange', scholarshipChangeSchema);
