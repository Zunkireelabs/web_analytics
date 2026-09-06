// Standalone daily job runner — invoked directly by launchd StartCalendarInterval.
// This bypasses node-cron entirely so it fires reliably even after Mac sleep/wake.
import { runDailyJob, runWeeklyIfDue } from '../job.js';

try {
  const { site, reportDate } = await runDailyJob();
  console.log(`[launchd-daily] done — report date ${reportDate}`);
  await runWeeklyIfDue(site);
} catch (err) {
  console.error('[launchd-daily] error:', err.message);
  process.exit(1);
}
process.exit(0);
