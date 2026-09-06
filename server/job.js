import { getOrCreateSite, query } from './db.js';
import { callDataAnalystAgent } from './lib/data-analyst-client.js';
import { fetchGscForDate } from './ingest/gsc.js';
import { fetchGa4ForDate } from './ingest/ga4.js';
import { fetchCompetitorRankings } from './ingest/competitors.js';
import { competitorProviderConfigured } from './ingest/competitor-providers/index.js';
import { upsertGsc, upsertGa4, saveNarrative, markDailyDocDone, saveCompetitorRankings, saveHealthScoreSnapshot, recordIntegrationCheck } from './store/upsert.js';
import { getDay, getNarrative, listSites, getCompetitorRankingDates, getHealthScoreOnOrBefore } from './store/read.js';
import { generateNarrative } from './report/narrative.js';
import { sendDailyEmail } from './report/email.js';
import { runWeeklyDocReport } from './report/weekly-doc.js';
import { runDailyDocReport } from './report/daily-doc.js';
import { runExecutiveDocReport } from './report/executive-doc.js';
import { runMonthlyDocReport } from './report/monthly-doc.js';
import { isGoogleAuthError } from './integrations/google-oauth.js';
import { daysAgoInTz, dateRange, previousWeek, previousMonth, monthBounds, todayInTz } from './util/dates.js';
import { runOrchestration } from './agents/orchestrator.js';
import { runAgent } from './agents/runner.js';
import { saveAgentRun, getLatestAgentRuns } from './store/agent-runs.js';
import { meta as execReportMeta, orchestrationStatus } from './agents/executive-report.js';
import { computeHealthScore } from './agents/lib/health-score.js';
import { RECOMMENDATION_AGENT_IDS } from './agents/lib/insights.js';
import { detectNotificationEvents } from './notifications/detect.js';
import { deliverToAllChannels } from './notifications/channels/index.js';
import { buildRecommendations } from './agents/lib/recommendations.js';
import { repairSiteTemplates } from './agents/lib/template-repair.js';
import { syncFromGrounded, refreshBlockedRecommendations } from './agents/lib/recommendation-coordinator.js';
import { autoRemediateSafeRecommendations } from './agents/lib/auto-remediation.js';

import { interceptWithLearnedRepairs } from './agents/lib/learned-repair.js';

import { syncAnalystInsightsToActionCenter, syncGrowthOpportunitiesToActionCenter, refreshPendingKeywordGapObservations, qualifyAndShipContentGaps } from './agents/lib/analyst-seo-mapping.js';
import { runAnalystFusion } from './agents/lib/analyst-fusion.js';
import { sweepAnalystOutcomes } from './agents/lib/analyst-outcome.js';
import { checkFaqOnboardingCoverage } from './agents/lib/faq-onboarding-check.js';
import { getImplementedFindingIds, countDraftsBySourceToday, countDraftsBySourceTodayAllSites } from './store/drafts.js';
import { isShippable, isShipCatchupOwed, SHIP_HOUR_LOCAL } from './lib/ship-window.js';
import { runDueImpactMeasurements } from './agents/lib/fix-impact.js';

import { syncWatchlist } from './agents/lib/watchlist.js';
import { discoverFromSitemaps, crawlSite } from './agents/lib/site-discovery.js';
import { getSearchPerformanceRange } from './store/read.js';
import { ownDomains, filterOwnDomainPages } from './agents/lib/site-domain.js';
import { upsertPageInventoryBatch, getLastDiscoveryAt, markOrphanedPages } from './store/page-inventory.js';
import { runDueVerifications } from './agents/lib/fix-verification.js';
import { siteHasUsableDesignProfile, sitePageUrl, getDesignProfile } from './implementers/lib/design-drift.js';
import { createDesignProfileJob, getQueuedComponentTemplateJob, getLatestDesignAgentJob, DESIGN_PROFILE_JOB_KEY, createConsistencyScanJob, CONSISTENCY_SCAN_JOB_KEY } from './store/execution-jobs.js';

// Daily-cadence agents only. competitor-intelligence, authority, and
// ai-recommendation are all throttled (see runAgentIfDue below — real
// competitor movement and backlink profiles move too slowly to justify
// daily/weekly cost, and daily would multiply real DataForSEO spend for no
// real signal gain). ai-recommendation defaults to the same monthly
// throttle but can opt into a weekly one instead via AI_RECOMMENDATION_CADENCE
// (see runAiRecommendationIfDue below) — it's still excluded from
// DAILY_AGENT_IDS either way, since even its fastest opt-in cadence is
// weekly, never daily. content-gap runs weekly (via executive-report's
// requires, see executive-report.js's WEEKLY_ONLY_AGENT_ID — real
// content-completeness gaps don't meaningfully shift day to day).
// growth-queries also runs weekly, on its own dedicated gate
// (runGrowthQueryDiscoveryIfDue below, same weekly-gate shape as
// runGeoAuditIfDue) — real GSC query movement and page coverage don't shift
// meaningfully day to day either, and its own LLM/page-fetch cost multiplies
// with frequency the same way competitor/authority checks do. A new agent
// added to RECOMMENDATION_AGENT_IDS (agents/lib/insights.js) lands here in
// DAILY_AGENT_IDS automatically unless it's added to THROTTLED_AGENT_IDS
// below or given its own WEEKLY_ONLY_AGENT_ID-style exclusion — pick the
// cadence deliberately, don't leave it to default.
//
// font-consistency and visual-quality were both throttled here until
// 2026-09-03 (monthly and weekly respectively), on a cost argument that
// turned out to be measuring the wrong thing. What the throttle actually
// bought was four runs of each, ever, on the only real site — and all eight
// of them errored, which nothing noticed for a month precisely BECAUSE a
// monthly agent failing looks identical to a monthly agent not being due.
// A design regression is also not a slow-moving signal the way a backlink
// profile is: it lands in one deploy and is visible to every visitor from
// that moment. Both are daily now, and the real per-run cost is bounded
// where it belongs — in each agent's own page batch size — rather than by
// starving the agent of runs.
const THROTTLED_AGENT_IDS = new Set(['competitor-intelligence', 'authority', 'ai-recommendation']);
const WEEKLY_ONLY_AGENT_IDS = new Set(['content-gap', 'growth-queries']);
const DAILY_AGENT_IDS = RECOMMENDATION_AGENT_IDS.filter((id) => !THROTTLED_AGENT_IDS.has(id) && !WEEKLY_ONLY_AGENT_IDS.has(id));

// Records the shared Google OAuth connection's health from organic pipeline
// outcomes (not just the on-demand "Test connection" check), so Integration
// Health reflects real job results. A success clears any prior error; a
// failure only gets recorded when it's actually auth-shaped (isGoogleAuthError)
// — a transient network blip or rate limit shouldn't read as "connection broken."
// site_id is null (this connection is shared across all sites, not per-site).
async function noteGoogleAuthOutcome(ok, err) {
  if (ok) {
    await recordIntegrationCheck('google-oauth', null, {
      ok: true, authStatus: 'valid', errorMessage: null, recoveryAction: null,
    }).catch(() => {});
    return;
  }
  if (!isGoogleAuthError(err)) return;
  await recordIntegrationCheck('google-oauth', null, {
    ok: false, authStatus: 'revoked',
    errorMessage: err.response?.data?.error_description || err.response?.data?.error || err.message,
    recoveryAction: 'Run `npm run get-token` to re-authenticate the shared Google OAuth connection.',
  }).catch(() => {});
}

// Records the daily pipeline's own success/failure — same shared/global
// pattern as noteGoogleAuthOutcome (site_id null), so a broken automation
// run surfaces through the existing Integration Health card instead of only
// living in server logs. The platform's whole pitch is "we notice things
// and tell you" — this is that same promise applied to itself.
async function notePipelineOutcome(ok, err) {
  await recordIntegrationCheck('daily-pipeline', null, {
    ok, authStatus: null,
    errorMessage: ok ? null : (err?.message || String(err)),
    recoveryAction: ok ? null : 'Check server logs for the failing step (ingest, narrative, agents, or notifications) for this site, fix it, then re-run the daily job manually.',
  }).catch(() => {});
}

// GSC finalizes with a lag; GA4 is near real-time.
const GSC_LAG_DAYS = 3;   // freshest fully-final GSC date = today - 3
const GSC_BACKFILL = 3;   // also re-fetch the prior 3 days to catch late finalization
const GA4_FRESH_DAYS = 0; // ingest GA4 up to TODAY (partial, live) for freshness

// Ingest one explicit date for both sources (used by the manual CLI).
export async function ingestDate(site, date) {
  const gsc = await fetchGscForDate(site, date);
  await upsertGsc(site.id, gsc);
  const ga4 = await fetchGa4ForDate(site, date);
  await upsertGa4(site.id, ga4);
  return { date, gsc: gsc.totals, ga4: ga4.totals };
}

// Core per-site ingest logic — the standard window for one already-resolved
// site. Both sources are ingested across the same window (gscStart ..
// yesterday) so every recent day has aligned GSC + GA4 data. The "report
// date" is the freshest day that has FINAL GSC data (today - 3). Exported
// (not just used via runDailyJobForSite) so server/routes/clients.js can
// pull real GSC/GA4 data for a brand-new client's day-0 baseline without
// also triggering that function's narrative/email/doc side effects, which
// aren't appropriate before a client relationship is even fully set up.
export async function runDailyIngestForSite(site) {
  const tz = site.timezone;

  const gscEnd = daysAgoInTz(tz, GSC_LAG_DAYS);                 // report date
  const gscStart = daysAgoInTz(tz, GSC_LAG_DAYS + GSC_BACKFILL);
  const ga4End = daysAgoInTz(tz, GA4_FRESH_DAYS);              // yesterday

  // GSC: backfill window up to today-3 (final data only).
  for (const date of dateRange(gscStart, gscEnd)) {
    const gsc = await fetchGscForDate(site, date);
    await upsertGsc(site.id, gsc);
    console.log(`[GSC] site ${site.id} ${date}: ${gsc.totals.clicks} clicks, ${gsc.totals.impressions} impressions`);
  }

  // GA4: same start, but extend through yesterday for freshness.
  for (const date of dateRange(gscStart, ga4End)) {
    const ga4 = await fetchGa4ForDate(site, date);
    await upsertGa4(site.id, ga4);
    console.log(`[GA4] site ${site.id} ${date}: ${ga4.totals.users} users, ${ga4.totals.sessions} sessions`);
  }

  return { site, reportDate: gscEnd };
}

