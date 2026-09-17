import { connectMongo } from '../db/mongo';
import { dispatchDeliveries } from '../services/scholarship/delivery/dispatcher';

/** Manually trigger a delivery run. Usage: npm run scholarships:deliver -- --dry-run */
(async () => {
  await connectMongo();
  const dryRun = process.argv.includes('--dry-run');
  const summary = await dispatchDeliveries({ dryRun, sinceMinutes: 10080 }); // last 7 days
  console.log(JSON.stringify(summary, null, 2));
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
