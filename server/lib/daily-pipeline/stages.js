import { minutesOf } from './config.js';

// The real stages, each a thin call into what already exists. Nothing is reimplemented: every stage reuses an existing entry
// point, so the existing locks, isolation, quotas and gates are exactly the ones that run today.
//
// Heavy modules are imported when a stage runs, not when this file loads, so loading the pipeline (and testing it) never pulls
// in the Google clients, the generators or the GitHub client.
//
// ALL STAGES ARE WIRED: research, design-baseline, analyst, repair, generate, design-live, prepare. Shipping is the separate 11:00 run
// (ship.js). Nothing here is on unless DAILY_PIPELINE_ENABLED=true.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Has the Data Analyst's nightly Python run FINISHED today? Only one signal counts: the `findings_complete` row its run writes as the
// very last step, which a run that failed anywhere never reaches (app/activity/log.py FINDINGS_COMPLETE_TASK). "Some task completed"
// is NOT enough: production has had nights where monitoring and forecasting completed and investigating then failed.
export const FINDINGS_COMPLETE_TASK = 'findings_complete';

export async function nightlyPipelineFinished({ query, sinceMs }) {
  const since = new Date(sinceMs).toISOString();
  const { rows } = await query(
    `SELECT COUNT(*)::int AS complete FROM ai_activity_log
      WHERE task_type = $2 AND status = 'completed' AND finished_at >= $1`, [since, FINDINGS_COMPLETE_TASK]);
  return (rows[0]?.complete ?? 0) > 0;
}

// Waits for that marker until `untilMs`. Returns whether it arrived.
export async function waitForNightlyPipeline({ query, sinceMs, untilMs, now = () => Date.now(), wait = sleep, pollMs = 60000 }) {
  for (;;) {
    let done = false;
    try { done = await nightlyPipelineFinished({ query, sinceMs }); } catch { /* unreadable counts as not finished, never as finished */ }
    if (done) return true;
    if (now() >= untilMs) return false;
    await wait(Math.min(pollMs, Math.max(1, untilMs - now())));
  }
}

// Thrown when the Python run has not confirmed completion. The analyst stage FAILS (visible in the checkpoint table, retried by
// the 07:45 resume and the hourly guard if the run finishes late) instead of syncing whatever findings happen to be lying around.
export class FindingsNotConfirmed extends Error {}

// The recommendations the selection chose, as shipping-queue entries (source 'auto-remediation', so the daily ceiling counts them).
export function candidatesFromSelection(ctx) {
  return (ctx.queue || []).map((item) => ({
    source: 'auto-remediation', lane: item.lane || 'analytics', generatorId: item.rec.recommendation_type,
    recommendationId: item.rec.id, findingId: item.rec.finding_ids?.[0] ?? null, params: item.rec.params || {}, score: item.score ?? null,
  }));
}

