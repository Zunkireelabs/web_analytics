import cron from 'node-cron';
import { runDailyJobForAllSites, runWeeklyIfDueForAllSites, runExecutiveIfDueForAllSites, runCompetitorCheckIfDueForAllSites, runHourlyCatchupForAllSites } from './job.js';

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
        const results = await runDailyJobForAllSites();
        console.log(`[cron] daily job finished — ${results.length} site(s) processed`);
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
          const results = await runWeeklyIfDueForAllSites();
          const written = results.filter(Boolean);
          console.log(`[cron] weekly doc report finished — ${written.length} site(s) written`);
        } catch (err) {
          console.error('[cron] weekly doc report error:', err.message);
        }

        // Competitor rankings check runs before the executive report, on the
        // same weekly cron trigger, so the week's executive briefing already
        // has fresh competitor data when it synthesizes — not a separate schedule.
        console.log(`[cron] weekly competitor check started ${new Date().toISOString()}`);
        try {
          const results = await runCompetitorCheckIfDueForAllSites();
          const checked = results.filter(Boolean);
          console.log(`[cron] weekly competitor check finished — ${checked.length} site(s) checked`);
        } catch (err) {
          console.error('[cron] weekly competitor check error:', err.message);
        }

        // AI Executive Report runs right after, on the same weekly cron
        // trigger — not a separate schedule.
        console.log(`[cron] weekly AI executive report started ${new Date().toISOString()}`);
        try {
          const results = await runExecutiveIfDueForAllSites();
          const written = results.filter(Boolean);
          console.log(`[cron] weekly AI executive report finished — ${written.length} site(s) written`);
        } catch (err) {
          console.error('[cron] weekly AI executive report error:', err.message);
        }
      },
      { timezone: tz }
    );
    console.log(`[cron] weekly doc report scheduled "${weekly}" (${tz})`);
  }

  // Hourly catch-up guard: fires every hour and, for every connected site,
  // runs the daily job if it should have run today (past 07:00 local) but
  // the report is still missing. This recovers from sleep-induced missed
  // cron jobs without needing a server restart — independently per site.
  cron.schedule('5 * * * *', async () => {
    try {
      const now = new Date();
      const nowInTz = new Date(now.toLocaleString('en-US', { timeZone: tz }));
      const hourInTz = nowInTz.getHours();
      if (hourInTz < 7) return; // before scheduled time — nothing to recover

      await runHourlyCatchupForAllSites(tz);
    } catch (err) {
      console.error('[cron] hourly guard error:', err.message);
    }
  }, { timezone: tz });
  console.log('[cron] hourly catch-up guard scheduled (fires at :05 each hour)');
}
