import cron from 'node-cron';
import { runDailyJob, runWeeklyIfDue } from './job.js';
import { getOrCreateSite } from './db.js';

// Schedule the daily job. The container's TZ env var makes "07:00" local to the
// site timezone, so it runs after GSC/GA4 have settled for the target dates.
// Override the schedule with CRON_SCHEDULE (standard 5-field cron) if desired.
export function startCron() {
  const schedule = process.env.CRON_SCHEDULE || '0 7 * * *'; // 07:00 daily
  const tz = process.env.TZ || 'Asia/Kolkata';

  if (!cron.validate(schedule)) {
    console.error(`[cron] invalid CRON_SCHEDULE "${schedule}" — daily job NOT scheduled.`);
    return;
  }

  cron.schedule(
    schedule,
    async () => {
      const startedAt = new Date().toISOString();
      console.log(`[cron] daily job started ${startedAt}`);
      try {
        const { reportDate } = await runDailyJob();
        console.log(`[cron] daily job finished — report date ${reportDate}`);
      } catch (err) {
        console.error('[cron] daily job error:', err.message);
      }
    },
    { timezone: tz }
  );

  console.log(`[cron] daily job scheduled "${schedule}" (${tz})`);

  // Weekly Google Doc report — default Thursday 08:00, covering the previous Mon–Sun week.
  const weekly = process.env.WEEKLY_CRON_SCHEDULE || '0 8 * * 4';
  if (!cron.validate(weekly)) {
    console.error(`[cron] invalid WEEKLY_CRON_SCHEDULE "${weekly}" — weekly report NOT scheduled.`);
  } else {
    cron.schedule(
      weekly,
      async () => {
        console.log(`[cron] weekly doc report started ${new Date().toISOString()}`);
        try {
          const site = await getOrCreateSite();
          const r = await runWeeklyIfDue(site);
          if (r) console.log(`[cron] weekly doc report finished — ${r.start}..${r.end} → ${r.url}`);
        } catch (err) {
          console.error('[cron] weekly doc report error:', err.message);
        }
      },
      { timezone: tz }
    );
    console.log(`[cron] weekly doc report scheduled "${weekly}" (${tz})`);
  }
}
