import { getOrCreateSite, query } from './db.js';
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
import { daysAgoInTz, dateRange, previousWeek, previousMonth, monthBounds } from './util/dates.js';
import { runOrchestration } from './agents/orchestrator.js';
import { runAgent } from './agents/runner.js';
import { saveAgentRun, getLatestAgentRuns } from './store/agent-runs.js';
import { meta as execReportMeta } from './agents/executive-report.js';
import { computeHealthScore } from './agents/lib/health-score.js';
import { RECOMMENDATION_AGENT_IDS } from './agents/lib/insights.js';
import { detectNotificationEvents } from './notifications/detect.js';
import { deliverToAllChannels } from './notifications/channels/index.js';
import { buildRecommendations } from './agents/lib/recommendations.js';
import { syncFromGrounded } from './agents/lib/recommendation-coordinator.js';
import { autoRemediateSafeRecommendations } from './agents/lib/auto-remediation.js';
import { syncAnalystInsightsToActionCenter } from './agents/lib/analyst-seo-mapping.js';
import { getImplementedFindingIds, countDraftsBySourceToday } from './store/drafts.js';
import { isShippable, isShipCatchupOwed, SHIP_HOUR_LOCAL } from './lib/ship-window.js';
import { syncWatchlist } from './agents/lib/watchlist.js';
import { discoverFromSitemaps, crawlSite } from './agents/lib/site-discovery.js';
import { getSearchPerformanceRange } from './store/read.js';
import { knownDomain, filterOwnDomainPages } from './agents/lib/site-domain.js';
import { upsertPageInventoryBatch, getLastDiscoveryAt, markOrphanedPages } from './store/page-inventory.js';
import { runDueVerifications } from './agents/lib/fix-verification.js';

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
  await saveAgentRun({
    siteId: site.id, agentId: 'executive-report', agentVersion: execReportMeta.version,
    input: { siteId: site.id, start, end }, status: 'ok',
    facts: { rangeStart: start, rangeEnd: end, sections: result.perAgent, topFindings: result.findings.slice(0, 3), findings: result.findings },
    narrative: result.narrative, error: null, tookMs: null,
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

  const recommendations = await buildRecommendations(site.id);
  await syncFromGrounded(site.id, recommendations)
    .catch((err) => console.error(`[job] site ${site.id} recommendation coordinator sync failed:`, err.message));
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
  const domain = knownDomain(site);
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
export async function runHourlyCatchupForAllSites(tz) {
  const sites = await listConnectedSites();
  for (const site of sites) {
    try {
      const reportDate = daysAgoInTz(site.timezone || tz, GSC_LAG_DAYS);
      const existing = await getNarrative(site.id, reportDate);
      if (existing?.narrative) continue; // already done for this site

      console.log(`[job] hourly guard: daily report for site ${site.id} "${site.name}" (${reportDate}) missing — running catch-up`);
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

// Reads the Analyst service's own insights endpoint. Kept here rather than
// importing routes/dataAnalyst.js's callPython, which is request-scoped and
// not exported — one small fetch is cheaper than restructuring that module.
async function fetchAnalystInsights(siteId) {
  const base = process.env.DATA_ANALYST_AGENT_INTERNAL_URL || 'http://127.0.0.1:8000';
  const url = new URL(`/clients/${siteId}/insights`, base);
  const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`analyst insights returned HTTP ${res.status}`);
  const body = await res.json();
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
export async function runAutoRemediationForAllSites() {
  const sites = (await listSites()).filter(isShippable);
  const results = [];
  for (const site of sites) {
    try {
      const result = await autoRemediateSafeRecommendations(site.id);
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
// "Already ran today" is measured the same way auto-remediation measures its
// own budget — drafts it created today in the SITE's timezone — rather than a
// new state column, so the guard can never disagree with the thing it guards.
// A site that legitimately had zero candidates at 13:00 re-checks cheaply each
// hour, which is the same trade the narrative guard already makes, and is
// useful rather than wasteful: a recommendation detected later in the day
// still ships the same day, onto the same batch branch/PR.
export async function runAutoRemediationCatchupForAllSites(tz) {
  const sites = (await listSites()).filter(isShippable);
  for (const site of sites) {
    try {
      const alreadyShippedToday = await countDraftsBySourceToday(site.id, 'auto-remediation', site.timezone || tz);
      if (!isShipCatchupOwed({ site, alreadyShippedToday, fallbackTimezone: tz })) continue;

      const result = await autoRemediateSafeRecommendations(site.id);
      if (result.shipped) console.log(`[job] auto-remediation catch-up: site ${site.id} shipped ${result.shipped} after a missed ${SHIP_HOUR_LOCAL}:00 run`);
    } catch (err) {
      console.error(`[job] auto-remediation catch-up failed for site ${site.id} "${site.name}":`, err.message);
    }
  }
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
  console.log('[catchup] done.');
}