// Ingest the standard daily window for the single env-configured site.
// Preserved for CLI/backward compatibility (server/scripts/ingest.js).
export async function runDailyIngest() {
  const site = await getOrCreateSite();
  return runDailyIngestForSite(site);
}

// Runs DAILY_AGENT_IDS' daily-cadence specialist agents (11 today, per the
// constant above) fresh via the shared orchestrator, persists an
// executive-report row from that same result (same pattern as
// routes/command-center.js's refresh route — avoids a second call to
// executive-report.js re-running every daily agent again), then detects and
// delivers any notification-worthy events from what changed.
// This is what makes the Command Center's "Daily Morning Brief" and Recent
// Changes genuinely daily instead of only as fresh as the last manual
// refresh or Copilot question.
export async function runDailyAgentAnalysisForSite(site) {
  const end = daysAgoInTz(site.timezone, 0);
  const start = daysAgoInTz(site.timezone, 7);

  const result = await runOrchestration({ siteId: site.id, start, end, agentIds: DAILY_AGENT_IDS, persistSubAgentRuns: true });
  // runOrchestration never throws — it catches per agent and records each
  // one's own status — so writing a hardcoded 'ok' here meant a run in which
  // EVERY specialist agent failed persisted as a clean, empty result. This is
  // the daily path, and command-center.js:194 maps this row's status straight
  // onto what the user sees, so a total outage read as "ran clean, nothing
  // found" on the screen people actually look at. See orchestrationStatus for
  // why a sub-agent's own 'insufficient-data' deliberately does not downgrade.
  const health = orchestrationStatus(result.perAgent, DAILY_AGENT_IDS);
  await saveAgentRun({
    siteId: site.id, agentId: 'executive-report', agentVersion: execReportMeta.version,
    input: { siteId: site.id, start, end }, status: health.status,
    facts: {
      rangeStart: start, rangeEnd: end, sections: result.perAgent,
      topFindings: result.findings.slice(0, 3), findings: result.findings,
      failedAgentIds: health.failedAgentIds,
    },
    narrative: result.narrative, error: health.message, tookMs: null,
  });

  const implementedFindingIds = await getImplementedFindingIds(site.id);
  const { score } = computeHealthScore(result.findings, implementedFindingIds);
  const today = new Date().toISOString().slice(0, 10);
  await saveHealthScoreSnapshot(site.id, today, score)
    .catch((err) => console.error(`[job] site ${site.id} health score snapshot failed:`, err.message));
  const weekAgoDate = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const weekAgoScore = await getHealthScoreOnOrBefore(site.id, weekAgoDate);
  const trendWeek = weekAgoScore != null ? score - weekAgoScore : null;

  const events = await detectNotificationEvents(site.id, { trendWeek });
  await deliverToAllChannels(site.id, events);

  // Verify any existing-but-unstamped component templates against the live
  // site BEFORE grounding findings, so the list this run produces reflects
  // what is genuinely blocked. The design gate inside buildRecommendations is
  // pure and in-memory by design, so it can only read the stamps that already
  // exist — a template stamped later, at draft time, leaves every affected
  // recommendation showing as blocked for a full day.
  //
  // Never fatal, and never a reason to skip detection: this is an
  // opportunistic upgrade of some rows from "blocked" to "actionable".
  await repairSiteTemplates(site.id)
    .catch((err) => console.warn(`[job] site ${site.id} component-template repair failed:`, err.message));

  const recommendations = await buildRecommendations(site.id);

  // Cross-client learned repair, BEFORE anything is persisted: an issue this
  // platform has already proven it can fix — on this site or another one —
  // gets repaired into a real PR here, and never becomes an Action Center row
  // at all. Anything without proven, applicable evidence falls through
  // untouched. Fails open to today's exact behavior on any error, since a
  // learning optimization must never be able to lose a real finding.
  const grounded = await interceptWithLearnedRepairs(site.id, recommendations)
    .catch((err) => { console.error(`[job] site ${site.id} learned repair failed:`, err.message); return recommendations; });

  await syncFromGrounded(site.id, grounded)
    .catch((err) => console.error(`[job] site ${site.id} recommendation coordinator sync failed:`, err.message));

  await autoRemediateSafeRecommendations(site.id)
    .catch((err) => console.error(`[job] site ${site.id} auto-remediation failed:`, err.message));
  // Deliberately the PRE-repair list, not `grounded`. A repaired item's issue
  // is still genuinely live on the site until a human merges its PR, so the
  // watchlist must keep tracking it — dropping it here would mark the problem
  // as handled before anything actually shipped.

  // Deliberately does NOT auto-remediate here. Detection and shipping are two
  // separate schedules now: this morning run only DETECTS (fills the
  // recommendations table), and runAutoRemediationForAllSites ships what it
  // found on its own later trigger (cron.js, 13:00 site-local by default).
  // Splitting them is what makes the day's PR a reviewable batch that lands at
  // a predictable hour, instead of branches appearing the instant an agent
  // happens to notice something.

  const groundedById = new Map(recommendations.items.map((item) => [item.id, item]));
  const watchlistSync = await syncWatchlist(site.id, result.findings, groundedById)
    .catch((err) => { console.error(`[job] site ${site.id} watchlist sync failed:`, err.message); return { added: 0, closed: 0 }; });

  return {
    ranAgentIds: result.ranAgentIds, findingsCount: result.findings.length, notificationsEmitted: events.length,
    watchlistAdded: watchlistSync.added, watchlistClosed: watchlistSync.closed,
  };
}

// Full daily pipeline for one already-resolved site: ingest → AI narrative →
// email → daily doc → agent analysis → notifications. Idempotent and safe
// to re-run — identical logic to the original single-site runDailyJob(),
// just parameterized by `site`.
export async function runDailyJobForSite(site) {
  const { reportDate } = await runDailyIngestForSite(site);

  // Each step below already tolerates its own failure (logs and moves on,
  // so one broken step doesn't take down the rest of the pipeline) — but
  // that also means a partial failure would otherwise vanish into server
  // logs with nothing to show for it. stepErrors collects what actually
  // broke so notePipelineOutcome below can report the real outcome instead
  // of a false "ok" just because nothing threw all the way out.
  const stepErrors = [];

  let narrative = '';
  try {
    narrative = await generateNarrative(site, reportDate);
    await saveNarrative(site.id, reportDate, narrative);
    console.log(`[report] site ${site.id} narrative saved for ${reportDate}`);
  } catch (err) {
    console.error(`[report] site ${site.id} narrative failed:`, err.message);
    stepErrors.push(new Error(`narrative: ${err.message}`));
  }

  const day = await getDay(site.id, reportDate);
  const existing = await getNarrative(site.id, reportDate);

  try {
    // Email idempotency: only send once per report date, even across restarts/catch-ups.
    if (existing?.emailed_at) {
      console.log(`[report] site ${site.id} email already sent for ${reportDate} — skipping.`);
    } else {
      const sent = await sendDailyEmail(site, reportDate, day, narrative);
      if (sent) await saveNarrative(site.id, reportDate, narrative, new Date().toISOString());
    }
  } catch (err) {
    console.error(`[report] site ${site.id} email failed:`, err.message);
    stepErrors.push(new Error(`email: ${err.message}`));
  }

  try {
    // Daily doc idempotency: only write once per report date.
    if (existing?.daily_doc_done) {
      console.log(`[report] site ${site.id} daily doc already written for ${reportDate} — skipping.`);
    } else {
      const r = await runDailyDocReport(site, reportDate);
      await markDailyDocDone(site.id, reportDate);
      console.log(`[report] site ${site.id} daily doc entry written → ${r.url}`);
    }
  } catch (err) {
    console.error(`[report] site ${site.id} daily doc failed:`, err.message);
    stepErrors.push(new Error(`daily doc: ${err.message}`));
  }

  try {
    const { ranAgentIds, findingsCount, notificationsEmitted, watchlistAdded, watchlistClosed } = await runDailyAgentAnalysisForSite(site);
    console.log(`[job] site ${site.id} daily agent analysis: ${ranAgentIds.length} agents, ${findingsCount} findings, ${notificationsEmitted} notification(s), watchlist +${watchlistAdded}/-${watchlistClosed}.`);
  } catch (err) {
    console.error(`[job] site ${site.id} daily agent analysis failed:`, err.message);
    stepErrors.push(new Error(`agent analysis: ${err.message}`));
  }

  await notePipelineOutcome(stepErrors.length === 0, stepErrors[0]);

  return { site, reportDate, narrative };
}

// Full daily pipeline for the single env-configured site. Preserved for
// CLI/backward compatibility (server/scripts/daily-doc.js and manual use).
export async function runDailyJob() {
  const site = await getOrCreateSite();
  return runDailyJobForSite(site);
}

// Run the weekly doc report for the previous full week, but only if it hasn't
// been written yet (idempotent across cron + startup catch-up + restarts).
// Manual `npm run weekly -- <date>` bypasses this guard for backfills.
export async function runWeeklyIfDue(site) {
  const { start, end } = previousWeek(site.timezone);
  // Read as a plain YYYY-MM-DD string (PG DATE → JS Date would shift across timezones).
  const { rows } = await query(
    "SELECT to_char(weekly_last_done, 'YYYY-MM-DD') AS weekly_last_done FROM sites WHERE id = $1",
    [site.id]
  );
  const lastStr = rows[0]?.weekly_last_done || null;

  if (lastStr && lastStr >= start) {
    console.log(`[weekly] site ${site.id} week of ${start} already written — skipping.`);
    return null;
  }
  const r = await runWeeklyDocReport(site); // no anchor → previous full week
  await query('UPDATE sites SET weekly_last_done = $1 WHERE id = $2', [start, site.id]);
  console.log(`[weekly] site ${site.id} week of ${start} written; marker updated.`);
  return r;
}

