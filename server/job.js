import { getOrCreateSite, query } from './db.js';
import { fetchGscForDate } from './ingest/gsc.js';
import { fetchGa4ForDate } from './ingest/ga4.js';
import { upsertGsc, upsertGa4, saveNarrative, markDailyDocDone } from './store/upsert.js';
import { getDay, getNarrative, listSites } from './store/read.js';
import { generateNarrative } from './report/narrative.js';
import { sendDailyEmail } from './report/email.js';
import { runWeeklyDocReport } from './report/weekly-doc.js';
import { runDailyDocReport } from './report/daily-doc.js';
import { runExecutiveDocReport } from './report/executive-doc.js';
import { daysAgoInTz, dateRange, previousWeek } from './util/dates.js';

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

// Full daily pipeline for one already-resolved site: ingest → AI narrative →
// email → daily doc. Idempotent and safe to re-run — identical logic to the
// original single-site runDailyJob(), just parameterized by `site`.
export async function runDailyJobForSite(site) {
  const { reportDate } = await runDailyIngestForSite(site);

  let narrative = '';
  try {
    narrative = await generateNarrative(site, reportDate);
    await saveNarrative(site.id, reportDate, narrative);
    console.log(`[report] site ${site.id} narrative saved for ${reportDate}`);
  } catch (err) {
    console.error(`[report] site ${site.id} narrative failed:`, err.message);
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
  }

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
    } catch (err) {
      console.error(`[job] daily job failed for site ${site.id} "${site.name}":`, err.message);
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
    } catch (err) {
      console.error(`[job] weekly doc failed for site ${site.id} "${site.name}":`, err.message);
    }
  }
  return results;
}

// Run the executive-report-if-due check independently for every connected
// site. A failure for one site is logged and does not stop the others.
export async function runExecutiveIfDueForAllSites() {
  const sites = await listConnectedSites();
  const results = [];
  for (const site of sites) {
    try {
      results.push(await runExecutiveIfDue(site));
    } catch (err) {
      console.error(`[job] executive report failed for site ${site.id} "${site.name}":`, err.message);
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
    } catch (err) {
      console.error(`[job] hourly guard failed for site ${site.id} "${site.name}":`, err.message);
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
    } catch (err) {
      console.error(`[catchup] error for site ${site.id} "${site.name}":`, err.message);
    }
  }
  console.log('[catchup] done.');
}
