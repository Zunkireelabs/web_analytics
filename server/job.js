import { getOrCreateSite, query } from './db.js';
import { fetchGscForDate } from './ingest/gsc.js';
import { fetchGa4ForDate } from './ingest/ga4.js';
import { fetchCompetitorRankings } from './ingest/competitors.js';
import { upsertGsc, upsertGa4, saveNarrative, markDailyDocDone, saveCompetitorRankings, saveHealthScoreSnapshot, recordIntegrationCheck } from './store/upsert.js';
import { getDay, getNarrative, listSites, getCompetitorRankingDates, getHealthScoreOnOrBefore } from './store/read.js';
import { generateNarrative } from './report/narrative.js';
import { sendDailyEmail } from './report/email.js';
import { runWeeklyDocReport } from './report/weekly-doc.js';
import { runDailyDocReport } from './report/daily-doc.js';
import { runExecutiveDocReport } from './report/executive-doc.js';
import { isGoogleAuthError } from './integrations/google-oauth.js';
import { daysAgoInTz, dateRange, previousWeek } from './util/dates.js';
import { runOrchestration } from './agents/orchestrator.js';
import { saveAgentRun } from './store/agent-runs.js';
import { meta as execReportMeta } from './agents/executive-report.js';
import { computeHealthScore } from './agents/lib/health-score.js';
import { RECOMMENDATION_AGENT_IDS } from './agents/lib/insights.js';
import { detectNotificationEvents } from './notifications/detect.js';
import { deliverToAllChannels } from './notifications/channels/index.js';
import { buildRecommendations } from './agents/lib/recommendations.js';
import { syncWatchlist } from './agents/lib/watchlist.js';

// Daily-cadence agents only — competitor-intelligence stays weekly (see
// runCompetitorCheckIfDue below), it's cost-bounded on purpose.
const DAILY_AGENT_IDS = RECOMMENDATION_AGENT_IDS.filter((id) => id !== 'competitor-intelligence');

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
// date" is the freshest day that has FINAL GSC data (today - 3).
async function runDailyIngestForSite(site) {
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

// Runs the 6 daily-cadence specialist agents fresh via the shared
// orchestrator, persists an executive-report row from that same result
// (same pattern as routes/command-center.js's refresh route — avoids a
// second call to executive-report.js re-running all 6 agents again), then
// detects and delivers any notification-worthy events from what changed.
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

  const { score } = computeHealthScore(result.findings);
  const today = new Date().toISOString().slice(0, 10);
  await saveHealthScoreSnapshot(site.id, today, score)
    .catch((err) => console.error(`[job] site ${site.id} health score snapshot failed:`, err.message));
  const weekAgoDate = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const weekAgoScore = await getHealthScoreOnOrBefore(site.id, weekAgoDate);
  const trendWeek = weekAgoScore != null ? score - weekAgoScore : null;

  const events = await detectNotificationEvents(site.id, { trendWeek });
  await deliverToAllChannels(site.id, events);

  const recommendations = await buildRecommendations(site.id);
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
export async function listConnectedSites() {
  const sites = await listSites();
  return sites.filter((s) => s.gsc_property && s.ga4_property_id);
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

// Run the executive-report-if-due check independently for every connected
// site. A failure for one site is logged and does not stop the others.
// Weekly, same cadence/idempotency pattern as runExecutiveIfDue above, but
// its own marker: getCompetitorRankingDates (real persisted check dates)
// instead of a sites column, since competitor_rankings already records when
// it last ran. Silently no-ops if DataForSEO isn't configured — the
// competitor-intelligence agent already reports "insufficient-data" plainly
// in that case, so there's nothing to force here.
export async function runCompetitorCheckIfDue(site) {
  if (!process.env.DATAFORSEO_LOGIN || !process.env.DATAFORSEO_PASSWORD) return null;

  const { start, end } = previousWeek(site.timezone);
  const [latestDate] = await getCompetitorRankingDates(site.id, 1);
  if (latestDate && latestDate >= start) {
    console.log(`[competitors] site ${site.id} week of ${start} already checked — skipping.`);
    return null;
  }

  const checkDate = daysAgoInTz(site.timezone, 0);
  const rows = await fetchCompetitorRankings(site, checkDate, { start, end });
  await saveCompetitorRankings(site.id, rows);
  console.log(`[competitors] site ${site.id}: checked ${rows.length} ranking row(s) for week of ${start}.`);
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
      await noteGoogleAuthOutcome(true);
    } catch (err) {
      console.error(`[job] hourly guard failed for site ${site.id} "${site.name}":`, err.message);
      await noteGoogleAuthOutcome(false, err);
    }
  }
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
      await noteGoogleAuthOutcome(true);
    } catch (err) {
      console.error(`[catchup] error for site ${site.id} "${site.name}":`, err.message);
      await noteGoogleAuthOutcome(false, err);
    }
  }
  console.log('[catchup] done.');
}