// Run the Weekly AI Executive Report for the previous full week, but only if
// it hasn't been written yet — same idempotency pattern as runWeeklyIfDue,
// separate marker column so the two reports' schedules never interfere.
export async function runExecutiveIfDue(site) {
  const { start, end } = previousWeek(site.timezone);
  const { rows } = await query(
    "SELECT to_char(executive_last_done, 'YYYY-MM-DD') AS executive_last_done FROM sites WHERE id = $1",
    [site.id]
  );
  const lastStr = rows[0]?.executive_last_done || null;

  if (lastStr && lastStr >= start) {
    console.log(`[executive] site ${site.id} week of ${start} already written — skipping.`);
    return null;
  }
  const r = await runExecutiveDocReport(site); // no anchor → previous full week
  await query('UPDATE sites SET executive_last_done = $1 WHERE id = $2', [start, site.id]);
  console.log(`[executive] site ${site.id} week of ${start} written; marker updated.`);
  return r;
}

// Sites with GSC/GA4 actually connected. Automation skips a site that
// doesn't have both configured yet (e.g. a newly onboarded client whose
// GSC/GA4 hasn't been wired up) rather than attempting and failing every
// cycle — it will start receiving automation automatically the moment both
// are set on its `sites` row.
//
// status === 'active' (PLATFORM-ADMIN-DESIGN.md §D, §K Phase 3): a
// suspended or soft-deleted tenant stops consuming GSC/GA4 quota and
// stops receiving reports the moment it's suspended, without deleting or
// touching its saved properties — it picks back up automatically on
// reactivation, same "automatic the moment the row says so" behavior as
// the gsc_property/ga4_property_id filter above.
export async function listConnectedSites() {
  const sites = await listSites();
  return sites.filter((s) => s.gsc_property && s.ga4_property_id && s.status === 'active');
}

// Run the full daily pipeline independently for every connected site. A
// failure for one site is logged and does not stop the others.
export async function runDailyJobForAllSites() {
  const sites = await listConnectedSites();
  const results = [];
  for (const site of sites) {
    try {
      results.push(await runDailyJobForSite(site));
      await noteGoogleAuthOutcome(true);
    } catch (err) {
      console.error(`[job] daily job failed for site ${site.id} "${site.name}":`, err.message);
      await noteGoogleAuthOutcome(false, err);
      await notePipelineOutcome(false, err);
    }
  }
  return results;
}

// Run the weekly-if-due check independently for every connected site. A
// failure for one site is logged and does not stop the others.
export async function runWeeklyIfDueForAllSites() {
  const sites = await listConnectedSites();
  const results = [];
  for (const site of sites) {
    try {
      results.push(await runWeeklyIfDue(site));
      await noteGoogleAuthOutcome(true);
    } catch (err) {
      console.error(`[job] weekly doc failed for site ${site.id} "${site.name}":`, err.message);
      await noteGoogleAuthOutcome(false, err);
    }
  }
  return results;
}

// Real DataForSEO SERP-ranking ingest — monthly, matching the cadence of
// the actual competitor-intelligence agent analysis that consumes it (see
// runCompetitorIntelligenceIfDue below). Its own marker:
// getCompetitorRankingDates (real persisted check dates) instead of a
// sites column, since competitor_rankings already records when it last ran.
// Silently no-ops if no SERP provider (DataForSEO or the free Google Custom
// Search provider) is configured — the competitor-intelligence agent
// already reports "insufficient-data" plainly in that case, so there's
// nothing to force here.
export async function runCompetitorCheckIfDue(site) {
  if (!competitorProviderConfigured()) return null;

  const { start, end } = previousWeek(site.timezone); // still analyze the most recent real week of data when it does run
  const { year, month } = previousMonth(site.timezone);
  const threshold = monthBounds(year, month).start;
  const [latestDate] = await getCompetitorRankingDates(site.id, 1);
  if (latestDate && latestDate >= threshold) {
    console.log(`[competitors] site ${site.id} already checked this month — skipping.`);
    return null;
  }

  const checkDate = daysAgoInTz(site.timezone, 0);
  const rows = await fetchCompetitorRankings(site, checkDate, { start, end });
  await saveCompetitorRankings(site.id, rows);
  console.log(`[competitors] site ${site.id}: checked ${rows.length} real SERP ranking row(s).`);
  return { checked: rows.length };
}

export async function runCompetitorCheckIfDueForAllSites() {
  const sites = await listConnectedSites();
  const results = [];
  for (const site of sites) {
    try {
      results.push(await runCompetitorCheckIfDue(site));
    } catch (err) {
      console.error(`[job] competitor check failed for site ${site.id} "${site.name}":`, err.message);
    }
  }
  return results;
}

// Shared "checked often, acts rarely" guard for any agent that should only
// really run once a real calendar month (or, opt-in, week) has passed — the
// exact pattern competitor-intelligence proved first (see its comment
// history), now used by three agents (competitor-intelligence, authority,
// ai-recommendation) so a fourth doesn't need to hand-roll the same
// due-check a fourth time. Checked via the weekly cron block, same as
// everything else here, but only does real work once the chosen cadence's
// period has passed. persist:true since there's no wrapper (like
// executive-report's orchestration) persisting a row on this agent's behalf.
//
// `cadence` defaults to 'month' — every existing caller (competitor-
// intelligence, authority) is unaffected. 'week' is currently only used by
// ai-recommendation, and only when AI_RECOMMENDATION_CADENCE=week is
// explicitly set (see runAiRecommendationIfDue below) — this parameter
// exists so that opt-in lives entirely in the caller, not here.
async function runAgentIfDue(site, agentId, { start, end, cadence = 'month' } = {}) {
  const threshold = cadence === 'week'
    ? previousWeek(site.timezone).start
    : monthBounds(previousMonth(site.timezone).year, previousMonth(site.timezone).month).start;
  const [lastRun] = await getLatestAgentRuns(site.id, [agentId]);
  if (lastRun && new Date(lastRun.created_at) >= new Date(threshold)) {
    console.log(`[${agentId}] site ${site.id} already analyzed this ${cadence} — skipping.`);
    return null;
  }
  const range = start && end ? { start, end } : previousWeek(site.timezone); // still analyze the most recent real week of data when it does run
  const output = await runAgent(agentId, { siteId: site.id, start: range.start, end: range.end }, { persist: true });
  console.log(`[${agentId}] site ${site.id}: real ${cadence}ly analysis complete (status: ${output.status}).`);
  return { status: output.status, findingsCount: output.facts?.findings?.length || 0 };
}

async function runAgentIfDueForAllSites(agentId, options) {
  const sites = await listConnectedSites();
  const results = [];
  for (const site of sites) {
    try {
      results.push(await runAgentIfDue(site, agentId, options));
    } catch (err) {
      console.error(`[job] ${agentId} throttled run failed for site ${site.id} "${site.name}":`, err.message);
    }
  }
  return results;
}

// The real competitor-intelligence AGENT run (crawls competitor homepages,
// real LLM/SERP discovery) — deliberately monthly, decoupled from
// executive-report's weekly orchestration (no longer in its meta.requires,
// see executive-report.js) specifically so it can have this slower cadence
// without either starving the weekly executive narrative of every OTHER
// agent's freshness, or forcing competitor-intelligence to re-run weekly
// just because it used to be bundled in.
export const runCompetitorIntelligenceIfDue = (site) => runAgentIfDue(site, 'competitor-intelligence');
export const runCompetitorIntelligenceIfDueForAllSites = () => runAgentIfDueForAllSites('competitor-intelligence');

// Authority Score — real DataForSEO backlink data doesn't meaningfully
// shift week to week, so monthly matches the underlying signal (same
// reasoning as competitor-intelligence above) and keeps DataForSEO
// Backlinks API cost negligible.
export const runAuthorityIfDue = (site) => runAgentIfDue(site, 'authority');
export const runAuthorityIfDueForAllSites = () => runAgentIfDueForAllSites('authority');

// font-consistency and visual-quality had their own runAgentIfDue wrappers
// here (monthly and weekly). Both are ordinary DAILY_AGENT_IDS members as of
// 2026-09-03 — see THROTTLED_AGENT_IDS above for why — so they now run
// through runDailyAgentAnalysisForSite like every other detection agent, and
// these wrappers plus their weekly cron.js callers are gone rather than left
// as no-ops that would silently re-skip on the throttle threshold.

// AI Recommendation — real AI prompt probes have a real per-call cost that
// multiplies with every additional configured provider (see
// lib/model-providers/); monthly (the default) keeps that cost negligible
// while still tracking real drift in what AI assistants recommend over
// time. AI_RECOMMENDATION_CADENCE=week opts into a faster, ~4.3x costlier
// cadence — left off by default; this is a real recurring-spend decision
// (same category as DATAFORSEO_LOGIN/PASSWORD being a pending-budget gate
// elsewhere in this codebase), never flipped on by this code itself.
const aiRecommendationCadence = () => (process.env.AI_RECOMMENDATION_CADENCE === 'week' ? 'week' : 'month');
export const runAiRecommendationIfDue = (site) => runAgentIfDue(site, 'ai-recommendation', { cadence: aiRecommendationCadence() });
export const runAiRecommendationIfDueForAllSites = () => runAgentIfDueForAllSites('ai-recommendation', { cadence: aiRecommendationCadence() });

// Growth Query Discovery — real GSC query movement and page coverage don't
// meaningfully shift day to day, and its own LLM/page-fetch cost multiplies
// with frequency the same way competitor/authority checks do, so weekly
// (checked on the same weekly cron tick as everything else in this block,
// real work only once a week) matches the underlying signal.
export const runGrowthQueryDiscoveryIfDue = (site) => runAgentIfDue(site, 'growth-queries', { cadence: 'week' });
export const runGrowthQueryDiscoveryIfDueForAllSites = () => runAgentIfDueForAllSites('growth-queries', { cadence: 'week' });

