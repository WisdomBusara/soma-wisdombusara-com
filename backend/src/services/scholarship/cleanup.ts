import { logger } from '../../config/logger';
import { ScholarshipModel } from '../../models/scholarship/Scholarship';
import { sendExpiryAlertEmail, sendDiscoveryAlertEmail, emailConfigured } from './delivery/email';

/**
 * Scholarship maintenance:
 * - Remove EXPIRED scholarships (older than 120 days past deadline)
 * - Alert admin when scholarships are cleaned up
 * - Alert admin on new scholarship discoveries
 */

export async function cleanupExpiredScholarships(opts: { adminEmail?: string; dryRun?: boolean } = {}) {
  try {
    // Find scholarships with EXPIRED status
    const expiredScholarships = await ScholarshipModel.find({ status: 'EXPIRED' })
      .select('_id title universityName country')
      .limit(1000)
      .lean();

    if (expiredScholarships.length === 0) {
      logger.info('scholarship-cleanup: no expired scholarships to remove');
      return { removed: 0 };
    }

    const expiredIds = expiredScholarships.map((s) => s._id);

    if (!opts.dryRun) {
      await ScholarshipModel.deleteMany({ _id: { $in: expiredIds } });
    }

    // Send alert email to admin
    if (opts.adminEmail && emailConfigured()) {
      const samples = expiredScholarships.slice(0, 10).map((s) => ({
        title: s.title,
        university: s.universityName ?? null,
        country: s.country ?? null
      }));

      const result = await sendExpiryAlertEmail(opts.adminEmail, expiredScholarships.length, samples);
      if (!result.ok) {
        logger.warn({ error: result.error }, 'scholarship-cleanup: failed to send expiry alert email');
      }
    }

    logger.info({ removed: expiredScholarships.length, dryRun: opts.dryRun }, 'scholarship-cleanup: removed expired scholarships');
    return { removed: expiredScholarships.length };
  } catch (err) {
    logger.error({ err }, 'scholarship-cleanup: cleanup failed');
    throw err;
  }
}

export async function reportNewDiscoveries(opts: { adminEmail?: string; sinceHours?: number } = {}) {
  try {
    const sinceDate = new Date(Date.now() - (opts.sinceHours ?? 24) * 60 * 60 * 1000);

    // Find recently DISCOVERED (newly found, not yet crawled) or OPEN scholarships
    const newScholarships = await ScholarshipModel.find({
      $or: [
        { status: 'DISCOVERED', lastCrawledAt: { $gte: sinceDate } },
        { status: 'OPEN', createdAt: { $gte: sinceDate } }
      ]
    })
      .select('title universityName country')
      .sort({ createdAt: -1 })
      .limit(500)
      .lean();

    if (newScholarships.length === 0) {
      logger.info('scholarship-discovery: no new scholarships to report');
      return { reported: 0 };
    }

    // Send alert email to admin
    if (opts.adminEmail && emailConfigured()) {
      const samples = newScholarships.slice(0, 15).map((s) => ({
        title: s.title,
        university: s.universityName ?? null,
        country: s.country ?? null
      }));

      const result = await sendDiscoveryAlertEmail(opts.adminEmail, newScholarships.length, samples);
      if (!result.ok) {
        logger.warn({ error: result.error }, 'scholarship-discovery: failed to send discovery alert email');
      }
    }

    logger.info({ count: newScholarships.length, sinceHours: opts.sinceHours ?? 24 }, 'scholarship-discovery: reported new scholarships');
    return { reported: newScholarships.length };
  } catch (err) {
    logger.error({ err }, 'scholarship-discovery: report failed');
    throw err;
  }
}
