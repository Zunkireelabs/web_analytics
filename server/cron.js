import cron from 'node-cron';
import { masterTick } from './lib/master-agent.js';
import { getMasterMode, recordPlanError } from './lib/master-agent-control.js';
import { RUN_WINDOW_MS } from './lib/site-run.js';
import { runCompetitorGrowthCycleForAllSites, runCompetitorOutcomeLearningForAllSites, runRankTrackingForAllSites, runPosthogIngestForAllSites } from './job.js';
import { runDailyJobForAllSites, runWeeklyIfDueForAllSites, runExecutiveIfDueForAllSites, runMonthlyIfDueForAllSites, runCompetitorCheckIfDueForAllSites, runCompetitorIntelligenceIfDueForAllSites, runAuthorityIfDueForAllSites, runAiRecommendationIfDueForAllSites, runProspectDiscoveryIfDueForAllSites, runKeywordDemandCheckIfDueForAllSites, runHourlyCatchupForAllSites, runSiteDiscoveryIfDueForAllSites, runFixVerificationsForAllSites, runPrStatusPollForAllSites, runGeoAuditIfDueForAllSites, runGrowthQueryDiscoveryIfDueForAllSites, runAnalystFusionForAllSites, runAnalystSyncForAllSites, runGrowthOpportunitiesSyncForAllSites, runKeywordGapDiscoveryRefreshForAllSites, runKeywordGapShipCycleForAllSites, runFixImpactMeasurementsForAllSites, runAnalystOutcomeSweepForAllSites, runFaqOnboardingCoverageForAllSites, runAutoRemediationForAllSites, runAutoRemediationCatchupForAllSites, runAiVisibilityShipForAllSites, queueDesignAgentDerivationsForAllSites, queueDesignProfileRescanForAllSites, checkDesignChangesForAllSites, queueConsistencyScanForAllSites, runTemplateCapabilityRepairForAllSites, refreshBlockedRecommendationsForAllSites, refreshContentGapRecommendationsForAllSites, runDesignProfileRoleCorrectionForAllSites, runContentRepairForAllSites, runTrendRadarIfDueForAllSites } from './job.js';
import { SHIP_HOUR_LOCAL } from './lib/ship-window.js';
import { runKeywordNarrativeForAllSites } from './agents/keyword-narrative.js';
import { snapshotCapabilityVisibilityForAllSites } from './agents/lib/analyst-seo-mapping.js';
import { reapStaleAuditRuns } from './store/audit-runs.js';
import { reconcileAllSites } from './lib/action-center-reconciler.js';
import { withJobLock, jobKeyFor } from './lib/job-lock.js';
import { runLearningUpdateAfterOutcomes, runDailyLearningUpdate } from './lib/learning-cycle.js';
import { expireStaleClaims } from './agents/lib/work-claims.js';
import { schedulePipelineCron, pipelineOwnsMorning } from './lib/daily-pipeline/cron.js';