// GEO Audit — runs weekly, same cadence as the weekly doc report.
// Uses the geo-audit generator to produce an AI visibility score,
// per-page findings, and prioritized fix list mapped to generators.
// Idempotent per week: skips if already run for the current week's
// start date (Monday in the site's timezone).
export async function runGeoAuditIfDue(site) {
  const { start } = previousWeek(site.timezone);
  const { rows } = await query(
    "SELECT to_char(geo_audit_last_done, 'YYYY-MM-DD') AS geo_audit_last_done FROM sites WHERE id = $1",
    [site.id]
  );
  const lastStr = rows[0]?.geo_audit_last_done || null;
  if (lastStr && lastStr >= start) {
    console.log(`[geo-audit] site ${site.id} already run this week — skipping.`);
    return null;
  }

  // generateDraft is the one shared persistence path — also used by the
  // MCP generate_geo_audit tool and the manual "Run Audit" button
  // (routes/action-center.js's generic /action-center/generate) — so
  // cron/MCP/manual can never diverge into separate implementations, and
  // the report this computes is actually saved as a draft instead of
  // being discarded. Dynamic import avoids a static circular dependency
  // with routes/action-center.js (which already imports from this file) —
  // same convention as runPrStatusPollForAllSites above.
  const { generateDraft } = await import('./routes/action-center.js');
  const draft = await generateDraft(site.id, {
    generatorId: 'geo-audit',
    params: { start, end: daysAgoInTz(site.timezone, 0) },
    source: 'cron',
  });
  await query('UPDATE sites SET geo_audit_last_done = $1 WHERE id = $2', [start, site.id]);
  console.log(`[geo-audit] site ${site.id} weekly GEO audit complete: ${draft.summary}`);
  return draft;
}

export async function runGeoAuditIfDueForAllSites() {
  const sites = await listConnectedSites();
  const results = [];
  for (const site of sites) {
    try {
      results.push(await runGeoAuditIfDue(site));
    } catch (err) {
      console.error(`[job] geo-audit failed for site ${site.id} "${site.name}":`, err.message);
    }
  }
  return results;
}

// Real site-wide page discovery (sitemap, and BFS crawl once added) — kept
// weekly, same reasoning as runCompetitorCheckIfDue: a real crawl of up to
// a few hundred pages against a live site, run inside every daily cycle,
// would be both wasteful (a site's page list barely changes day to day) and
// impolite. Also folds in GSC's own top pages as a third discovery source,
// tagged 'gsc', so page_inventory becomes the single superset rather than
// just the sitemap+crawl subset.
export async function runSiteDiscoveryIfDue(site) {
  const { start, end } = previousWeek(site.timezone);
  const lastDiscoveredAt = await getLastDiscoveryAt(site.id);
  if (lastDiscoveredAt && new Date(lastDiscoveredAt) >= new Date(start)) {
    console.log(`[site-discovery] site ${site.id} week of ${start} already discovered — skipping.`);
    return null;
  }

  const [sitemapUrls, crawledUrls, gscPagesRaw] = await Promise.all([
    discoverFromSitemaps(site).catch((err) => { console.error(`[site-discovery] site ${site.id} sitemap fetch failed:`, err.message); return []; }),
    crawlSite(site).catch((err) => { console.error(`[site-discovery] site ${site.id} crawl failed:`, err.message); return []; }),
    getSearchPerformanceRange(site.id, start, end, 'page', 200),
  ]);
  const domain = ownDomains(site);
  const gscPages = filterOwnDomainPages(gscPagesRaw, domain);

  await upsertPageInventoryBatch(site.id, sitemapUrls, 'sitemap');
  await upsertPageInventoryBatch(site.id, crawledUrls, 'crawl');
  await upsertPageInventoryBatch(site.id, gscPages.map((p) => p.dim_value), 'gsc');

  // Real orphaned-page signal: a page the sitemap lists but this run's real
  // homepage-outward crawl never reached via any actual internal link — the
  // standard SEO definition, computed here from this run's own two
  // already-fetched lists (no new fetching). Trailing-slash normalization
  // only, since both lists are already full absolute URLs (sitemap <loc>
  // entries, and crawledUrls resolved via `new URL(href, pageUrl)` in
  // page-content.js) — not a guess at equivalence, just tolerant of the one
  // real formatting difference sites commonly have between the two sources.
  const normalize = (u) => u.replace(/\/+$/, '');
  const crawledSet = new Set(crawledUrls.map(normalize));
  const orphanedUrls = sitemapUrls.filter((u) => !crawledSet.has(normalize(u)));
  await markOrphanedPages(site.id, orphanedUrls);

  console.log(`[site-discovery] site ${site.id}: ${sitemapUrls.length} sitemap URL(s), ${crawledUrls.length} crawled URL(s), ${gscPages.length} GSC page(s), ${orphanedUrls.length} orphaned.`);
  return { sitemapCount: sitemapUrls.length, crawlCount: crawledUrls.length, gscCount: gscPages.length, orphanedCount: orphanedUrls.length };
}

export async function runSiteDiscoveryIfDueForAllSites() {
  const sites = await listConnectedSites();
  const results = [];
  for (const site of sites) {
    try {
      results.push(await runSiteDiscoveryIfDue(site));
    } catch (err) {
      console.error(`[job] site discovery failed for site ${site.id} "${site.name}":`, err.message);
    }
  }
  return results;
}

export async function runExecutiveIfDueForAllSites() {
  const sites = await listConnectedSites();
  const results = [];
  for (const site of sites) {
    try {
      results.push(await runExecutiveIfDue(site));
      await noteGoogleAuthOutcome(true);
    } catch (err) {
      console.error(`[job] executive report failed for site ${site.id} "${site.name}":`, err.message);
      await noteGoogleAuthOutcome(false, err);
    }
  }
  return results;
}

// Run the monthly Google Doc report for the previous full calendar month, but
// only if it hasn't been written yet this month — identical idempotency
// pattern to runWeeklyIfDue/runExecutiveIfDue above (own dedicated marker
// column, DATE compared against this period's start), not a special case.
// monthly_last_done already existed (migration 006_monthly_doc.sql, added
// alongside monthly_doc_id) but had never been read or written anywhere —
// this is that column's actual intended use, not a new field.
// Previously this report only ever ran via the manual `npm run monthly`
// script — the Reports page's Monthly tab had no automatic doc to link to.
// Manual `npm run monthly -- <ym>` bypasses this guard for backfills, same
// as weekly's manual override.
export async function runMonthlyIfDue(site) {
  const { year, month } = previousMonth(site.timezone);
  const { start } = monthBounds(year, month); // first day of that month, YYYY-MM-DD
  // Read as a plain YYYY-MM-DD string (PG DATE → JS Date would shift across timezones).
  const { rows } = await query(
    "SELECT to_char(monthly_last_done, 'YYYY-MM-DD') AS monthly_last_done FROM sites WHERE id = $1",
    [site.id]
  );
  const lastStr = rows[0]?.monthly_last_done || null;

  if (lastStr && lastStr >= start) {
    console.log(`[monthly] site ${site.id} month of ${start} already written — skipping.`);
    return null;
  }
  const r = await runMonthlyDocReport(site); // no anchor → previous full month
  await query('UPDATE sites SET monthly_last_done = $1 WHERE id = $2', [start, site.id]);
  console.log(`[monthly] site ${site.id} month of ${start} written; marker updated.`);
  return r;
}

// Run the monthly-if-due check independently for every connected site. Meant
// to be checked on the same weekly cron trigger as competitor/authority/
// ai-recommendation below (cron.js) — cheap to check weekly, only actually
// writes once a month, same "checked weekly, real work only when due"
// convention those three already use.
export async function runMonthlyIfDueForAllSites() {
  const sites = await listConnectedSites();
  const results = [];
  for (const site of sites) {
    try {
      results.push(await runMonthlyIfDue(site));
    } catch (err) {
      console.error(`[job] monthly report failed for site ${site.id} "${site.name}":`, err.message);
    }
  }
  return results;
}

// Hourly catch-up guard, run independently for every connected site: if a
// site's expected daily report is still missing past its own scheduled
// time, re-run the daily job (and weekly-if-due) for that site only. Same
// per-site idempotency as runDailyJob() itself — this just decides whether
// it's worth calling. `tz` is the fallback when a site has no timezone set.
//
// "Done" requires BOTH the narrative AND today's agent analysis to exist —
// not narrative alone. runDailyJobForSite writes the narrative early
// (ingest -> narrative -> email -> doc), well BEFORE the daily agent
// battery (runDailyAgentAnalysisForSite) that actually does detection and
// feeds shipping. Real incident, 2026-09-03: a hung GitHub request (fixed
// separately, see github/client.js) froze the 07:00 run partway through
// that battery — narrative/email/doc had already succeeded, so this guard
// saw a narrative and considered the whole day done, every hour, all day.
// The auto-remediation catch-up guard (runAutoRemediationCatchupForAllSites
// below) never got a reason to fire either, since nothing here ever
// re-opened the day. Checked via the same 'executive-report' agent_runs row
// runDailyAgentAnalysisForSite itself writes on completion (saveAgentRun) —
// created today in the site's own timezone, not just present at all, so a
// stale row from a PRIOR day's run (a still-connected site whose 07:00 pass
// hung every day this week, say) can't false-positive as "done" either.
export async function runHourlyCatchupForAllSites(tz) {
  const sites = await listConnectedSites();
  for (const site of sites) {
    try {
      const reportDate = daysAgoInTz(site.timezone || tz, GSC_LAG_DAYS);
      const [existing, [latestExecReport]] = await Promise.all([
        getNarrative(site.id, reportDate),
        getLatestAgentRuns(site.id, ['executive-report']),
      ]);
      const analysisDoneToday = latestExecReport != null
        && todayInTz(site.timezone || tz, new Date(latestExecReport.created_at)) === todayInTz(site.timezone || tz);
      if (existing?.narrative && analysisDoneToday) continue; // whole day's work genuinely done

      const reason = !existing?.narrative ? 'report missing' : 'detection incomplete';
      console.log(`[job] hourly guard: daily report for site ${site.id} "${site.name}" (${reportDate}) ${reason} — running catch-up`);
      const { reportDate: done } = await runDailyJobForSite(site);
      console.log(`[job] hourly guard: catch-up done for site ${site.id} — report date ${done}`);
      await runWeeklyIfDue(site);
      await runExecutiveIfDue(site);
      // GEO Audit shares the same Thursday-8am cron trigger as the two
      // calls above (cron.js) but had no catch-up here — if the process
      // wasn't up at that exact moment (a real risk: this app redeploys
      // often, e.g. multiple times in one day during active development),
      // every other weekly job on that trigger self-heals within the hour
      // via this guard, but GEO Audit silently skipped the whole week with
      // no backstop. Real incident: site #1's geo_audit_last_done shows a
      // real run on 2026-07-26, then nothing for 2 weeks despite the
      // weekly cadence, with the Thursday cron plausibly missed during one
      // of several same-day staging redeploys.
      await runGeoAuditIfDue(site);
      await noteGoogleAuthOutcome(true);
    } catch (err) {
      console.error(`[job] hourly guard failed for site ${site.id} "${site.name}":`, err.message);
      await noteGoogleAuthOutcome(false, err);
    }
  }
}

