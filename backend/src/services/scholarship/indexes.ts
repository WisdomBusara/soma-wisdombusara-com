import { logger } from '../../config/logger';
import { UniversityModel } from '../../models/scholarship/University';
import { ScholarshipModel } from '../../models/scholarship/Scholarship';
import {
  ScholarshipSourceModel,
  CrawlTargetModel,
  CrawlRunModel,
  ExtractionRunModel,
  ScholarshipChangeModel
} from '../../models/scholarship/operational';

/**
 * Index provisioning.
 *
 * This exists because db/mongo.ts connects with `autoIndex: NODE_ENV !==
 * 'production'`. That is a sound default — building indexes implicitly on a
 * large production collection can stall a deploy — but it means the scholarship
 * indexes would silently never exist in production.
 *
 * That is not a performance nicety here. Three of these indexes are
 * *correctness* mechanisms:
 *
 *   • University.domain          unique → one institution per domain
 *   • Scholarship.fingerprint    unique → the dedup backstop under concurrency
 *   • ScholarshipSource          unique → idempotent source attachment
 *
 * Without them, two workers crawling the same award concurrently both succeed
 * and the collection silently accumulates duplicates. So this runs explicitly
 * at engine startup and from the CLI, independent of autoIndex.
 *
 * `createIndexes()` is a no-op when the indexes already match, so calling it on
 * every boot is cheap.
 */

const MODELS = [
  { name: 'University', model: UniversityModel },
  { name: 'Scholarship', model: ScholarshipModel },
  { name: 'ScholarshipSource', model: ScholarshipSourceModel },
  { name: 'CrawlTarget', model: CrawlTargetModel },
  { name: 'CrawlRun', model: CrawlRunModel },
  { name: 'ExtractionRun', model: ExtractionRunModel },
  { name: 'ScholarshipChange', model: ScholarshipChangeModel }
];

export async function ensureScholarshipIndexes(): Promise<{ created: string[]; failed: string[] }> {
  const created: string[] = [];
  const failed: string[] = [];

  for (const { name, model } of MODELS) {
    try {
      await model.createIndexes();
      created.push(name);
    } catch (err: any) {
      // A pre-existing collection with duplicate data will reject a unique
      // index. Report it loudly rather than crashing the process — the rest of
      // the engine still works, and the operator needs to see which collection
      // needs cleaning.
      failed.push(`${name}: ${err?.message ?? 'unknown'}`);
      logger.error({ err, model: name }, 'scholarship: index creation failed');
    }
  }

  if (created.length > 0) {
    logger.info({ collections: created.length }, 'scholarship: indexes ensured');
  }
  return { created, failed };
}
