import cron from 'node-cron';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runDailyJobForAllSites, runWeeklyIfDueForAllSites, runExecutiveIfDueForAllSites, runMonthlyIfDueForAllSites, runCompetitorCheckIfDueForAllSites, runCompetitorIntelligenceIfDueForAllSites, runAuthorityIfDueForAllSites, runAiRecommendationIfDueForAllSites, runHourlyCatchupForAllSites, runSiteDiscoveryIfDueForAllSites, runFixVerificationsForAllSites, runPrStatusPollForAllSites, runGeoAuditIfDueForAllSites, runGrowthQueryDiscoveryIfDueForAllSites, runAnalystSyncForAllSites, runFixImpactMeasurementsForAllSites, runAutoRemediationForAllSites, runAutoRemediationCatchupForAllSites } from './job.js';
import { SHIP_HOUR_LOCAL } from './lib/ship-window.js';
import { runKeywordNarrativeForAllSites } from './agents/keyword-narrative.js';
import { reapStaleAuditRuns } from './store/audit-runs.js';

const execFileAsync = promisify(execFile);
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

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

      // Shipping runs in the SAME morning pass, immediately after detection,
      // unless SHIP_CRON_SCHEDULE explicitly asks for a separate hour (see
      // below). Sequential rather than a second cron entry at the same hour on
      // purpose: two entries firing at 07:00 would race, and shipping would
      // read a recommendations table detection had not finished filling.
      //
      // Deliberately outside the try above — a detection failure for one site
      // must not cost every OTHER site its PRs, which is the same per-tenant
      // isolation runAutoRemediationForAllSites already applies internally.
      if (!process.env.SHIP_CRON_SCHEDULE) {
        console.log(`[cron] autonomous shipping run started ${new Date().toISOString()}`);
        try {
          const results = await runAutoRemediationForAllSites();
          const shipped = results.reduce((n, r) => n + (r.shipped || 0), 0);
          console.log(`[cron] autonomous shipping run finished — ${shipped} draft(s) shipped across ${results.length} site(s)`);
        } catch (err) {
          console.error('[cron] autonomous shipping run error:', err.message);
        }
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

        // GEO Audit — weekly AI visibility check, same cadence as
        // the weekly doc report. Runs the geo-audit generator for
        // every connected site and stores the result.
        console.log(`[cron] weekly GEO audit started ${new Date().toISOString()}`);
        try {
          const results = await runGeoAuditIfDueForAllSites();
          const completed = results.filter(Boolean);
          console.log(`[cron] weekly GEO audit finished — ${completed.length} site(s) audited`);
        } catch (err) {
          console.error('[cron] weekly GEO audit error:', err.message);
        }

        // Growth Query Discovery — discovers real/LLM-expanded search
        // queries in this site's category, checks content coverage, and
        // verifies previously-drafted queries' visibility over time. Also
        // checked on this weekly trigger but real work only once a week
        // (see job.js's runGrowthQueryDiscoveryIfDue).
        console.log(`[cron] weekly growth query discovery started ${new Date().toISOString()}`);
        try {
          const results = await runGrowthQueryDiscoveryIfDueForAllSites();
          const analyzed = results.filter(Boolean);
          console.log(`[cron] weekly growth query discovery finished — ${analyzed.length} site(s) analyzed`);
        } catch (err) {
          console.error('[cron] weekly growth query discovery error:', err.message);
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

  // OPT-IN SEPARATE SHIPPING HOUR. By default shipping is chained onto the
  // morning detection run above, so the day is one pass: gather, open the
  // PRs, send the mail. Setting SHIP_CRON_SCHEDULE moves shipping back out to
  // its own hour for a deployment that wants detection and shipping apart —
  // e.g. to put a review window between them. Set SHIP_HOUR_LOCAL to the same
  // hour when you do, or the catch-up guard below will disagree with the cron
  // about when the day's work was owed.
  const shipSchedule = process.env.SHIP_CRON_SCHEDULE;
  if (!shipSchedule) {
    console.log(`[cron] autonomous shipping chained to the daily run (set SHIP_CRON_SCHEDULE to separate them)`);
  } else if (!cron.validate(shipSchedule)) {
    console.error(`[cron] invalid SHIP_CRON_SCHEDULE "${shipSchedule}" — autonomous shipping NOT scheduled.`);
  } else {
    cron.schedule(shipSchedule, async () => {
      console.log(`[cron] autonomous shipping run started ${new Date().toISOString()}`);
      try {
        const results = await runAutoRemediationForAllSites();
        const shipped = results.reduce((n, r) => n + (r.shipped || 0), 0);
        console.log(`[cron] autonomous shipping run finished — ${shipped} draft(s) shipped across ${results.length} site(s)`);
      } catch (err) {
        console.error('[cron] autonomous shipping run error:', err.message);
      }
    }, { timezone: tz });
    console.log(`[cron] autonomous shipping scheduled "${shipSchedule}" (${tz})`);
  }

  // Catch-up guard for the shipping run above — the same role the :05 guard
  // plays for the morning job, and for the same recorded reason: cron is not a
  // reliable trigger on a machine that sleeps, and this app runs on one. A
  // missed 13:00 fire would otherwise cost a full day's PR silently. Fires at
  // :35 to stay clear of the other four hourly sweeps. Per-site gating (has
  // this site's own ship hour passed, did it already produce work today) lives
  // in the job, not here, because it depends on each site's timezone.
  cron.schedule('35 * * * *', async () => {
    try {
      await runAutoRemediationCatchupForAllSites(tz);
    } catch (err) {
      console.error('[cron] autonomous shipping catch-up error:', err.message);
    }
  }, { timezone: tz });
  console.log('[cron] autonomous shipping catch-up scheduled (fires at :35 each hour)');

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

  // Impact measurement — the same per-row due check as fix verification above,
  // asking the other question about a merged fix: not "is the issue gone" but
  // "what did it do to real Search Console numbers". Its rows come due ~31 days
  // after a merge (28 days of post-merge data plus GSC's own 3-day lag), so
  // this sweep is almost always a no-op and is cheap when it isn't. Hourly
  // rather than daily for the same reason as the verification sweep: a merge
  // can land at any hour, so nothing should wait for a fixed morning gate.
  cron.schedule('40 * * * *', async () => {
    try {
      await runFixImpactMeasurementsForAllSites();
    } catch (err) {
      console.error('[cron] fix impact measurement error:', err.message);
    }
  }, { timezone: tz });
  console.log('[cron] fix impact measurement scheduled (fires at :40 each hour)');

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

  // Analyst -> Action Center sync. Fires at 04:00 UTC, an hour after
  // data-analyst-agent's own 03:00 UTC nightly cycle
  // (ingest_schedule_hour_utc), so it reads a completed night's insights
  // rather than racing a run in progress. Scheduled in UTC explicitly, not
  // the site timezone, because it is pinned to that service's schedule.
  const analystSync = process.env.ANALYST_SYNC_CRON_SCHEDULE || '0 4 * * *';
  if (!cron.validate(analystSync)) {
    console.error(`[cron] invalid ANALYST_SYNC_CRON_SCHEDULE "${analystSync}" — analyst sync NOT scheduled.`);
  } else {
    cron.schedule(analystSync, async () => {
      try {
        await runAnalystSyncForAllSites();
      } catch (err) {
        console.error('[cron] analyst sync error:', err.message);
      }
    }, { timezone: 'UTC' });
    console.log(`[cron] analyst -> Action Center sync scheduled "${analystSync}" (UTC)`);
  }

  // Stale audit-run reaper — independent safety net alongside the same
  // reapStaleAuditRuns() call at server startup (server/index.js). Startup
  // alone only catches a stuck run on the next deploy/crash-restart; a
  // process that just stays up for days between deploys would otherwise
  // leave a run stuck 'running' (and its Stop Audit button stuck
  // "STOPPING…") until someone restarts it or fixes the row by hand —
  // real incident, 2026-08-10: Run #17 sat 'running' with
  // cancel_requested=true for over an hour with no live process left to
  // notice the flag, fixed manually in the DB.
  cron.schedule('30 * * * *', async () => {
    try {
      const reaped = await reapStaleAuditRuns();
      if (reaped.length) console.log(`[cron] reaped ${reaped.length} stale audit run(s):`, reaped.map((r) => r.id).join(', '));
    } catch (err) {
      console.error('[cron] stale audit-run reap error:', err.message);
    }
  }, { timezone: tz });
  console.log('[cron] stale audit-run reap scheduled (fires at :30 each hour)');

  // Keyword Clustering — standalone Python agent (agents/clustering.py), not
  // a job.js function like the jobs above, so it's spawned as a subprocess
  // instead of imported. Runs every 14 days per its own docstring's
  // suggested cadence; day-of-month */14 lands on the 1st/15th/29th, close
  // enough to "every 14 days" for a re-profiling job. Override with
  // CLUSTERING_CRON_SCHEDULE; override the interpreter with PYTHON_BIN.
  const clustering = process.env.CLUSTERING_CRON_SCHEDULE || '0 3 */14 * *';
  if (!cron.validate(clustering)) {
    console.error(`[cron] invalid CLUSTERING_CRON_SCHEDULE "${clustering}" — keyword clustering NOT scheduled.`);
  } else {
    cron.schedule(
      clustering,
      async () => {
        console.log(`[cron] keyword clustering started ${new Date().toISOString()}`);
        try {
          const { stdout } = await execFileAsync(process.env.PYTHON_BIN || 'python3', ['agents/clustering.py'], { cwd: repoRoot });
          if (stdout.trim()) console.log(stdout.trim());
          console.log('[cron] keyword clustering finished');
        } catch (err) {
          console.error('[cron] keyword clustering error:', err.message);
        }
      },
      { timezone: tz }
    );
    console.log(`[cron] keyword clustering scheduled "${clustering}" (${tz})`);
  }

  // Keyword Narrative — server/agents/keyword-narrative.js, a supplementary
  // narrative synthesizing keyword gaps/clusters/site profile/AI-visibility
  // score. Separate from the Python executive-summary pipeline. Same 14-day
  // cadence as clustering (reads clustering's own output), offset 2 hours
  // later so a fresh clustering run has already landed for the day.
  const keywordNarrative = process.env.KEYWORD_NARRATIVE_CRON_SCHEDULE || '0 5 */14 * *';
  if (!cron.validate(keywordNarrative)) {
    console.error(`[cron] invalid KEYWORD_NARRATIVE_CRON_SCHEDULE "${keywordNarrative}" — keyword narrative NOT scheduled.`);
  } else {
    cron.schedule(
      keywordNarrative,
      async () => {
        console.log(`[cron] keyword narrative started ${new Date().toISOString()}`);
        try {
          const results = await runKeywordNarrativeForAllSites();
          console.log(`[cron] keyword narrative finished (${results.filter((r) => r.status === 'ok').length}/${results.length} ok)`);
        } catch (err) {
          console.error('[cron] keyword narrative error:', err.message);
        }
      },
      { timezone: tz }
    );
    console.log(`[cron] keyword narrative scheduled "${keywordNarrative}" (${tz})`);
  }
}