// THE FUSION PASS — runs BEFORE runAnalystSyncForAllSites below, on the same
// per-site, best-effort, never-throws posture. Combines decline-detection's
// page-level signals with the nightly insight pipeline's anomaly/forecast_risk/
// trend_shift rows and growth-opportunities.js's real-threshold opportunities
// into corroborated conclusions (analyst-fusion.js), gates them on real input
// freshness (analyst-freshness.js — the twelve-day MCP outage's fix), and
// ships only conclusions that clear the evidence bar as real recommendations
// through the SAME insertRecommendation/gates path syncAnalystInsightsToActionCenter
// already uses.
//
// Deliberately runs ahead of, not instead of, the two older sync functions:
// this covers page-dimension decline/growth signals with real corroboration;
// they still cover everything else (non-page insights, content-gap's own
// richer approval path). Where both would touch the same page+generator,
// findOpenRecommendation's existing-row check makes the second call a safe
// no-op — nothing here needed to change that idempotency contract.
export async function runAnalystFusionForAllSites() {
  const sites = await listConnectedSites();
  const totals = { sites: 0, created: 0, monitored: 0, stale: 0 };
  for (const site of sites) {
    try {
      const result = await runAnalystFusion(site.id, { site });
      totals.sites++;
      totals.created += result.created;
      totals.monitored += result.monitored;
      if (result.freshness?.verdict === 'stale') totals.stale++;
    } catch (err) {
      console.error(`[job] analyst fusion failed for site ${site.id} "${site.name}":`, err.message);
    }
  }
  if (totals.created || totals.stale) {
    console.log(`[job] analyst fusion complete — ${totals.created} recommendation(s) created, ${totals.monitored} monitored, ${totals.stale} site(s) with stale inputs, across ${totals.sites} site(s).`);
  }
  return totals;
}

// The outcome half of the same loop: for recommendations the fusion pass
// above created, checks whether fix-impact.js's own due-driven sweep
// (runDueImpactMeasurements) has produced a real before/after measurement
// yet, and if so records it back onto the analyst_evidence row — see
// agents/lib/analyst-outcome.js for why this never re-measures anything
// itself.
export async function runAnalystOutcomeSweepForAllSites() {
  const sites = await listConnectedSites();
  const totals = { sites: 0, checked: 0, recorded: 0 };
  for (const site of sites) {
    try {
      const { checked, recorded } = await sweepAnalystOutcomes(site.id);
      totals.sites++; totals.checked += checked; totals.recorded += recorded;
    } catch (err) {
      console.error(`[job] analyst outcome sweep failed for site ${site.id} "${site.name}":`, err.message);
    }
  }
  return totals;
}

// New-client FAQ coverage — the proactive half described in
// faq-onboarding-check.js's own doc comment: does this site have ANY FAQ
// content anywhere, and if genuinely not, generate one for the homepage
// instead of waiting for a reactive finding to notice. Cheap once a site
// has coverage (two DB checks, no fetch, no LLM call) — the one live fetch
// and (on a real gap) one recommendation insert only happen for a site that
// still has none, which stops happening forever once the first FAQ ships.
export async function runFaqOnboardingCoverageForAllSites() {
  const sites = await listConnectedSites();
  const totals = { sites: 0, created: 0 };
  for (const site of sites) {
    try {
      const result = await checkFaqOnboardingCoverage(site.id, { site });
      totals.sites++;
      if (result.created) {
        totals.created++;
        console.log(`[job] FAQ onboarding check: site ${site.id} "${site.name}" had no FAQ coverage anywhere — created a homepage FAQ recommendation.`);
      }
    } catch (err) {
      console.error(`[job] FAQ onboarding check failed for site ${site.id} "${site.name}":`, err.message);
    }
  }
  return totals;
}

// Verify stage: re-checks every due fix_verifications row (real re-fetch of
// the exact flagged page, real re-run of the exact check that flagged it —
// see agents/lib/fix-verification.js). Due-ness is per-row (verify_after),
// not per-site, so this runs once globally rather than per connected site.
// Carries the 3am Analyst cycle's output into the Action Center.
//
// data-analyst-agent runs its full nightly pipeline at 03:00 UTC
// (ingest_schedule_hour_utc) — collectors, forecasts, insights, including
// forecast_risk insights that predict a decline before it shows up in
// reporting. Until now none of that reached the Action Center: the only ways
// an insight could become a recommendation were a human clicking approve on
// one item at a time. Every night's analysis simply sat in the Analyst page.
//
// Creates recommendations only, never drafts, so analyst findings flow
// through the same risk-tier/auto-remediation machinery as every agent
// finding rather than getting their own parallel autonomy path.
//
// Best-effort per site and never throws: the Analyst is a separate service,
// and it being down must not take the rest of the schedule with it.
export async function runAnalystSyncForAllSites() {
  const sites = await listConnectedSites();
  const totals = { sites: 0, created: 0, skipped: 0, ineligible: 0 };

  for (const site of sites) {
    try {
      const insights = await fetchAnalystInsights(site.id);
      if (!insights.length) continue;
      const result = await syncAnalystInsightsToActionCenter(site.id, insights, { site });
      totals.sites++;
      totals.created += result.created;
      totals.skipped += result.skipped;
      totals.ineligible += result.ineligible;
      if (result.created) {
        console.log(`[job] analyst sync: site ${site.id} "${site.name}" created ${result.created} recommendation(s) from nightly insights.`);
      }
    } catch (err) {
      console.error(`[job] analyst sync failed for site ${site.id} "${site.name}":`, err.message);
    }
  }
  if (totals.created) console.log(`[job] analyst sync complete — ${totals.created} recommendation(s) across ${totals.sites} site(s).`);
  return totals;
}

// Website-wide Growth Opportunities (Analyst page, growth-opportunities.js)
// -> Action Center, weekly. Growth Opportunities is a read-time view over
// gsc_query_page (no cadence of its own — every call reflects the latest 30
// days), so this runs weekly rather than nightly: frequent enough to keep
// picking up newly-eligible opportunities as rankings move, without
// re-scoring the same mostly-unchanged month of GSC data every night the way
// the nightly analyst sync above does for genuinely new per-night insights.
//
// Same "recommendations only, never drafts" and best-effort-per-site
// discipline as runAnalystSyncForAllSites.
export async function runGrowthOpportunitiesSyncForAllSites() {
  const sites = await listConnectedSites();
  const totals = { sites: 0, created: 0, skipped: 0, ineligible: 0 };

  for (const site of sites) {
    try {
      const result = await syncGrowthOpportunitiesToActionCenter(site.id, { site });
      totals.sites++;
      totals.created += result.created;
      totals.skipped += result.skipped;
      totals.ineligible += result.ineligible;
      if (result.created) {
        console.log(`[job] growth opportunities sync: site ${site.id} "${site.name}" created ${result.created} recommendation(s).`);
      }
    } catch (err) {
      console.error(`[job] growth opportunities sync failed for site ${site.id} "${site.name}":`, err.message);
    }
  }
  if (totals.created) console.log(`[job] growth opportunities sync complete — ${totals.created} recommendation(s) across ${totals.sites} site(s).`);
  return totals;
}

// Content-gap autonomous shipping, weekly discovery half — runs alongside
// growthOppsSync in the same Monday cron slot (server/cron.js). Records this
// week's real-GSC evidence for every still-pending keyword_gaps row and
// refreshes lazy classification, so qualifyAndShipContentGaps below always
// sees fresh data. This is discovery bookkeeping only — it never ships
// anything and never touches sites.keyword_gap_ship_cycle_last_done.
export async function runKeywordGapDiscoveryRefreshForAllSites() {
  const sites = await listConnectedSites();
  const totals = { sites: 0, gaps: 0, observed: 0, classified: 0 };
  for (const site of sites) {
    try {
      const result = await refreshPendingKeywordGapObservations(site.id);
      totals.sites++;
      totals.gaps += result.gaps;
      totals.observed += result.observed;
      totals.classified += result.classified;
    } catch (err) {
      console.error(`[job] keyword-gap discovery refresh failed for site ${site.id} "${site.name}":`, err.message);
    }
  }
  if (totals.observed) console.log(`[job] keyword-gap discovery refresh complete — ${totals.observed} observation(s) recorded across ${totals.sites} site(s).`);
  return totals;
}