export function defaultStages({ config, startOfDayMs, analystWaitUntilMs, liveDesignFromMs, deps = {} }) {
  const imp = (path) => deps[path] || import(path);

  return [
    {
      name: 'research',
      // Ingest, narrative, email and the daily agents (Growth, competitor, technical, content), then the recommendations
      // coordinator. The existing per-project daily run; the shipping part of the old morning body is NOT part of it.
      async run({ site, isAborted }) {
        const { runDailyJobForSite } = await imp('../../job.js');
        const out = await runDailyJobForSite(site, { isAborted });
        return { findings: out?.findingsCount ?? null };
      },
    },
    {
      name: 'design-baseline',
      // Stored design profiles only: nothing is rendered or fetched here, because the Design Agent is in its quiet hours. A
      // project with no usable profile is queued for derivation and its items wait for live design.
      async run({ site }) {
        const job = await imp('../../job.js');
        const drift = await imp('../../implementers/lib/design-drift.js');
        const hasProfile = drift.siteHasUsableDesignProfile(site);
        const queued = hasProfile ? false : await job.queueDesignAgentDerivationForSite(site);
        return { hasProfile, derivationQueued: Boolean(queued), awaitingLiveDesign: !hasProfile };
      },
    },
    {
      name: 'analyst',
      // The Python pipeline produces the FINDINGS; this is where they enter the one queue. Fusion and the sync run here and
      // nowhere else once the pipeline is on, so there is a single fusion and a single sync. Fixes are made by the Generator
      // later, never by Python.
      // Starts only once the Data Analyst has written today's findings_complete marker. Until then it waits (no attempt used, other
      // stages and projects carry on) and later passes check again; past the deadline it is recorded as deferred.
      notReadyReason: 'the Data Analyst had not confirmed today\'s findings (no findings_complete marker)',
      async ready() {
        const { query } = await imp('../../db.js');
        return nightlyPipelineFinished({ query, sinceMs: startOfDayMs });
      },
      async run({ site }) {
        const { query } = await imp('../../db.js');
        // Checked again at the moment of use: never silently use stale findings, even if called directly.
        const finished = await nightlyPipelineFinished({ query, sinceMs: startOfDayMs });
        if (!finished) throw new FindingsNotConfirmed('the Data Analyst has not confirmed today\'s findings are complete (no findings_complete marker); its findings were NOT synced');
        const { runAnalystFusion } = await imp('../../agents/lib/analyst-fusion.js');
        const { fetchAnalystInsights } = await imp('../../job.js');
        const { syncAnalystInsightsToActionCenter } = await imp('../../agents/lib/analyst-seo-mapping.js');
        const fusion = await runAnalystFusion(site.id, { site });
        const { splitByFreshness, maxInsightAgeDays } = await imp('../analyst-insight-freshness.js');
        const { fresh: insights, stale } = splitByFreshness(await fetchAnalystInsights(site.id), { maxAgeDays: maxInsightAgeDays() });
        const synced = insights.length ? await syncAnalystInsightsToActionCenter(site.id, insights, { site }) : { created: 0 };
        return { findingsConfirmed: true, staleSkipped: stale.length, fusionCreated: fusion?.created ?? 0, fusionVerdict: fusion?.freshness?.verdict ?? null, syncCreated: synced.created ?? 0 };
      },
    },
    {
      name: 'repair',
      // The repair and verification jobs that used to run in the morning chain, in their original order, one project at a time:
      // design-profile role correction FIRST (content repair reads the corrected templates), then content repair, template
      // capability repair, the FAQ onboarding check, the blocked-recommendation refresh (sees this run's freshly healed config)
      // and the AI-visibility drafts. Each step is isolated, so one failing never skips the others; but the stage is only
      // marked done when EVERY step succeeded, otherwise it fails with the list of failed steps and is retried.
      async run({ site }) {
        const job = await imp('../../job.js');
        const steps = [
          ['role-correction', async () => {
            if (!site?.url_file_map?.siteRoot?.designProfile) return { skipped: 'no design profile' };
            const { repairDesignProfileRolesForSites } = await imp('../../scripts/repair-design-profile-roles.js');
            return repairDesignProfileRolesForSites([site], { commit: true });
          }],
          ['content-repair', async () => (await imp('../../scripts/repair-site-content-live.js')).repairSiteContentLive(site.id)],
          ['template-capability-repair', async () => (await imp('../../scripts/repair-template-capability.js')).repairTemplateCapabilitiesForSite(site.id)],
          ['faq-onboarding', async () => (await imp('../../agents/lib/faq-onboarding-check.js')).checkFaqOnboardingCoverage(site.id, { site })],
          ['blocked-refresh', async () => (await imp('../../agents/lib/recommendation-coordinator.js')).refreshBlockedRecommendations(site.id, { excludeDetectingAgent: 'analyst-keyword-gaps' })],
          ['ai-visibility-ship', async () => job.runAiVisibilityShipForAllSites({ listAllSites: async () => [site] })],
        ];
        const outcome = {}; const failed = [];
        for (const [name, fn] of steps) {
          try { await fn(); outcome[name] = 'ok'; } catch (err) { outcome[name] = `failed: ${String(err.message || err).slice(0, 200)}`; failed.push(name); }
        }
        if (failed.length) throw new Error(`repair steps failed: ${failed.join(', ')} (${JSON.stringify(outcome)})`);
        return { steps: outcome };
      },
    },
    {
      name: 'generate',
      // CANDIDATE SELECTION, not generation of drafts: the auto-remediation selection (opt-in, onboarding gate, exclusions,
      // classification and learning, pacing, convergence and refusal caps, lane budgets, growth scoring) run unchanged but WITHOUT
      // shipping, then recorded in the one shipping queue (deduplicated there). The drafts are made by `prepare`.
      async run({ site }) {
        const { selectRemediationCandidates } = await imp('../../agents/lib/auto-remediation.js');
        const { enqueue } = await imp('../../store/shipping-queue.js');
        const out = await selectRemediationCandidates(site, site.id, { finish: (r) => r, clientLabel: `site ${site.id}` });
        if (out.done) return { skip: out.done.stoppedReason || 'nothing-selected', selected: 0 };
        const picked = candidatesFromSelection(out.ctx);
        for (const c of picked) await enqueue(site.id, c);
        return { selected: picked.length, deferred: out.ctx.selectionDeferred?.length ?? 0 };
      },
    },
    {
      // After the Design Agent's quiet hours: a project with no usable design profile gets its derivation queued now, and its
      // items stay queued (prepare releases them as "awaiting live design") instead of being generated against a guess.
      name: 'design-live',
      notBefore: liveDesignFromMs,
      async run({ site }) {
        const job = await imp('../../job.js');
        const drift = await imp('../../implementers/lib/design-drift.js');
        const hasProfile = drift.siteHasUsableDesignProfile(site);
        const queued = hasProfile ? false : await job.queueDesignAgentDerivationForSite(site);
        return { hasProfile, derivationQueued: Boolean(queued) };
      },
    },
    {
      // Generate, validate (quality, design, responsive, technical, with their existing bounded correction loops) and mark
      // prepared. Nothing is approved, pushed or opened here. Only the auto-remediation lane is claimed: learned-repair intents
      // keep their own outcome-recording path.
      name: 'prepare',
      notBefore: liveDesignFromMs,
      async run({ site, deadlineAt, isAborted }) {
        const { prepareSite } = await import('./prepare.js');
        const drafts = await imp('../../store/drafts.js');
        const action = await imp('../../routes/action-center.js');
        const queue = await imp('../../store/shipping-queue.js');
        const drift = await imp('../../implementers/lib/design-drift.js');
        const job = await imp('../../job.js');
        const r = await prepareSite(site, {
          selectCandidates: async () => [], // selection already happened in `generate`; this only works what is queued
          enqueue: queue.enqueue, claimForPreparation: queue.claimForPreparation, sources: ['auto-remediation'],
          limit: config.prepareLimit, deadlineAt, isAborted,
          generateDraft: action.generateDraft, submitDraftForApproval: drafts.submitDraftForApproval, validateDraft: action.validateDraft,
          markPrepared: queue.markPrepared, releaseItem: queue.releaseItem,
          abandonDraft: (siteId, draftId, reason) => drafts.markDraftAbandoned(siteId, draftId, reason, 'daily-pipeline'),
          hasUsableDesignProfile: drift.siteHasUsableDesignProfile, queueDesignDerivation: job.queueDesignAgentDerivationForSite,
        });
        const { results, ...counts } = r;
        // Work that could not be prepared is reported, never hidden as success: a project where nothing was claimed is a clean
        // no-op, but failed items are listed so the checkpoint row shows them.
        return counts;
      },
    },
  ];
}

export { minutesOf };