// Every scheduled lane runs under a database-backed lease keyed by its name, so two app instances (staging
// and production sharing a database, a second worker, a laptop left running) can never run the same lane at
// the same time. The loser logs and skips; a crashed holder's lease expires on its own (lib/job-lock.js).
// A failure inside the lane is the lane's own to handle; a failure of the lock itself is logged here and
// must never escape a cron callback.
async function locked(name, fn) {
  try {
    const { ran } = await withJobLock(jobKeyFor(name, 'all-sites'), fn);
    if (!ran) console.log(`[cron] ${name} skipped — another process already holds its lock`);
  } catch (err) {
    console.error(`[cron] ${name} could not run:`, err.message);
  }
}

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
      // Locked for the run's whole duration (detection through shipping) —
      // not per sub-step — so a second scheduler hitting this same minute
      // (e.g. a laptop dev server left running alongside the VPS's own cron,
      // the actual 2026-09-08 incident) finds the lock held and skips the
      // entire pass rather than racing one step of it.
      // A failure here (a database blip while taking the lock, say) used to
      // reject out of the cron callback with nothing to catch it, which Node
      // treats as fatal for the whole server.
      try {
        const { ran } = await withJobLock(jobKeyFor('daily-job', 'all-sites'), () => runDailyJobBody());
        if (!ran) console.log('[cron] daily job skipped — another process already holds the lock');
      } catch (err) {
        console.error('[cron] daily job could not run:', err.message);
      }
    },
    { timezone: tz }
  );

  async function runDailyJobBody() {
      // The unified daily pipeline (DAILY_PIPELINE_ENABLED) owns the morning: research, repair, analyst, generate, prepare, then the
      // single 11:00 ship. The legacy chain stands down so nothing runs twice or ships before preparation.
      if (pipelineOwnsMorning()) { console.log('[cron] legacy morning run not started: the daily pipeline owns the morning'); return; }
      let runStartedAt = null;
      const startedAt = new Date().toISOString();
      console.log(`[cron] daily job started ${startedAt}`);
      try {
        // One window for the whole morning run (07:00 to 11:00). Detection may use the first half so there is
        // always time left to ship; the shipping pass below uses the full window.
        runStartedAt = Date.now();
        // Page discovery (weekly, so cheap on every other day) runs FIRST, so the pages it finds today are
        // the ones today's detection and shipping work from, not next week's. It may use the first hour.
        try {
          const found = await runSiteDiscoveryIfDueForAllSites({ windowEndsAt: runStartedAt + RUN_WINDOW_MS / 4 });
          const discovered = found.filter(Boolean).length;
          if (discovered) console.log(`[cron] site discovery before the daily run — ${discovered} site(s) discovered`);
        } catch (err) {
          console.error('[cron] site discovery before the daily run failed:', err.message);
        }
        // Master Agent mode 'on' (chosen on the Platform page, read fresh now): the per-project detection pipeline is run by the Master
        // Agent's queue (lib/master-agent.js), scheduled earlier in the morning, so it is not run a second time here. Everything after
        // this step (repair, shipping) is unchanged. With the default mode (off) or shadow this is exactly the existing call.
        if ((await getMasterMode()) === 'on') {
          console.log('[cron] daily detection is run by the Master Agent queue (mode on) — not repeated here');
        } else {
          const results = await runDailyJobForAllSites({ windowEndsAt: runStartedAt + RUN_WINDOW_MS / 2 });
          console.log(`[cron] daily job finished — ${results.length} site(s) processed`);
        }
      } catch (err) {
        console.error('[cron] daily job error:', err.message);
      }

      // Shared-template ('site-fact') capability repair, right after
      // detection and before shipping — it reads that run's freshly-blocked
      // recommendations and QUEUES its edits (store/shipping-queue.js), the
      // same as repair-site-content-live.js below; it no longer opens a PR
      // of its own. Still run as a separate step BEFORE the shipping run,
      // because unblocking a capability gap here is what lets this same
      // morning's shipping run actually draft the recommendations it was
      // blocking.
      console.log(`[cron] template-capability repair run started ${new Date().toISOString()}`);
      try {
        const results = await runTemplateCapabilityRepairForAllSites();
        const queued = results.filter((r) => r.queued).length;
        console.log(`[cron] template-capability repair run finished — ${queued} site(s) queued for the shared shipping run across ${results.length} site(s)`);
      } catch (err) {
        console.error('[cron] template-capability repair run error:', err.message);
      }

      // Blog-image backfill used to run here as its own direct-PR pass
      // (runBackfillBlogImagesForAllSites), bypassing the Action Center
      // entirely. Replaced 2026-09-01 by agents/blog-image.js (detection) +
      // generators/blog-image.js (repair) — an ordinary safe-tier
      // recommendation now, detected in the DAILY_AGENT_IDS pass below (via
      // runDailyAgentAnalysisForSite, RECOMMENDATION_AGENT_IDS) and shipped
      // by the same autonomous shipping run every other safe-tier fix goes
      // through, with a real Action Center row a human can also review
      // first. No separate cron step needed any more.

      // Role correction FIRST, content repair SECOND — content-repair reads
      // each site's stored componentTemplates, so it must run after any
      // correction to them in the same pass, never before.
      console.log(`[cron] design-profile role correction run started ${new Date().toISOString()}`);
      try {
        const result = await runDesignProfileRoleCorrectionForAllSites();
        console.log(`[cron] design-profile role correction run finished — ${result.changed}/${result.examined} site(s) corrected, ${result.failed} failed`);
      } catch (err) {
        console.error('[cron] design-profile role correction run error:', err.message);
      }

      console.log(`[cron] content repair run started ${new Date().toISOString()}`);
      try {
        const results = await runContentRepairForAllSites();
        const filesRepaired = results.reduce((n, r) => n + (r.changedFiles?.length || 0), 0);
        // Queued, not PR'd — see repair-site-content-live.js's own module
        // comment. Its edits ship in the SAME single PR the shipping run
        // below opens, alongside every other autonomous lane.
        const queued = results.filter((r) => r.queued).length;
        console.log(`[cron] content repair run finished — ${filesRepaired} file(s) repaired, ${queued} site(s) queued for the shared shipping run across ${results.length} site(s)`);
      } catch (err) {
        console.error('[cron] content repair run error:', err.message);
      }

      // Same slot: does any connected site have zero FAQ coverage anywhere?
      // See job.js's runFaqOnboardingCoverageForAllSites / agents/lib/
      // faq-onboarding-check.js. Cheap on every day after the first FAQ
      // ships for a site — this only does real work (a live fetch, maybe a
      // recommendation) for a site that still has none.
      try {
        const { sites, created } = await runFaqOnboardingCoverageForAllSites();
        if (created) console.log(`[cron] FAQ onboarding check finished — ${created} site(s) of ${sites} had no FAQ coverage and got a homepage FAQ recommendation.`);
      } catch (err) {
        console.error('[cron] FAQ onboarding check error:', err.message);
      }

      // Daily blocked-recommendation refresh, right after template-capability
      // repair above so it sees that same run's freshly-healed config. This
      // is the "did anything we already flagged get fixed?" check: it
      // re-validates every open, still-blocked recommendation (excluding
      // content-gap ones — see the weekly pass below) against live gate
      // state and clears/updates blocked_reason so a resolved blocker
      // re-enters the shipping run immediately below rather than sitting
      // stale until its detecting agent happens to re-run.
      console.log(`[cron] blocked-recommendation refresh started ${new Date().toISOString()}`);
      try {
        const results = await refreshBlockedRecommendationsForAllSites();
        const updated = results.reduce((n, r) => n + (r.updated || 0), 0);
        console.log(`[cron] blocked-recommendation refresh finished — ${updated} recommendation(s) updated across ${results.length} site(s)`);
      } catch (err) {
        console.error('[cron] blocked-recommendation refresh error:', err.message);
      }

      // Prompts ticked on the AI visibility page and left for this run become drafts now, so the
      // shipping pass below sees them. A failure here never blocks the shipping pass.
      try {
        const t = await runAiVisibilityShipForAllSites();
        if (t.drafted || t.failed) console.log(`[cron] ai-visibility ship: ${t.drafted} draft(s) made, ${t.failed} failed across ${t.sites} site(s)`);
      } catch (err) {
        console.error('[cron] ai-visibility ship error:', err.message);
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
        // No lock taken here: runAutoRemediationForAllSites takes a PER-SITE
        // shipping lock around each tenant's own run (job.js). A platform-wide
        // key here would undo that — one slow tenant would again stall every
        // other tenant's PR, and a lease expiring mid-pass would let a second
        // process restart the whole multi-site run instead of the one site
        // that stalled.
        console.log(`[cron] autonomous shipping run started ${new Date().toISOString()}`);
        try {
          const results = await runAutoRemediationForAllSites({ windowEndsAt: (runStartedAt ?? Date.now()) + RUN_WINDOW_MS });
          const shipped = results.reduce((n, r) => n + (r.shipped || 0), 0);
          const locked = results.filter((r) => r.skipped === 'locked').length;
          console.log(`[cron] autonomous shipping run finished — ${shipped} draft(s) shipped across ${results.length} site(s)${locked ? `, ${locked} site(s) already shipping elsewhere` : ''}`);
        } catch (err) {
          console.error('[cron] autonomous shipping run error:', err.message);
        }
      }

      // UPDATE LEARNING (Phase 5), last step of the morning pass: record any project-memory change from today's run and
      // re-evaluate shared industry knowledge from measured outcomes. Runs after shipping so it can never delay a PR.
      try {
        const l = await runDailyLearningUpdate();
        console.log(`[cron] daily learning update — ${l.sites} project(s), ${l.changed} memory section(s) changed${l.failed ? `, ${l.failed} failed` : ''}`);
      } catch (err) {
        console.error('[cron] daily learning update error:', err.message);
      }
  }

  console.log(`[cron] daily job scheduled "${schedule}" (${tz})`);
  schedulePipelineCron({ cron, locked });

  // Weekly Google Doc report — default Thursday 08:00, covering the previous Mon–Sun week.
  const weekly = process.env.WEEKLY_CRON_SCHEDULE || '0 8 * * 4';
  if (!cron.validate(weekly)) {
    console.error(`[cron] invalid WEEKLY_CRON_SCHEDULE "${weekly}" — weekly report NOT scheduled.`);
  } else {
    cron.schedule(
      weekly,
      () => locked('weekly-doc-report', async () => {
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

        // Real DataForSEO keyword-demand ingest — also checked on this
        // weekly trigger but only actually fetches once a month (see
        // job.js's runKeywordDemandIfDue), same monthly cadence as the
        // competitor SERP check above. The weekly keyword-gap ship cycle
        // below (runKeywordGapShipCycleForAllSites) then works through this
        // month's real, search-volume-backed gaps across the rest of the
        // month, same as it already does for the LLM-research gaps below.
        console.log(`[cron] keyword demand check started ${new Date().toISOString()}`);
        try {
          const results = await runKeywordDemandCheckIfDueForAllSites();
          const checked = results.filter(Boolean);
          console.log(`[cron] keyword demand check finished — ${checked.length} site(s) checked`);
        } catch (err) {
          console.error('[cron] keyword demand check error:', err.message);
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

        // Prospect Discovery — also checked weekly, real work only once a
        // month (see job.js's runProspectDiscoveryIfDue). Honestly no-ops
        // per site via the agent's own insufficient-data path when the site
        // hasn't opted in (product_growth_config.prospect_discovery_enabled)
        // or has no SERP provider/industries/ICP signals configured.
        console.log(`[cron] prospect discovery check started ${new Date().toISOString()}`);
        try {
          const results = await runProspectDiscoveryIfDueForAllSites();
          const analyzed = results.filter(Boolean);
          console.log(`[cron] prospect discovery check finished — ${analyzed.length} site(s) analyzed`);
        } catch (err) {
          console.error('[cron] prospect discovery check error:', err.message);
        }

        // font-consistency and visual-quality used to run here, on the weekly
        // trigger plus their own monthly/weekly runAgentIfDue throttle. Both
        // moved into the daily 07:00 detection pass on 2026-09-03 (job.js's
        // DAILY_AGENT_IDS) — a design regression ships in one deploy and is
        // visible to every visitor immediately, so it does not belong on a
        // cadence built for backlink profiles.

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
      }),
      { timezone: tz }
    );
    console.log(`[cron] weekly doc report scheduled "${weekly}" (${tz})`);
  }

  // Hourly catch-up guard: fires every hour and, for every connected site,
  // runs the daily job if it should have run today (past 07:00 local) but
  // the report is still missing. This recovers from sleep-induced missed
  // cron jobs without needing a server restart — independently per site.
  cron.schedule('5 * * * *', async () => {
    if (pipelineOwnsMorning()) return; // the pipeline has its own resume guard
    try {
      const now = new Date();
      const nowInTz = new Date(now.toLocaleString('en-US', { timeZone: tz }));
      const hourInTz = nowInTz.getHours();
      if (hourInTz < 7) return; // before scheduled time — nothing to recover

      // Same lock as the daily job itself: this guard's whole reason to
      // exist is recovering a MISSED run, so it must never overlap a run
      // already in progress (this process's own, or another process's).
      const { ran } = await withJobLock(jobKeyFor('daily-job', 'all-sites'), () => runHourlyCatchupForAllSites(tz));
      if (!ran) console.log('[cron] hourly catch-up guard skipped — daily job lock held');
    } catch (err) {
      console.error('[cron] hourly guard error:', err.message);
    }
  }, { timezone: tz });
  console.log('[cron] hourly catch-up guard scheduled (fires at :05 each hour)');

  // MASTER AGENT (lib/master-agent.js). The schedules are ALWAYS registered and each pass reads the mode when it runs
  // (lib/master-agent-control.js getMasterMode: the Platform page's choice, clamped by the MASTER_AGENT_MODE ceiling), so switching
  // the mode needs no restart. While the mode is 'off' a pass returns at once and does nothing.
  //   shadow: plans the day and records what it would run, runs nothing, so the queue can be compared with the existing loop.
  //   on:     keeps instances provisioned, plans, and runs the queued per-project detection jobs; the 07:00 run above then skips
  //           its own detection step. Scheduled BEFORE 07:00 so the day's detection is done when shipping starts.
  // The hourly pass only resumes jobs a previous pass could not finish (a retry, a project that overran, a pass cut off by the 07:00 run);
  // it does nothing unless the mode is 'on'.
  const masterSchedule = process.env.MASTER_AGENT_CRON_SCHEDULE || '0 5 * * *';
  if (!cron.validate(masterSchedule)) {
    console.error(`[cron] invalid MASTER_AGENT_CRON_SCHEDULE "${masterSchedule}" — Master Agent NOT scheduled.`);
  } else {
    // Runs inside a job lock at the schedule lines below. The mode is read first, so an 'off' system does nothing.
    const tick = async (label, { onlyWhenOn = false } = {}) => {
      try {
        const mode = await getMasterMode();
        if (mode === 'off' || (onlyWhenOn && mode !== 'on')) return;
        const out = await masterTick({ mode });
        console.log(`[cron] master agent ${label} (${out.mode}): planned ${out.plan?.planned ?? 0}, ran ${out.drain?.ran ?? 0}${out.drain?.stoppedReason ? `, stopped: ${out.drain.stoppedReason}` : ''}`);
      } catch (err) {
        console.error('[cron] master agent error:', err.message);
        // A failed plan is remembered, so "no failed plans" (the bar for switching On) is a fact and not a hope.
        await recordPlanError({ day: new Date().toISOString().slice(0, 10), message: err.message });
      }
    };
    // Two lanes with their own lock names (the repo's rule is one name per lane). Their jobs are claimed from the queue with SKIP LOCKED,
    // so a catch-up pass that starts while the daily pass is still running only takes jobs nobody holds.
    cron.schedule(masterSchedule, () => locked('master-agent-daily', () => tick('daily pass')), { timezone: tz });
    cron.schedule('50 * * * *', () => locked('master-agent-catchup', () => tick('catch-up pass', { onlyWhenOn: true })), { timezone: tz });
    console.log(`[cron] Master Agent scheduled "${masterSchedule}" (${tz}); its mode is read at each run (off until a platform admin switches it)`);
  }

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
    cron.schedule(shipSchedule, () => locked('autonomous-shipping-run', async () => {
      if (pipelineOwnsMorning()) return; // the pipeline's 11:00 run is the only shipper
      // Per-site locking lives in runAutoRemediationForAllSites — see the
      // chained call above for why there is no platform-wide key here.
      console.log(`[cron] autonomous shipping run started ${new Date().toISOString()}`);
      try {
        const results = await runAutoRemediationForAllSites({ windowEndsAt: Date.now() + RUN_WINDOW_MS });
        const shipped = results.reduce((n, r) => n + (r.shipped || 0), 0);
        console.log(`[cron] autonomous shipping run finished — ${shipped} draft(s) shipped across ${results.length} site(s)`);
      } catch (err) {
        console.error('[cron] autonomous shipping run error:', err.message);
      }
    }), { timezone: tz });
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
      // Takes the same per-site shipping lock the scheduled run takes, inside
      // its own loop — so this guard can never open a second batch alongside
      // a run already in flight for that site, while still being free to
      // recover a DIFFERENT site whose morning run was missed.
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
  cron.schedule('10 * * * *', () => locked('fix-verification', async () => {
    try {
      await runFixVerificationsForAllSites();
    } catch (err) {
      console.error('[cron] fix verification error:', err.message);
    }
  }), { timezone: tz });
  console.log('[cron] fix verification scheduled (fires at :10 each hour)');

  // Impact measurement — the same per-row due check as fix verification above,
  // asking the other question about a merged fix: not "is the issue gone" but
  // "what did it do to real Search Console numbers". Its rows come due ~31 days
  // after a merge (28 days of post-merge data plus GSC's own 3-day lag), so
  // this sweep is almost always a no-op and is cheap when it isn't. Hourly
  // rather than daily for the same reason as the verification sweep: a merge
  // can land at any hour, so nothing should wait for a fixed morning gate.
  cron.schedule('40 * * * *', () => locked('fix-impact-sweep', async () => {
    let impactResults = [];
    try {
      impactResults = await runFixImpactMeasurementsForAllSites();
    } catch (err) {
      console.error('[cron] fix impact measurement error:', err.message);
    }
    // UPDATE LEARNING (Phase 5): only for projects that just got a real measured outcome. Best-effort; never blocks the sweep.
    try {
      const l = await runLearningUpdateAfterOutcomes(impactResults);
      if (l.sites) console.log(`[cron] learning updated after ${l.sites} measured project(s) — ${l.changed} memory section(s) changed`);
    } catch (err) {
      console.error('[cron] learning update after outcomes error:', err.message);
    }
    // Same hour, right after: carries any measurement fix-impact.js just
    // wrote back onto the analyst_evidence row that produced it (see
    // agents/lib/analyst-outcome.js). Cheap and almost always a no-op, same
    // reasoning as the sweep above.
    try {
      await runAnalystOutcomeSweepForAllSites();
    } catch (err) {
      console.error('[cron] analyst outcome sweep error:', err.message);
    }
  }), { timezone: tz });
  console.log('[cron] fix impact measurement + analyst outcome sweep scheduled (fires at :40 each hour)');

  // PR-status polling fallback — independent safety net alongside the
  // GitHub webhook (routes/webhooks.js) for sites where the webhook was
  // never registered or a delivery was missed, so a merged PR's drafts
  // don't stay stranded at 'pr_opened' forever with no automated recovery.
  cron.schedule('20 * * * *', () => locked('pr-status-poll', async () => {
    try {
      await runPrStatusPollForAllSites();
    } catch (err) {
      console.error('[cron] pr-status poll error:', err.message);
    }
  }), { timezone: tz });
  console.log('[cron] pr-status poll scheduled (fires at :20 each hour)');

  // Action Center reconciliation — returns recommendations whose attempt
  // stopped moving to the board, on the row they already had.
  //
  // Runs AFTER the :20 PR poll above. That poll is what resolves every draft
  // whose PR actually reached a verdict, so by the time this runs the only
  // drafts left without a PR are ones that genuinely have none. The other
  // order would have the reconciler judging drafts as stalled in the same
  // hour the poll was about to mark them merged.
  //
  // Moved from :35 to :45 because the auto-remediation ship catch-up also
  // fires at :35: the reconciler judges an attempt stalled and reclaims it
  // while that same attempt may be mid-ship in another process, on the same
  // rows. The lock below is the real guard (two hosts would collide whatever
  // minute each is scheduled for); the minute change just stops the two
  // lanes from contending every hour on a single host.
  cron.schedule('45 * * * *', async () => {
    try {
      const { ran } = await withJobLock(jobKeyFor('action-center-reconcile', 'all-sites'), async () => {
        const { totals } = await reconcileAllSites();
        if (totals.reclaimed || totals.classified || totals.capabilityGapsDetected) {
          console.log(`[cron] action-center reconcile: reclaimed ${totals.reclaimed}, reopened ${totals.reopened}, classified ${totals.classified}, blocked ${totals.blocked}, resolved ${totals.resolved}, capabilityGaps ${totals.capabilityGapsDetected}`);
        }
        // Same lane, same lease, same 24h window: a work claim and the
        // attempt it guards are two halves of one thing, and reclaiming one
        // without the other would leave a page owned by a producer whose
        // attempt had already been handed back to the board.
        const expired = await expireStaleClaims();
        if (expired) console.log(`[cron] work-claims: expired ${expired} abandoned claim(s)`);
      });
      if (!ran) console.log('[cron] action-center reconcile skipped — another process holds the lock');
    } catch (err) {
      console.error('[cron] action-center reconcile error:', err.message);
    }
  }, { timezone: tz });
  console.log('[cron] action-center reconcile scheduled (fires at :45 each hour)');

  // Analyst -> Action Center sync. Ordering is the whole point of the hour
  // chosen here, and it is easy to get wrong because the two halves of this
  // file run on different clocks: the morning run is scheduled in the app's
  // TZ (Asia/Kolkata by default), while this and the Python pipeline are
  // pinned to UTC.
  //
  // The full chain, in UTC:
  //   22:00  data-analyst-agent nightly pipeline (host crontab, deploy-staging.yml)
  //   00:00  this sync — carries the night's recommendations into the Action Center
  //   01:30  the morning run (07:00 Asia/Kolkata) detects, ships and mails
  //
  // It used to fire at 04:00 UTC, which is 09:30 Asia/Kolkata — ninety minutes
  // AFTER the morning run had already opened the day's PRs, so analyst findings
  // sat unused until the next day. Two hours ahead of the run now, rather than
  // one, because the pipeline it reads is the long pole (forecasts, ML, LLM
  // narration) and a slow night must not push its output past the run.
  const analystSync = process.env.ANALYST_SYNC_CRON_SCHEDULE || '0 0 * * *';
  if (!cron.validate(analystSync)) {
    console.error(`[cron] invalid ANALYST_SYNC_CRON_SCHEDULE "${analystSync}" — analyst sync NOT scheduled.`);
  } else {
    cron.schedule(analystSync, async () => {
      if (pipelineOwnsMorning()) return; // the pipeline's analyst stage runs fusion and the sync after the Python findings_complete marker
      // The fusion pass runs first, same slot: it reads the exact same
      // 03:00 UTC nightly pipeline output as the sync below, combines it
      // with decline-detection's own signals, and ships only corroborated,
      // freshness-gated conclusions. See job.js's runAnalystFusionForAllSites
      // doc comment for why the older sync below still runs after it rather
      // than being replaced.
      //
      // Both halves take their OWN lease rather than sharing one. These are
      // the UTC-scheduled producers, and until now they took no lock at all:
      // a laptop dev server and the VPS both reach 00:00 UTC and both run
      // them against the same database, which is exactly the failure
      // job_locks (147) was built for after the 07:00 run doubled its API
      // calls on 2026-09-08. Separate lanes so a slow fusion cannot starve
      // the sync behind it.
      try {
        const { ran } = await withJobLock(jobKeyFor('analyst-fusion', 'all-sites'), () => runAnalystFusionForAllSites());
        if (!ran) console.log('[cron] analyst fusion skipped — another process holds the lock');
      } catch (err) {
        console.error('[cron] analyst fusion error:', err.message);
      }
      try {
        const { ran } = await withJobLock(jobKeyFor('analyst-sync', 'all-sites'), () => runAnalystSyncForAllSites());
        if (!ran) console.log('[cron] analyst sync skipped — another process holds the lock');
      } catch (err) {
        console.error('[cron] analyst sync error:', err.message);
      }
    }, { timezone: 'UTC' });
    console.log(`[cron] analyst fusion + Action Center sync scheduled "${analystSync}" (UTC)`);
  }

  // Growth Opportunities -> Action Center sync, weekly. Growth Opportunities
  // is a read-time view over the trailing 30 days of gsc_query_page (see
  // growth-opportunities.js) — it has no nightly cadence of its own the way
  // the Analyst's insights do, so unlike the daily sync above this runs once
  // a week, same 00:00 UTC slot but Monday-only, still 1.5h ahead of the
  // 01:30 UTC (07:00 Asia/Kolkata) morning run so the week's first batch of
  // opportunity-derived recommendations is already sitting in Action Center
  // before that run opens the day's PRs.
  const growthOppsSync = process.env.GROWTH_OPPORTUNITIES_SYNC_CRON_SCHEDULE || '0 0 * * 1';
  if (!cron.validate(growthOppsSync)) {
    console.error(`[cron] invalid GROWTH_OPPORTUNITIES_SYNC_CRON_SCHEDULE "${growthOppsSync}" — growth opportunities sync NOT scheduled.`);
  } else {
    cron.schedule(growthOppsSync, async () => {
      // Same reasoning as the analyst lanes above: UTC-scheduled, previously
      // unlocked, and therefore double-run by any second host.
      try {
        const { ran } = await withJobLock(jobKeyFor('growth-opps-sync', 'all-sites'), () => runGrowthOpportunitiesSyncForAllSites());
        if (!ran) console.log('[cron] growth opportunities sync skipped — another process holds the lock');
      } catch (err) {
        console.error('[cron] growth opportunities sync error:', err.message);
      }

      // Content-gap autonomous shipping, same Monday slot — deliberately NOT
      // a second cron.schedule call: discovery/observation refresh and
      // shipping both run every Monday here (see
      // runKeywordGapShipCycleForAllSites's own comment for why
      // shipping is no longer gated by a per-site 14-day cooldown).
      try {
        const { ran } = await withJobLock(jobKeyFor('keyword-gap-refresh', 'all-sites'), () => runKeywordGapDiscoveryRefreshForAllSites());
        if (!ran) console.log('[cron] keyword-gap discovery refresh skipped — another process holds the lock');
      } catch (err) {
        console.error('[cron] keyword-gap discovery refresh error:', err.message);
      }
      // The ship cycle writes real drafts and PRs, so a double-run here costs
      // duplicated content, not just duplicated reads.
      try {
        const { ran } = await withJobLock(jobKeyFor('keyword-gap-ship', 'all-sites'), () => runKeywordGapShipCycleForAllSites());
        if (!ran) console.log('[cron] keyword-gap ship cycle skipped — another process holds the lock');
      } catch (err) {
        console.error('[cron] keyword-gap ship cycle error:', err.message);
      }
    }, { timezone: 'UTC' });
    console.log(`[cron] growth opportunities -> Action Center sync scheduled "${growthOppsSync}" (UTC)`);
  }

  // Proactive Design Agent trigger — one hour ahead of the 07:00 detect+ship
  // run, and half an hour after analyst sync above has landed. Before this
  // existed, a site's whole-site design profile was only ever queued
  // REACTIVELY, the first time a draft attempt needed it — which for a site
  // with no profile yet meant the very same 07:00 pass, racing
  // design-drift.js's bounded wait (DESIGN_AGENT_WAIT_MS) instead of having
  // real lead time to finish the repo analysis. This gives every site
  // connected overnight a full hour of head start, so the bounded wait
  // becomes a safety net for same-morning-connected sites, not the main path.
  // Override with DESIGN_AGENT_QUEUE_CRON_SCHEDULE if a deployment needs a
  // different gap ahead of its own CRON_SCHEDULE.
  const designAgentQueue = process.env.DESIGN_AGENT_QUEUE_CRON_SCHEDULE || '0 6 * * *';
  if (!cron.validate(designAgentQueue)) {
    console.error(`[cron] invalid DESIGN_AGENT_QUEUE_CRON_SCHEDULE "${designAgentQueue}" — proactive design-agent queue NOT scheduled.`);
  } else {
    cron.schedule(designAgentQueue, () => locked('design-agent-queue', async () => {
      try {
        const { queued } = await queueDesignAgentDerivationsForAllSites();
        console.log(`[cron] proactive design-agent queue finished — ${queued} site(s) queued`);
      } catch (err) {
        console.error('[cron] proactive design-agent queue error:', err.message);
      }
    }), { timezone: tz });
    console.log(`[cron] proactive design-agent queue scheduled "${designAgentQueue}" (${tz})`);
  }

  // Trend Radar — every two weeks. The cron fires EVERY MORNING at 06:30 and
  // runTrendRadarIfDue decides per site whether a fortnight has passed since
  // its last successful run (agents/lib/trend-cadence.js, judged in the site's
  // own timezone). Daily rather than a fixed day pair, so a run that fails on
  // its day (feed outage, no industry yet) is retried the next morning instead
  // of costing a fortnight, and a site onboarded mid-cycle is picked up
  // without waiting for a particular date. A not-due site costs one indexed
  // query. Override with TREND_RADAR_CRON_SCHEDULE.
  const trendRadarSchedule = process.env.TREND_RADAR_CRON_SCHEDULE || '30 6 * * *';
  if (!cron.validate(trendRadarSchedule)) {
    console.error(`[cron] invalid TREND_RADAR_CRON_SCHEDULE "${trendRadarSchedule}" — trend radar NOT scheduled.`);
  } else {
    cron.schedule(trendRadarSchedule, () => locked('trend-radar', async () => {
      try {
        const results = (await runTrendRadarIfDueForAllSites()).filter(Boolean);
        console.log(`[cron] trend radar finished — ${results.length} site(s) analyzed`);
      } catch (err) {
        console.error('[cron] trend radar error:', err.message);
      }
    }), { timezone: tz });
    console.log(`[cron] trend radar scheduled "${trendRadarSchedule}" (${tz})`);
  }

  // Competitor growth cycle — market discovery, rival footprints, and scored opportunities into the EXISTING
  // keyword_gaps queue. OFF for every site until sites.competitor_growth_enabled is set (migration 236 defaults it
  // to false), so this entry costs one indexed query a night until a site is deliberately opted in.
  //
  // Fires every morning and asks each opted-in site whether COMPETITOR_GROWTH_INTERVAL_DAYS have passed, the same
  // shape as trend radar above and for the same reasons: a night that fails (provider outage, budget reached) is
  // retried the next morning instead of costing a whole interval, and a newly opted-in site is picked up without
  // waiting for a particular weekday. Scheduled at 05:15, before the morning detection run, so opportunities found
  // today are in the queue for today's work rather than tomorrow's.
  //
  // It creates no draft, no PR and no recommendation: the weekly keyword-gap ship cycle, the recommendation gates
  // and a human merge remain the only path from an opportunity to a client's site.
  const competitorGrowthSchedule = process.env.COMPETITOR_GROWTH_CRON_SCHEDULE || '15 5 * * *';
  if (!cron.validate(competitorGrowthSchedule)) {
    console.error(`[cron] invalid COMPETITOR_GROWTH_CRON_SCHEDULE "${competitorGrowthSchedule}" — competitor growth NOT scheduled.`);
  } else {
    cron.schedule(competitorGrowthSchedule, () => locked('competitor-growth', async () => {
      try {
        const totals = await runCompetitorGrowthCycleForAllSites();
        if (totals.sites) {
          console.log(`[cron] competitor growth finished — ${totals.ran} site(s) ran, ${totals.skipped} not due, ${totals.opportunities} new opportunity(ies), $${totals.costUsd.toFixed(4)} spent`);
        }
      } catch (err) {
        console.error('[cron] competitor growth error:', err.message);
      }
    }), { timezone: tz });
    console.log(`[cron] competitor growth scheduled "${competitorGrowthSchedule}" (${tz})`);
  }

  // Stage -> main promotion for clients that review on a stage branch: once a person has merged a batch PR on stage, the agent
  // opens the promotion PR (never merges it). Hourly, one cheap query when no client uses a stage branch.
  const stagePromotionSchedule = process.env.STAGE_PROMOTION_CRON_SCHEDULE || '25 * * * *';
  if (!cron.validate(stagePromotionSchedule)) {
    console.error(`[cron] invalid STAGE_PROMOTION_CRON_SCHEDULE "${stagePromotionSchedule}" — stage promotion NOT scheduled.`);
  } else {
    cron.schedule(stagePromotionSchedule, () => locked('stage-promotion', async () => {
      try {
        const { runStagePromotionForAllSites } = await import('./lib/stage-promotion.js');
        const totals = await runStagePromotionForAllSites();
        if (totals.opened || totals.blocked || totals.failed) console.log(`[cron] stage promotion — ${totals.opened} promotion PR(s) opened, ${totals.waiting} waiting on stage checks, ${totals.blocked} blocked, ${totals.failed} failed, of ${totals.sites} client(s)`);
      } catch (err) {
        console.error('[cron] stage promotion error:', err.message);
      }
    }), { timezone: tz });
    console.log(`[cron] stage promotion scheduled "${stagePromotionSchedule}" (${tz})`);
  }

  // PostHog daily ingest — only for projects that connected it. Costs nothing: it reads the client's own PostHog
  // with the client's own key, so unlike the DataForSEO lanes there is no provider bill and no budget to respect.
  // A platform where nobody uses PostHog does one indexed query a night and stops.
  //
  // 03:40, after the day has fully closed in most timezones and before the morning analysis, so a fresh day of
  // product data is available to the same morning's work.
  const posthogSchedule = process.env.POSTHOG_CRON_SCHEDULE || '40 3 * * *';
  if (!cron.validate(posthogSchedule)) {
    console.error(`[cron] invalid POSTHOG_CRON_SCHEDULE "${posthogSchedule}" — PostHog ingest NOT scheduled.`);
  } else {
    cron.schedule(posthogSchedule, () => locked('posthog-ingest', async () => {
      try {
        const totals = await runPosthogIngestForAllSites();
        if (totals.sites) {
          console.log(`[cron] posthog ingest finished — ${totals.ingested} site(s) ingested, ${totals.failed} failed, of ${totals.sites} connected`);
        }
      } catch (err) {
        console.error('[cron] posthog ingest error:', err.message);
      }
    }), { timezone: tz });
    console.log(`[cron] posthog ingest scheduled "${posthogSchedule}" (${tz})`);
  }

  // Rank tracking — where each opted-in site actually ranks for the keywords it chose to watch. OFF until
  // sites.rank_tracking_enabled is set, and each site's own rank_tracking_max_keywords ceiling bounds the spend, so
  // this entry costs one indexed query a night until a site is deliberately switched on.
  //
  // Fires daily and asks each site whether RANK_TRACKING_INTERVAL_DAYS have passed, for the same reason as the
  // entries above: a night that fails is retried tomorrow rather than costing a whole interval. Scheduled at 04:30,
  // before the competitor cycle, so a fresh position is available to the opportunity scorer the same morning.
  const rankTrackingSchedule = process.env.RANK_TRACKING_CRON_SCHEDULE || '30 4 * * *';
  if (!cron.validate(rankTrackingSchedule)) {
    console.error(`[cron] invalid RANK_TRACKING_CRON_SCHEDULE "${rankTrackingSchedule}" — rank tracking NOT scheduled.`);
  } else {
    cron.schedule(rankTrackingSchedule, () => locked('rank-tracking', async () => {
      try {
        const totals = await runRankTrackingForAllSites();
        if (totals.sites) {
          console.log(`[cron] rank tracking finished — ${totals.ran} site(s) ran, ${totals.skipped} not due, ${totals.keywords} keyword(s) checked, $${totals.costUsd.toFixed(4)} spent`);
        }
      } catch (err) {
        console.error('[cron] rank tracking error:', err.message);
      }
    }), { timezone: tz });
    console.log(`[cron] rank tracking scheduled "${rankTrackingSchedule}" (${tz})`);
  }

  // Competitor outcome learning — DAILY and free: advances each opted-in site's opportunity lifecycle from the
  // records the pipeline already wrote (drafts, deployments, fix_impact) and counts any outcome that has newly
  // reached a MEASURED result. Separate from the cycle above because it makes no provider call: a measured result
  // should reach the scorer close to when it was measured, not wait for the next paid interval. Runs after the
  // evening impact measurements have landed.
  const competitorOutcomeSchedule = process.env.COMPETITOR_OUTCOME_CRON_SCHEDULE || '45 23 * * *';
  if (!cron.validate(competitorOutcomeSchedule)) {
    console.error(`[cron] invalid COMPETITOR_OUTCOME_CRON_SCHEDULE "${competitorOutcomeSchedule}" — competitor outcome learning NOT scheduled.`);
  } else {
    cron.schedule(competitorOutcomeSchedule, () => locked('competitor-outcomes', async () => {
      try {
        const totals = await runCompetitorOutcomeLearningForAllSites();
        if (totals.advanced || totals.counted) {
          console.log(`[cron] competitor outcomes finished — ${totals.advanced} lifecycle change(s), ${totals.counted} verified outcome(s) counted across ${totals.sites} site(s)`);
        }
      } catch (err) {
        console.error('[cron] competitor outcome learning error:', err.message);
      }
    }), { timezone: tz });
    console.log(`[cron] competitor outcome learning scheduled "${competitorOutcomeSchedule}" (${tz})`);
  }

  // MONTHLY (was weekly): the design captured when a project first connects is
  // the source of truth; a monthly look is enough to catch a real redesign.
  // Design Context refresh — a live-site analysis is a durable asset
  // (see live-analysis-handler.js), not something re-derived per draft, so
  // this is the one place a real site redesign gets picked up: once a week,
  // every site whose profile is older than 7 days gets a fresh analysis
  // queued. Deliberately its OWN cron entry rather than folded into the
  // proactive queue above — that one only ever handles a site's FIRST
  // derivation (queueDesignAgentDerivationForSite short-circuits once a
  // usable profile exists), so a weekly cadence here is what keeps an
  // already-derived profile from going stale forever. Scheduled the same
  // morning-before-detection slot as the queue above (30 minutes ahead of
  // it) so a rescanned site's fresh profile is what the day's drafts use,
  // not last week's — a rescan is a single fast browser + one LLM call now
  // (no Docker/OpenHands container), so it comfortably finishes in that
  // window. Weekly, not daily: a site's design doesn't change often enough
  // to justify a live crawl of it every single morning.
  const designProfileRescan = process.env.DESIGN_AGENT_RESCAN_CRON_SCHEDULE || '30 5 1 * *'; // 05:30 on the 1st of each month
  if (!cron.validate(designProfileRescan)) {
    console.error(`[cron] invalid DESIGN_AGENT_RESCAN_CRON_SCHEDULE "${designProfileRescan}" — monthly design-context rescan NOT scheduled.`);
  } else {
    cron.schedule(designProfileRescan, () => locked('design-profile-rescan', async () => {
      try {
        const { queued } = await queueDesignProfileRescanForAllSites();
        console.log(`[cron] weekly design-context rescan finished — ${queued} site(s) queued`);
      } catch (err) {
        console.error('[cron] weekly design-context rescan error:', err.message);
      }
    }), { timezone: tz });
    console.log(`[cron] weekly design-context rescan scheduled "${designProfileRescan}" (${tz})`);
  }

  // Weekly CHEAP change check (stylesheet hash) — the full capture above is
  // monthly, so this is what catches a redesign in between. Monday, an hour
  // ahead of the other design jobs.
  const designChangeCheck = process.env.DESIGN_CHANGE_CHECK_CRON_SCHEDULE || '30 4 * * 1';
  if (!cron.validate(designChangeCheck)) {
    console.error(`[cron] invalid DESIGN_CHANGE_CHECK_CRON_SCHEDULE "${designChangeCheck}" — weekly design-change check NOT scheduled.`);
  } else {
    cron.schedule(designChangeCheck, () => locked('design-change-check', async () => {
      try {
        const { checked, changed } = await checkDesignChangesForAllSites();
        console.log(`[cron] design-change check finished — ${checked} site(s) checked, ${changed} re-capture(s) queued`);
      } catch (err) {
        console.error('[cron] design-change check error:', err.message);
      }
    }), { timezone: tz });
    console.log(`[cron] design-change check scheduled "${designChangeCheck}" (${tz})`);
  }

  // Weekly whole-site design-consistency scan — one day AFTER the profile
  // rescan above (Tuesday, not Monday), so a site whose profile just
  // refreshed is compared against ITS OWN fresh understanding, not last
  // week's. This is the check that covers a page/section OUTSIDE the daily
  // content-repair pass's SEOAI-marker scope — a hand-written table, a
  // legacy section, a legal page's own body content. Genuinely expensive
  // (a real headless-browser capture per page type), hence weekly, hence
  // its own cron entry rather than folded into anything daily.
  const consistencyScan = process.env.DESIGN_AGENT_CONSISTENCY_SCAN_CRON_SCHEDULE || '30 5 2 * *'; // 05:30 on the 2nd of each month
  if (!cron.validate(consistencyScan)) {
    console.error(`[cron] invalid DESIGN_AGENT_CONSISTENCY_SCAN_CRON_SCHEDULE "${consistencyScan}" — monthly consistency scan NOT scheduled.`);
  } else {
    cron.schedule(consistencyScan, () => locked('design-consistency-scan', async () => {
      try {
        const { queued } = await queueConsistencyScanForAllSites();
        console.log(`[cron] weekly design-consistency scan finished — ${queued} site(s) queued`);
      } catch (err) {
        console.error('[cron] weekly design-consistency scan error:', err.message);
      }
    }), { timezone: tz });
    console.log(`[cron] weekly design-consistency scan scheduled "${consistencyScan}" (${tz})`);
  }

  // Daily content-gap recommendation refresh — the content-gap counterpart
  // to the daily blocked-recommendation refresh above. A blog-outline/
  // landing-page/comparison-page/gap-based-faq recommendation is created
  // once, at the moment a human (or the MCP tool) approves that keyword gap
  // (analyst-seo-mapping.js's createActionCenterRecommendationForGap) —
  // that agent never re-runs as part of the daily grounded detection pass,
  // so nothing else ever revisits its block state afterward. Used to run
  // weekly (Monday only) on the theory that content-gap config doesn't
  // change often enough to check every morning, but in practice that let
  // resolved blockers (e.g. a url_file_map/newContentTargets fix shipped
  // mid-week) sit shown as "Blocked" in Action Center for up to 6 days
  // after the fix landed — moved to the same daily cadence as
  // refreshBlockedRecommendations above so a fix is reflected the next
  // morning. Still explicitly NOT automatic content generation/drafting —
  // it only re-validates and clears/updates blocked_reason on rows that
  // already exist, the same "investigate the live gate state, never guess"
  // contract refreshBlockedRecommendations uses everywhere else.
  const contentGapRefresh = process.env.CONTENT_GAP_REFRESH_CRON_SCHEDULE || '0 5 * * *'; // 05:00 every day
  if (!cron.validate(contentGapRefresh)) {
    console.error(`[cron] invalid CONTENT_GAP_REFRESH_CRON_SCHEDULE "${contentGapRefresh}" — content-gap refresh NOT scheduled.`);
  } else {
    cron.schedule(contentGapRefresh, () => locked('content-gap-refresh', async () => {
      try {
        const results = await refreshContentGapRecommendationsForAllSites();
        const updated = results.reduce((n, r) => n + (r.updated || 0), 0);
        console.log(`[cron] content-gap refresh finished — ${updated} recommendation(s) updated across ${results.length} site(s)`);
      } catch (err) {
        console.error('[cron] content-gap refresh error:', err.message);
      }
    }), { timezone: tz });
    console.log(`[cron] content-gap refresh scheduled "${contentGapRefresh}" (${tz})`);
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
  cron.schedule('30 * * * *', () => locked('audit-run-reap', async () => {
    try {
      const reaped = await reapStaleAuditRuns();
      if (reaped.length) console.log(`[cron] reaped ${reaped.length} stale audit run(s):`, reaped.map((r) => r.id).join(', '));
    } catch (err) {
      console.error('[cron] stale audit-run reap error:', err.message);
    }
  }), { timezone: tz });
  console.log('[cron] stale audit-run reap scheduled (fires at :30 each hour)');

  // Keyword Narrative — server/agents/keyword-narrative.js, a supplementary
  // narrative synthesizing keyword gaps/clusters/site profile/AI-visibility
  // score. Separate from the Python executive-summary pipeline. Real keyword
  // clustering itself now runs inside data-analyst-agent's nightly pipeline
  // (KeywordClusteringCollector, self-gated to a real per-site 14-day
  // interval via RECLUSTER_INTERVAL_DAYS) — the standalone agents/
  // clustering.py subprocess this job used to run alongside was deleted
  // 2026-08-11 when that migration happened, silently ENOENT'ing on every
  // firing since (caught and logged, never surfaced) until removed here.
  // Same nominal 14-day cadence as before, offset 2 hours into the morning
  // so a nightly (22:00 UTC) clustering pass has already landed.
  const keywordNarrative = process.env.KEYWORD_NARRATIVE_CRON_SCHEDULE || '0 5 */14 * *';
  if (!cron.validate(keywordNarrative)) {
    console.error(`[cron] invalid KEYWORD_NARRATIVE_CRON_SCHEDULE "${keywordNarrative}" — keyword narrative NOT scheduled.`);
  } else {
    cron.schedule(
      keywordNarrative,
      () => locked('keyword-narrative', async () => {
        console.log(`[cron] keyword narrative started ${new Date().toISOString()}`);
        try {
          const results = await runKeywordNarrativeForAllSites();
          console.log(`[cron] keyword narrative finished (${results.filter((r) => r.status === 'ok').length}/${results.length} ok)`);
        } catch (err) {
          console.error('[cron] keyword narrative error:', err.message);
        }
      }),
      { timezone: tz }
    );
    console.log(`[cron] keyword narrative scheduled "${keywordNarrative}" (${tz})`);
  }

  // Capability Visibility Snapshot — product-visibility growth objective,
  // Phase 5 (server/agents/lib/analyst-seo-mapping.js's
  // snapshotCapabilityVisibility). Same 14-day cadence and same reasoning as
  // keyword narrative above: reads clustering's freshly-written output, so
  // it runs after clustering has landed — offset 3 hours (one hour after
  // narrative) purely to avoid three jobs racing on the same data at once,
  // not because of an actual dependency on narrative's own output.
  const capabilitySnapshot = process.env.CAPABILITY_SNAPSHOT_CRON_SCHEDULE || '0 6 */14 * *';
  if (!cron.validate(capabilitySnapshot)) {
    console.error(`[cron] invalid CAPABILITY_SNAPSHOT_CRON_SCHEDULE "${capabilitySnapshot}" — capability visibility snapshot NOT scheduled.`);
  } else {
    cron.schedule(
      capabilitySnapshot,
      () => locked('capability-snapshot', async () => {
        console.log(`[cron] capability visibility snapshot started ${new Date().toISOString()}`);
        try {
          const results = await snapshotCapabilityVisibilityForAllSites();
          console.log(`[cron] capability visibility snapshot finished (${results.filter((r) => r.status === 'ok').length}/${results.length} ok)`);
        } catch (err) {
          console.error('[cron] capability visibility snapshot error:', err.message);
        }
      }),
      { timezone: tz }
    );
    console.log(`[cron] capability visibility snapshot scheduled "${capabilitySnapshot}" (${tz})`);
  }

  // Free-trial demos that have run out: end them and remove the Google and GitHub connections they made (see
  // store/access.js). Hourly, so a demo never outlives its last day by long. The first request after the deadline
  // does the same work on its own, so a missed run locks nobody in.
  const accessExpiry = process.env.ACCESS_EXPIRY_CRON_SCHEDULE || '10 * * * *';
  if (!cron.validate(accessExpiry)) {
    console.error(`[cron] invalid ACCESS_EXPIRY_CRON_SCHEDULE "${accessExpiry}" — demo expiry NOT scheduled.`);
  } else {
    cron.schedule(
      accessExpiry,
      () => locked('access-expiry', async () => {
        try {
          const { expireDueDemos } = await import('./store/access.js');
          const ended = await expireDueDemos();
          if (ended.length) console.log(`[cron] ended ${ended.length} demo(s): site ${ended.join(', ')}`);
        } catch (err) {
          console.error('[cron] demo expiry error:', err.message);
        }
      }),
      { timezone: tz }
    );
    console.log(`[cron] demo expiry scheduled "${accessExpiry}" (${tz})`);
  }
  // Sign-up recovery (store/signup-recovery.js): the one reminder to people who stopped part-way through /get-started, the deletion
  // of saved answers past their keep time, and the deletion of long-ended demos. Each has its own schedule.
  const signupReminder = process.env.SIGNUP_REMINDER_CRON_SCHEDULE || '0 9 * * *';
  if (!cron.validate(signupReminder)) {
    console.error(`[cron] invalid SIGNUP_REMINDER_CRON_SCHEDULE "${signupReminder}" — sign-up reminders NOT scheduled.`);
  } else {
    cron.schedule(
      signupReminder,
      () => locked('signup-reminders', async () => {
        try {
          const { runSignupReminders } = await import('./store/signup-recovery.js');
          const out = await runSignupReminders();
          if (out.sent) console.log(`[cron] sent ${out.sent} sign-up reminder(s)`);
        } catch (err) {
          console.error('[cron] sign-up reminder error:', err.message);
        }
      }),
      { timezone: tz }
    );
    console.log(`[cron] sign-up reminders scheduled "${signupReminder}" (${tz})`);
  }

  const draftPurge = process.env.SIGNUP_DRAFT_PURGE_CRON_SCHEDULE || '30 3 * * *';
  if (!cron.validate(draftPurge)) {
    console.error(`[cron] invalid SIGNUP_DRAFT_PURGE_CRON_SCHEDULE "${draftPurge}" — saved-answer purge NOT scheduled.`);
  } else {
    cron.schedule(
      draftPurge,
      () => locked('signup-draft-purge', async () => {
        try {
          const { purgeOldDrafts } = await import('./store/signup-recovery.js');
          const out = await purgeOldDrafts();
          if (out.deleted || out.emptied) console.log(`[cron] saved sign-up answers: deleted ${out.deleted}, emptied ${out.emptied}`);
        } catch (err) {
          console.error('[cron] saved-answer purge error:', err.message);
        }
      }),
      { timezone: tz }
    );
    console.log(`[cron] saved-answer purge scheduled "${draftPurge}" (${tz})`);
  }

  // Destructive, so OFF unless SIGNUP_PURGE_ENDED_ENABLED=true. Off, it only logs which ended demos it would delete.
  const endedPurge = process.env.SIGNUP_ENDED_PURGE_CRON_SCHEDULE || '0 4 * * *';
  if (!cron.validate(endedPurge)) {
    console.error(`[cron] invalid SIGNUP_ENDED_PURGE_CRON_SCHEDULE "${endedPurge}" — ended-demo purge NOT scheduled.`);
  } else {
    cron.schedule(
      endedPurge,
      () => locked('signup-ended-purge', async () => {
        try {
          const { purgeEndedDemos, purgeEndedEnabled } = await import('./store/signup-recovery.js');
          const apply = purgeEndedEnabled();
          const out = await purgeEndedDemos({ apply });
          if (!apply) console.log(`[cron] ended-demo purge is off (dry run): would delete ${out.due.length} project(s) ended ${out.purgeDay}+ days${out.due.length ? `: site ${out.due.join(', ')}` : ''}`);
          else if (out.due.length) console.log(`[cron] ended-demo purge: deleted ${out.deleted.length} of ${out.due.length}${out.skipped.length ? `, skipped ${out.skipped.map((x) => `${x.id} (${x.why})`).join('; ')}` : ''}`);
        } catch (err) {
          console.error('[cron] ended-demo purge error:', err.message);
        }
      }),
      { timezone: tz }
    );
    console.log(`[cron] ended-demo purge scheduled "${endedPurge}" (${tz}), ${process.env.SIGNUP_PURGE_ENDED_ENABLED === 'true' ? 'ENABLED' : 'dry run only'}`);
  }
}