// Content-gap autonomous shipping — runs every Monday, for every eligible
// site, alongside the weekly discovery refresh above. Previously gated by a
// per-site 14-day cooldown on sites.keyword_gap_ship_cycle_last_done
// (migration 129), on the theory that discovery ran every 14 days so
// shipping should only check in every 14 days too. That theory was wrong in
// practice: discovery (keyword_clustering.py's RECLUSTER_INTERVAL_DAYS) runs
// weekly, and qualifyAndShipContentGaps already has its own evidence-based
// qualification gate (observation_count >= 2, relevance, non-decreasing
// demand) plus per-gap idempotency (a shipped gap moves to status='approved'
// and drops out of getKeywordGaps(siteId, 'pending_review'), so it can never
// be shipped twice) — the site-level cooldown on top of that just meant most
// Mondays silently shipped nothing for a site regardless of how many gaps
// had newly qualified. Removed; sites.keyword_gap_ship_cycle_last_done is
// still written, now purely as a "last shipped at" audit timestamp, read by
// nothing.
// Deps are injectable (matching queueDesignAgentDerivationsForAllSites'
// shape) so this can be unit-tested with plain fakes — job.js's own import
// graph reaches openai's formdata-node dependency, which fails to load
// under node:test's module-mocking loader (see job.design-agent-eligibility
// .test.js's precedent), so mock.module is not an option here.
export async function runKeywordGapShipCycleForAllSites({
  listAllSites = listConnectedSites,
  shipForSite = qualifyAndShipContentGaps,
  markShipped = (siteId) => query('UPDATE sites SET keyword_gap_ship_cycle_last_done = now() WHERE id = $1', [siteId]),
} = {}) {
  const sites = await listAllSites();
  const totals = { sites: 0, shipped: 0 };
  for (const site of sites) {
    try {
      const result = await shipForSite(site.id, site);
      await markShipped(site.id);
      totals.sites++;
      totals.shipped += result.shipped;
      if (result.shipped) {
        console.log(`[job] keyword-gap ship cycle: site ${site.id} "${site.name}" shipped ${result.shipped} of ${result.candidates} qualified gap(s).`);
      }
    } catch (err) {
      console.error(`[job] keyword-gap ship cycle failed for site ${site.id} "${site.name}":`, err.message);
    }
  }
  return totals;
}

// Reads the Analyst service's own insights endpoint (GET /clients/{client_id}
// /insights — data-analyst-agent/app/api/routes/dashboard.py's
// _recent_insights, the same recent-insights read GET /dashboard/{client_id}
// itself builds from). Uses the shared admin-key-injecting client
// (lib/data-analyst-client.js) like every other Node->Python call — a
// hand-rolled fetch() here previously sent no X-Admin-Key at all, which
// get_active_client's require_admin_key dependency rejects on every
// /clients/{client_id}/* route.
export async function fetchAnalystInsights(siteId) {
  const body = await callDataAnalystAgent(`/clients/${siteId}/insights`);
  return Array.isArray(body) ? body : (body?.insights || []);
}

// The SHIPPING half of the day, deliberately separated from the DETECTION
// half (runDailyAgentAnalysisForSite, 07:00). This is what turns the
// recommendations that morning found into a real branch + PR, highest
// priority first: listOpenRecommendations already orders high -> medium ->
// low, and auto-remediation takes the first N within the site's daily budget
// off that ordered list, so severity ordering needs no second implementation
// here.
//
// Per-site isolation is the point of the loop: one tenant's revoked token,
// conflicted batch branch, or unreachable repo must never stop another
// tenant's PR from being opened. Same shape as every other *ForAllSites
// runner in this file.
//
// Repo-connected rather than listConnectedSites' GSC/GA4 filter — the same
// choice runPrStatusPollForAllSites makes below, and for the same reason:
// whether a site can have work SHIPPED depends on repo_owner/repo_name.
// A site with analytics but no repo has nothing to push to, and
// autoRemediateSafeRecommendations' own auto_remediation_enabled gate stays
// the real opt-in on top of that.
// Optional platform-wide safety ceiling on top of every site's own
// auto_remediation_daily_limit (item 7a) — unset by default, in which case
// globalRemainingSeed() returns Infinity and behavior is byte-for-byte
// unchanged from before this existed. Each site's per-site budget is still
// the precise control; this is a blunt additional backstop for "the total
// across every onboarded site got too large," not a replacement for it.
// Seeded from a real count of today's already-shipped drafts (not reset to
// 0) so the hourly catch-up loop below correctly resumes the same day's
// running total rather than re-granting a fresh ceiling every time it fires.
async function globalRemainingSeed() {
  const ceiling = Number(process.env.AUTO_REMEDIATION_GLOBAL_DAILY_CEILING);
  if (!Number.isFinite(ceiling) || ceiling < 0) return Infinity;
  const alreadyShipped = await countDraftsBySourceTodayAllSites('auto-remediation');
  return Math.max(0, ceiling - alreadyShipped);
}

// Runs server/scripts/repair-template-capability.js's core for every
// repo-connected site — the shared-template ('site-fact') half of the
// capability-repair story, distinct from autoHealFileMapping/
// autoHealNewContentTarget (implementers/lib/discover-*.js, already run
// inline inside every recommendation-gates.js pass, no separate cron entry
// needed). This one opens its own PR directly (bypassing the drafts table
// entirely — see that file's own doc comment on why), so it gets its own
// step here rather than folding into runAutoRemediationForAllSites, which
// only ever ships already-drafted, already-approved recommendations.
// Per-site error isolation, same as every other *ForAllSites function: one
// site's repo/PR failure must never cost every other site its own run.
export async function runTemplateCapabilityRepairForAllSites() {
  const { repairTemplateCapabilitiesForSite } = await import('./scripts/repair-template-capability.js');
  const sites = (await listSites()).filter((s) => s.repo_owner && s.repo_name);
  const results = [];
  for (const site of sites) {
    try {
      const report = await repairTemplateCapabilitiesForSite(site.id);
      const prCount = report.prsCreated.length;
      const fixedCount = report.plumbingGapsFixed.length + report.safeCapabilityGapsRepaired.length;
      if (prCount || fixedCount) {
        console.log(`[job] template-capability-repair site ${site.id} "${site.name}": ${fixedCount} config fix(es), ${prCount} PR(s) opened, ${report.architecturalGapsBlocked.length} still needing a human decision.`);
      }
      results.push({ siteId: site.id, ...report });
    } catch (err) {
      console.error(`[job] template-capability-repair failed for site ${site.id} "${site.name}":`, err.message);
      results.push({ siteId: site.id, error: err.message });
    }
  }
  return results;
}

// Runs the role-correction pass (server/scripts/repair-design-profile-roles.js)
// against every site with a stored design profile, every morning — the
// role-mismatch defect it fixes (a real, live class assigned to the wrong
// typography slot) is a property of the DERIVATION, so it can recur on any
// site whenever its profile is re-derived (queueDesignProfileRescanForAllSites,
// weekly). Deliberately runs BEFORE runContentRepairForAllSites in the same
// morning chain, so content-repair always re-renders shipped content through
// whatever this pass just corrected, never a stale template.
export async function runDesignProfileRoleCorrectionForAllSites() {
  const { repairDesignProfileRolesForSites } = await import('./scripts/repair-design-profile-roles.js');
  const { rows: sites } = await query(`select * from sites
     where url_file_map->'siteRoot'->'designProfile' is not null order by id`);
  const result = await repairDesignProfileRolesForSites(sites, { commit: true });
  if (result.changed) {
    console.log(`[job] design-profile role correction: ${result.changed}/${result.examined} site(s) had role corrections, ${result.failed} failed.`);
  }
  return result;
}

// The systemic counterpart to repair-design-profile-roles.js's morning role
// re-verification (see queueDesignProfileRescanForAllSites/cron.js): correcting
// the STORED templates fixes what a site generates from now on, but content
// already spliced into the repo before the correction stays wrong until
// something re-renders it. This is that something, run every morning against
// every connected site rather than once by hand — the exact repair used to fix
// zunkireelabs.com's shipped content (component-template restyling,
// visible_faq_cap enforcement, blog front-matter contract, directory-collection
// self-inclusion, and unresolved-placeholder/fabricated-competitor removal),
// now automated. See scripts/repair-site-content-live.js's own module comment.
export async function runContentRepairForAllSites() {
  const { repairSiteContentLive } = await import('./scripts/repair-site-content-live.js');
  const sites = (await listSites()).filter((s) => s.repo_owner && s.repo_name);
  const results = [];
  for (const site of sites) {
    try {
      const report = await repairSiteContentLive(site.id);
      if (report.prCreated) {
        console.log(`[job] content-repair site ${site.id} "${site.name}": ${report.changedFiles.length} file(s) repaired, PR ${report.prCreated.url}`);
      }
      results.push(report);
    } catch (err) {
      console.error(`[job] content-repair failed for site ${site.id} "${site.name}":`, err.message);
      results.push({ siteId: site.id, error: err.message });
    }
  }
  return results;
}

// Daily counterpart to runTemplateCapabilityRepairForAllSites above — runs
// right after it so it sees the SAME morning's freshly-healed config
// (autoHealNewContentTarget/autoHealFileMapping already ran, any
// architectural gap already got its capability-repair job dispatched).
// Re-validates every open, currently-blocked recommendation against that
// live state and writes back whatever changed: a block whose root cause got
// fixed clears (the recommendation re-enters the normal risk-tier/shipping
// flow the same morning), one that regressed re-blocks. Excludes
// content-gap-derived rows on purpose — those get their own slower weekly
// pass (see refreshContentGapRecommendationsForAllSites) so a topic
// approved last week isn't re-validated every single day for no reason.
// Never touches anything already shipped/merged/closed: refreshBlockedRecommendations
// only ever reads/writes status = 'open' rows.
export async function refreshBlockedRecommendationsForAllSites() {
  const sites = (await listSites()).filter((s) => s.repo_owner && s.repo_name);
  const results = [];
  for (const site of sites) {
    try {
      const result = await refreshBlockedRecommendations(site.id, { excludeDetectingAgent: 'analyst-keyword-gaps' });
      if (result.checked) {
        console.log(`[job] blocked-recommendation refresh site ${site.id} "${site.name}": ${result.checked} checked, ${result.updated} unblocked/updated.`);
      }
      results.push({ siteId: site.id, ...result });
    } catch (err) {
      console.error(`[job] blocked-recommendation refresh failed for site ${site.id} "${site.name}":`, err.message);
      results.push({ siteId: site.id, error: err.message });
    }
  }
  return results;
}

