import cron from 'node-cron';
import { runDailyJobForAllSites, runWeeklyIfDueForAllSites, runExecutiveIfDueForAllSites, runMonthlyIfDueForAllSites, runCompetitorCheckIfDueForAllSites, runCompetitorIntelligenceIfDueForAllSites, runAuthorityIfDueForAllSites, runAiRecommendationIfDueForAllSites, runHourlyCatchupForAllSites, runSiteDiscoveryIfDueForAllSites, runFixVerificationsForAllSites, runPrStatusPollForAllSites } from './job.js';

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
        // Site-wide page discovery runs first, before anything else on this
        // trigger — independent of the other three, and cheaper, so the
        // page inventory is fresh before the week's daily agent runs pick
        // it up (see selectCandidatePages in agents/lib/candidate-pages.js).
        console.log(`[cron] weekly site discovery started ${new Date().toISOString()}`);
        try {
          const results = await runSiteDiscoveryIfDueForAllSites();
          const discovered = results.filter(Boolean);
          console.log(`[cron] weekly site discovery finished — ${discovered.length} site(s) discovered`);
        } catch (err) {
          console.error('[cron] weekly site discovery error:', err.message);
        }

        console.log(`[cron] weekly doc report started ${new Date().toISOString()}`);
        try {
          const results = await runWeeklyIfDueForAllSites();
          const written = results.filter(Boolean);
          console.log(`[cron] weekly doc report finished — ${written.length} site(s) written`);
        } catch (err) {
          console.error('[cron] weekly doc report error:', err.message);
        }

        // Real DataForSEO SERP-ranking ingest — checked on this weekly
        // trigger but only actually fetches once a month (see job.js's
        // runCompetitorCheckIfDue), matching the cadence of the real
        // competitor-intelligence analysis below.
        console.log(`[cron] competitor ranking check started ${new Date().toISOString()}`);
        try {
          const results = await runCompetitorCheckIfDueForAllSites();
          const checked = results.filter(Boolean);
          console.log(`[cron] competitor ranking check finished — ${checked.length} site(s) checked`);
        } catch (err) {
          console.error('[cron] competitor ranking check error:', err.message);
        }

        // The real competitor-intelligence AGENT run — also checked on this
        // weekly trigger but only actually analyzes once a month (see
        // job.js's runCompetitorIntelligenceIfDue). Deliberately decoupled
        // from the executive report below (no longer in its meta.requires)
        // so it can have this slower cadence without forcing a fresh
        // competitor crawl every week just because it used to be bundled in.
        console.log(`[cron] competitor intelligence check started ${new Date().toISOString()}`);
        try {
          const results = await runCompetitorIntelligenceIfDueForAllSites();
          const analyzed = results.filter(Boolean);
          console.log(`[cron] competitor intelligence check finished — ${analyzed.length} site(s) analyzed`);
        } catch (err) {
          console.error('[cron] competitor intelligence check error:', err.message);
        }

        // Authority Score — also checked weekly, real work only once a
        // month (see job.js's runAuthorityIfDue). Honestly no-ops per site
        // via the agent's own insufficient-data path when DataForSEO
        // backlink credentials aren't configured.
        console.log(`[cron] authority score check started ${new Date().toISOString()}`);
        try {
          const results = await runAuthorityIfDueForAllSites();
          const analyzed = results.filter(Boolean);
          console.log(`[cron] authority score check finished — ${analyzed.length} site(s) analyzed`);
        } catch (err) {
          console.error('[cron] authority score check error:', err.message);
        }

        // AI Recommendation — also checked weekly, real work only once a
        // month (see job.js's runAiRecommendationIfDue). Honestly no-ops
        // per site via the agent's own insufficient-data path when
        // OPENAI_API_KEY isn't configured.
        console.log(`[cron] AI recommendation check started ${new Date().toISOString()}`);
        try {
          const results = await runAiRecommendationIfDueForAllSites();
          const analyzed = results.filter(Boolean);
          console.log(`[cron] AI recommendation check finished — ${analyzed.length} site(s) analyzed`);
        } catch (err) {
          console.error('[cron] AI recommendation check error:', err.message);
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

        // Monthly Google Doc report — also checked on this weekly trigger but
        // only actually writes once a month (see job.js's runMonthlyIfDue),
        // same "checked weekly, real work only when due" cadence as the
        // competitor/authority/AI-recommendation checks above. Previously
        // this only ran via the manual `npm run monthly` script, so the
        // Reports page's Monthly tab had no doc to link to until someone ran
        // it by hand.
        console.log(`[cron] monthly doc report started ${new Date().toISOString()}`);
        try {
          const results = await runMonthlyIfDueForAllSites();
          const written = results.filter(Boolean);
          console.log(`[cron] monthly doc report finished — ${written.length} site(s) written`);
        } catch (err) {
          console.error('[cron] monthly doc report error:', err.message);
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

  // Verify stage — independent of the hourly catch-up guard above (that one
  // is a per-site "has today's report run" check; this is a per-row
  // "is this fix_verifications check due" check). Fires every hour, every
  // hour, regardless of time of day — a fix can be marked implemented at
  // any time, so its 48h-later re-check shouldn't wait for a 7am gate.
  cron.schedule('10 * * * *', async () => {
    try {
      await runFixVerificationsForAllSites();
    } catch (err) {
      console.error('[cron] fix verification error:', err.message);
    }
  }, { timezone: tz });
  console.log('[cron] fix verification scheduled (fires at :10 each hour)');

  // PR-status polling fallback — independent safety net alongside the
  // GitHub webhook (routes/webhooks.js) for sites where the webhook was
  // never registered or a delivery was missed, so a merged PR's drafts
  // don't stay stranded at 'pr_opened' forever with no automated recovery.
  cron.schedule('20 * * * *', async () => {
    try {
      await runPrStatusPollForAllSites();
    } catch (err) {
      console.error('[cron] pr-status poll error:', err.message);
    }
  }, { timezone: tz });
  console.log('[cron] pr-status poll scheduled (fires at :20 each hour)');
}
