// One-off manual trigger for the weekly Growth Opportunities -> Action Center
// sync (see job.js's runGrowthOpportunitiesSyncForAllSites, cron.js's
// Monday-00:00-UTC schedule). Use this to run the first batch immediately
// after this feature deploys, instead of waiting for the next Monday cron
// window to come around — every run after that is handled by the cron.
import { runGrowthOpportunitiesSyncForAllSites } from '../job.js';

try {
  const totals = await runGrowthOpportunitiesSyncForAllSites();
  console.log(`[run-growth-opportunities-sync] done —`, totals);
} catch (err) {
  console.error('[run-growth-opportunities-sync] error:', err.message);
  process.exit(1);
}
process.exit(0);