// Weekly counterpart, scoped to exactly the rows the daily pass above
// excludes: recommendations created by createActionCenterRecommendationForGap
// (analyst-seo-mapping.js) — blog-outline, landing-page, comparison-page,
// gap-based faq. These are never re-detected by any daily agent (content-gap
// approval is a one-time human/MCP action, not part of the grounded
// detection pass), so without this they'd stay frozen on whatever
// blocked_reason they had at approval time forever. Weekly matches the cadence
// content itself is meant to be revisited on, mirroring the existing
// weekly design-context rescan pattern in cron.js.
export async function refreshContentGapRecommendationsForAllSites() {
  const sites = (await listSites()).filter((s) => s.repo_owner && s.repo_name);
  const results = [];
  for (const site of sites) {
    try {
      const result = await refreshBlockedRecommendations(site.id, { onlyDetectingAgent: 'analyst-keyword-gaps' });
      if (result.checked) {
        console.log(`[job] content-gap recommendation refresh site ${site.id} "${site.name}": ${result.checked} checked, ${result.updated} unblocked/updated.`);
      }
      results.push({ siteId: site.id, ...result });
    } catch (err) {
      console.error(`[job] content-gap recommendation refresh failed for site ${site.id} "${site.name}":`, err.message);
      results.push({ siteId: site.id, error: err.message });
    }
  }
  return results;
}

export async function runAutoRemediationForAllSites() {
  const sites = (await listSites()).filter(isShippable);
  const results = [];
  let globalRemaining = await globalRemainingSeed();
  for (const site of sites) {
    if (globalRemaining <= 0) {
      console.log(`[job] auto-remediation: platform-wide daily ceiling reached — skipping remaining ${sites.length - results.length} site(s) this run.`);
      break;
    }
    try {
      const result = await autoRemediateSafeRecommendations(site.id, { globalRemaining });
      globalRemaining -= result.shipped || 0;
      if (result.attempted || result.shipped) {
        console.log(`[job] auto-remediation site ${site.id} "${site.name}": attempted ${result.attempted}, shipped ${result.shipped}, failed ${result.failed}${result.stoppedReason ? ` (stopped: ${result.stoppedReason})` : ''}`);
      }
      results.push({ siteId: site.id, ...result });
    } catch (err) {
      console.error(`[job] auto-remediation failed for site ${site.id} "${site.name}":`, err.message);
      results.push({ siteId: site.id, error: err.message });
    }
  }
  return results;
}

// Catch-up guard for the shipping run above, mirroring runHourlyCatchupForAllSites'
// role for the morning job. Recorded engineering lesson
// (job-scheduling-reliability): cron alone is not a reliable trigger on a
// machine that sleeps, and this app is in fact hosted on one — a missed 13:00
// fire would otherwise mean a whole day with no PR and nothing to notice it.
//
// "Budget remaining today" is measured the same way auto-remediation measures
// its own daily budget — drafts it created today in the SITE's timezone,
// compared against sites.auto_remediation_daily_limit — rather than a new
// state column, so the guard can never disagree with the thing it guards (see
// isShipCatchupOwed). This also catches a run that shipped something but
// stopped short of the budget (the circuit breaker tripping mid-run is the
// common case), not just a run that shipped nothing at all. A site with
// budget left re-checks cheaply each hour, which is the same trade the
// narrative guard already makes, and is useful rather than wasteful: a
// recommendation detected later in the day still ships the same day, onto the
// same batch branch/PR.
export async function runAutoRemediationCatchupForAllSites(tz) {
  const sites = (await listSites()).filter(isShippable);
  let globalRemaining = await globalRemainingSeed();
  for (const site of sites) {
    if (globalRemaining <= 0) {
      console.log('[job] auto-remediation catch-up: platform-wide daily ceiling already reached — skipping this pass.');
      break;
    }
    try {
      const alreadyShippedToday = await countDraftsBySourceToday(site.id, 'auto-remediation', site.timezone || tz);
      if (!isShipCatchupOwed({ site, alreadyShippedToday, fallbackTimezone: tz })) continue;

      const result = await autoRemediateSafeRecommendations(site.id, { globalRemaining });
      globalRemaining -= result.shipped || 0;
      if (result.shipped) console.log(`[job] auto-remediation catch-up: site ${site.id} shipped ${result.shipped} after a missed ${SHIP_HOUR_LOCAL}:00 run`);
    } catch (err) {
      console.error(`[job] auto-remediation catch-up failed for site ${site.id} "${site.name}":`, err.message);
    }
  }
}

// Impact measurement's due-sweep, the sibling of runFixVerificationsForAllSites
// below. Also global rather than per-site: due-ness is per ROW (28 days after
// that draft's own merge), not per site, so there is nothing to iterate sites
// for. See agents/lib/fix-impact.js for why the delay is as long as it is.
export async function runFixImpactMeasurementsForAllSites() {
  try {
    return await runDueImpactMeasurements();
  } catch (err) {
    console.error('[job] fix impact measurement failed:', err.message);
    return [];
  }
}

// Proactive Design Agent trigger — scheduled at 06:00 local (cron.js), a full
// hour ahead of the 07:00 detect+ship pass. Before this existed, a site's
// design profile was only ever queued REACTIVELY, the first time a draft
// attempt hit resolveOrCreateComponentTemplate — which for a site with no
// profile yet meant the very same 07:00 pass that needed it, racing
// design-drift.js's bounded wait (DESIGN_AGENT_WAIT_MS) instead of having any
// real lead time. This gives every site connected before this run a full
// hour of head start, so by 07:00 its profile is normally already done and
// that bounded wait becomes a safety net for genuinely new same-morning
// sites, not the main path.
//
// Fire-and-forget: queues, does not wait — the always-running design-agent
// worker container drains the queue on its own schedule. One bad site's
// queue-insert failure must never block another site's.
//
// Also called directly (not just from the 06:00 sweep) the moment a site's
// repo gets connected — see routes/clients.js's repo-connect route — so a
// site added mid-day starts deriving its design profile right away instead
// of sitting unverified until the next 06:00 pass.
// Deps are injectable (same pattern as design-drift.js's
// resolveOrCreateComponentTemplate) so the eligibility gate itself —
// job.design-agent-eligibility.test.js — is unit-testable with plain
// imports. job.js's own import graph reaches openai's formdata-node
// dependency, which cannot load under node:test's module-mocking loader, so
// mock.module is not an option here the way it is for smaller modules.
export async function queueDesignAgentDerivationForSite(site, {
  hasUsableProfile = siteHasUsableDesignProfile,
  findQueuedProfileJob = getQueuedComponentTemplateJob,
  enqueueProfileJob = createDesignProfileJob,
  resolvePageUrl = sitePageUrl,
} = {}) {
  // Eligibility used to also require auto_remediation_enabled, on the
  // reasoning that a repo-connected site becomes eligible "the moment a
  // human has done the one-time auto-remediation review." The
  // design-integrity gate (design-drift.js's designReviewState,
  // validateAutoRemediationRequest in routes/clients.js) inverted that: a
  // site can no longer GET auto_remediation_enabled until its design has
  // been reviewed, and there is nothing to review until a profile has been
  // derived — so requiring auto_remediation_enabled here made this
  // permanently unreachable for every site going through this path,
  // deadlocked on itself. Derivation is read-only (it only writes
  // designProfile/componentTemplates config, never touches the live repo),
  // so it never needed that consent in the first place — only SHIPPING
  // styled markup does, and that is gated separately and directly at apply
  // time (backend.js's computeMarkerMerge / frontend.js's apply, both via
  // designReviewState). A connected repo is still required: this queues a
  // real Design Agent job against that repo's live pages.
  if (!site?.repo_owner || !site?.repo_name) return false;
  if (hasUsableProfile(site)) return false;
  try {
    const pending = await findQueuedProfileJob(site.id, DESIGN_PROFILE_JOB_KEY);
    if (pending) return false;
    await enqueueProfileJob(site.id, { requestedBy: null, pageUrl: resolvePageUrl(site) });
    return true;
  } catch (err) {
    console.error(`[job] could not queue design-profile derivation for site ${site.id}:`, err.message);
    return false;
  }
}

export async function queueDesignAgentDerivationsForAllSites({
  listAllSites = listSites,
  queueForSite = queueDesignAgentDerivationForSite,
} = {}) {
  // Matches queueDesignAgentDerivationForSite's own gate — no longer filters
  // on auto_remediation_enabled, for the same deadlock reason (see that
  // function's comment). A site awaiting its first design review is exactly
  // the site this daily sweep most needs to reach — without a profile it
  // can never move past 'unreviewed'.
  const sites = (await listAllSites()).filter((s) => s.repo_owner && s.repo_name);
  let queued = 0;
  for (const site of sites) {
    if (await queueForSite(site)) queued++;
  }
  if (queued) console.log(`[job] design-agent: queued ${queued} whole-site derivation(s) ahead of today's 07:00 run`);
  return { queued };
}

// Queues the FIRST design-profile derivation as part of onboarding itself
// (routes/clients.js's runBaselineSequence), not on a cron a new client may
// sit unqueued in front of for hours. This is the design-integrity-gate
// proposal's change 01: reading a client's design leads onboarding rather
// than trailing behind it — staff can review and sign off (change 04's
// gate) in the same sitting they connect GSC/GA4/the repo, before this
// site's agents are ever allowed to ship a single styled fix.
//
// Deliberately repo-INDEPENDENT, unlike queueDesignAgentDerivationForSite
// above: derivation only needs a reachable live URL to look at (sitePageUrl)
// — the repository is needed to SHIP a template, never to compose or review
// one, and per this platform's own account, no client site has a repo
// connected at onboarding time. Requiring one here would mean design review
// — and therefore the ability to ever enable autonomy — waits on a step
// that, for every real client today, hasn't happened yet.
export async function queueDesignProfileDerivationForOnboarding(site, {
  hasUsableProfile = siteHasUsableDesignProfile,
  findQueuedProfileJob = getQueuedComponentTemplateJob,
  enqueueProfileJob = createDesignProfileJob,
  resolvePageUrl = sitePageUrl,
} = {}) {
  const pageUrl = resolvePageUrl(site);
  if (!pageUrl) return false;
  if (hasUsableProfile(site)) return false;
  try {
    const pending = await findQueuedProfileJob(site.id, DESIGN_PROFILE_JOB_KEY);
    if (pending) return false;
    await enqueueProfileJob(site.id, { requestedBy: null, pageUrl });
    return true;
  } catch (err) {
    console.error(`[job] could not queue onboarding design-profile derivation for site ${site.id}:`, err.message);
    return false;
  }
}

// Design Context (design-agent/live-analysis/) is a durable asset, not
// derived fresh per draft — see live-analysis-handler.js's own comment.
// This is what keeps it current: once a week, every site whose profile is
// older than staleAfterMs gets a fresh live-site analysis queued, so a real
// redesign is picked up automatically instead of drafts silently following
// a design the site abandoned. Deliberately a SEPARATE function from
// queueDesignAgentDerivationForSite above rather than one function with a
// branch — that one's whole contract is "only ever queues a FIRST
// derivation" (hasUsableProfile a site already has short-circuits it), and
// conflating "never analyzed" with "analyzed a week ago" would blur two
// different situations (a broken site vs. a routine refresh) behind one
// piece of logic.
const DESIGN_PROFILE_RESCAN_STALE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

export async function queueDesignProfileRescanForSite(site, {
  hasUsableProfile = siteHasUsableDesignProfile,
  getProfile = getDesignProfile,
  findQueuedProfileJob = getQueuedComponentTemplateJob,
  enqueueProfileJob = createDesignProfileJob,
  resolvePageUrl = sitePageUrl,
  now = () => Date.now(),
  staleAfterMs = DESIGN_PROFILE_RESCAN_STALE_AFTER_MS,
} = {}) {
  if (!site?.auto_remediation_enabled || !site?.repo_owner || !site?.repo_name) return false;
  // A site with no usable profile yet is queueDesignAgentDerivationForSite's
  // job (the reactive first-derivation path also covers it) — this function
  // only ever refreshes an EXISTING profile.
  if (!hasUsableProfile(site)) return false;

  const profile = getProfile(site);
  const derivedAt = profile?.derivedAt ? Date.parse(profile.derivedAt) : NaN;
  if (Number.isFinite(derivedAt) && now() - derivedAt < staleAfterMs) return false;

  try {
    const pending = await findQueuedProfileJob(site.id, DESIGN_PROFILE_JOB_KEY);
    if (pending) return false;
    await enqueueProfileJob(site.id, { requestedBy: null, pageUrl: resolvePageUrl(site) });
    return true;
  } catch (err) {
    console.error(`[job] could not queue design-profile rescan for site ${site.id}:`, err.message);
    return false;
  }
}

export async function queueDesignProfileRescanForAllSites({
  listAllSites = listSites,
  queueForSite = queueDesignProfileRescanForSite,
} = {}) {
  const sites = (await listAllSites()).filter((s) => s.auto_remediation_enabled && s.repo_owner && s.repo_name);
  let queued = 0;
  for (const site of sites) {
    if (await queueForSite(site)) queued++;
  }
  if (queued) console.log(`[job] design-agent: queued ${queued} design-profile rescan(s) for sites with a stale profile`);
  return { queued };
}

// Whole-site design-consistency scan (agents/lib/design-consistency.js,
// design-agent/live-analysis/consistency-check.js) — the "does every real
// page still match the site's own design" check the daily
// runContentRepairForAllSites pass never covers, because that one is
// scoped to SEOAI-marker regions only. Same weekly cadence and staleness
// gate as the design-profile rescan just above (a real browser capture per
// page type is genuinely expensive — this is not a per-agent-run inline
// check the way technical-seo.js/mobile-usability.js's static-fetch checks
// are), and the same hard precondition: a site needs a USABLE STORED
// PROFILE to compare against, so this only ever runs for a site the
// profile rescan above has already kept current.
const CONSISTENCY_SCAN_STALE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

export async function queueConsistencyScanForSite(site, {
  hasUsableProfile = siteHasUsableDesignProfile,
  findQueuedScanJob = getQueuedComponentTemplateJob,
  getLatestScanJob = getLatestDesignAgentJob,
  enqueueScanJob = createConsistencyScanJob,
  resolvePageUrl = sitePageUrl,
  now = () => Date.now(),
  staleAfterMs = CONSISTENCY_SCAN_STALE_AFTER_MS,
} = {}) {
  if (!site?.auto_remediation_enabled || !site?.repo_owner || !site?.repo_name) return false;
  if (!hasUsableProfile(site)) return false; // nothing real to compare against yet

  try {
    const pending = await findQueuedScanJob(site.id, CONSISTENCY_SCAN_JOB_KEY);
    if (pending) return false;

    const latest = await getLatestScanJob(site.id, CONSISTENCY_SCAN_JOB_KEY);
    const finishedAt = latest?.finished_at ? Date.parse(latest.finished_at) : NaN;
    if (Number.isFinite(finishedAt) && now() - finishedAt < staleAfterMs) return false;

    await enqueueScanJob(site.id, { requestedBy: null, pageUrl: resolvePageUrl(site) });
    return true;
  } catch (err) {
    console.error(`[job] could not queue consistency scan for site ${site.id}:`, err.message);
    return false;
  }
}

export async function queueConsistencyScanForAllSites({
  listAllSites = listSites,
  queueForSite = queueConsistencyScanForSite,
} = {}) {
  const sites = (await listAllSites()).filter((s) => s.auto_remediation_enabled && s.repo_owner && s.repo_name);
  let queued = 0;
  for (const site of sites) {
    if (await queueForSite(site)) queued++;
  }
  if (queued) console.log(`[job] design-agent: queued ${queued} whole-site consistency scan(s)`);
  return { queued };
}

export async function runFixVerificationsForAllSites() {
  try {
    const results = await runDueVerifications();
    if (results.length) console.log(`[job] fix verification: checked ${results.length} due row(s)`);
    return results;
  } catch (err) {
    console.error('[job] fix verification failed:', err.message);
    return [];
  }
}

// Polling fallback for PR-merge detection — the GitHub webhook (routes/
// webhooks.js) already handles this in real time when it fires, but webhook
// registration on a client's repo is a fully manual GitHub-settings step
// with nothing in this app that verifies it was actually done, and a
// misconfigured/never-created webhook would otherwise strand a draft at
// 'pr_opened' forever with no automated recovery. This is a safety net, not
// a replacement — both stay active, and both call the exact same
// checkDraftPrStatus so behavior can never diverge. Errors are logged per
// draft, never fatal to the sweep — one bad PR read shouldn't block every
// other site's check. Dynamic import avoids a static circular dependency
// with routes/action-center.js (which already imports from this file).
export async function runPrStatusPollForAllSites() {
  const { listDrafts } = await import('./store/drafts.js');
  const { checkDraftPrStatus } = await import('./routes/action-center.js');
  // Repo-connected, not GSC/GA4-connected (listConnectedSites' filter) —
  // whether a site has open GitHub PRs to check depends on repo_owner/
  // repo_name, not analytics integration status.
  const sites = (await listSites()).filter((s) => s.repo_owner && s.repo_name);
  let checked = 0;
  for (const site of sites) {
    let openDrafts;
    try {
      openDrafts = await listDrafts(site.id, { status: 'pr_opened' });
    } catch (err) {
      console.error(`[job] pr-status poll: could not list drafts for site ${site.id}:`, err.message);
      continue;
    }
    for (const draft of openDrafts) {
      try {
        await checkDraftPrStatus(site.id, draft.id);
        checked++;
      } catch (err) {
        console.error(`[job] pr-status poll: check failed for site ${site.id} draft ${draft.id}:`, err.message);
      }
    }
  }
  if (checked) console.log(`[job] pr-status poll: checked ${checked} open PR draft(s)`);
  return checked;
}

// One-shot catch-up run on server boot: ingest recent days (backfills anything
// missed while the machine was off/asleep) and write the weekly doc if it's
// due, independently for every connected site. Guarded by DISABLE_CATCHUP.
// Errors are logged per site, never crash the server.
export async function runStartupCatchup() {
  if (process.env.DISABLE_CATCHUP === 'true') {
    console.log('[catchup] disabled via DISABLE_CATCHUP.');
    return;
  }
  const sites = await listConnectedSites();
  for (const site of sites) {
    try {
      console.log(`[catchup] running daily job on startup for site ${site.id} "${site.name}"…`);
      await runDailyJobForSite(site);
      await runWeeklyIfDue(site);
      await runExecutiveIfDue(site);
      await runGeoAuditIfDue(site);
      await noteGoogleAuthOutcome(true);
    } catch (err) {
      console.error(`[catchup] error for site ${site.id} "${site.name}":`, err.message);
      await noteGoogleAuthOutcome(false, err);
    }
  }

  // Also reconcile any recommendation left blocked by config that got fixed
  // while this process was down. Every deploy restarts the process — without
  // this, a config fix (connect-repo, a manual url_file_map edit, the very
  // code fix this deploy is shipping) sits invisible until the next 07:00
  // local cron tick instead of unblocking the moment the fix is actually
  // running. Real incident (2026-08-27): a deploy that fixed a Design Agent
  // build failure left ~250 already-resolvable recommendations sitting
  // blocked for hours because nothing re-evaluated them until the next
  // scheduled pass. Both the daily and weekly-content-gap passes (see their
  // own split below) — pure re-evaluation against live gate state, no PR
  // side effects, safe to run on every restart including a crash-loop.
  try {
    const [daily, weekly] = await Promise.all([
      refreshBlockedRecommendationsForAllSites(),
      refreshContentGapRecommendationsForAllSites(),
    ]);
    const updated = [...daily, ...weekly].reduce((n, r) => n + (r.updated || 0), 0);
    if (updated) console.log(`[catchup] blocked-recommendation reconciliation: ${updated} recommendation(s) unblocked/updated.`);
  } catch (err) {
    console.error('[catchup] blocked-recommendation reconciliation error:', err.message);
  }

  console.log('[catchup] done.');
}
