import { getOrCreateSite, query } from './db.js';
import { fetchGscForDate } from './ingest/gsc.js';
import { fetchGa4ForDate } from './ingest/ga4.js';
import { upsertGsc, upsertGa4, saveNarrative } from './store/upsert.js';
import { getDay, getNarrative } from './store/read.js';
import { generateNarrative } from './report/narrative.js';
import { sendDailyEmail } from './report/email.js';
import { runWeeklyDocReport } from './report/weekly-doc.js';
import { daysAgoInTz, dateRange, previousWeek } from './util/dates.js';

// GSC finalizes with a lag; GA4 is near real-time.
const GSC_LAG_DAYS = 3;   // freshest fully-final GSC date = today - 3
const GSC_BACKFILL = 3;   // also re-fetch the prior 3 days to catch late finalization
const GA4_FRESH_DAYS = 0; // ingest GA4 up to TODAY (partial, live) for freshness

// Ingest one explicit date for both sources (used by the manual CLI).
export async function ingestDate(site, date) {
  const gsc = await fetchGscForDate(site.gsc_property, date);
  await upsertGsc(site.id, gsc);
  const ga4 = await fetchGa4ForDate(site.ga4_property_id, date);
  await upsertGa4(site.id, ga4);
  return { date, gsc: gsc.totals, ga4: ga4.totals };
}

// Ingest the standard daily window. Both sources are ingested across the same
// window (gscStart .. yesterday) so every recent day has aligned GSC + GA4 data.
// The "report date" is the freshest day that has FINAL GSC data (today - 3).
export async function runDailyIngest() {
  const site = await getOrCreateSite();
  const tz = site.timezone;

  const gscEnd = daysAgoInTz(tz, GSC_LAG_DAYS);                 // report date
  const gscStart = daysAgoInTz(tz, GSC_LAG_DAYS + GSC_BACKFILL);
  const ga4End = daysAgoInTz(tz, GA4_FRESH_DAYS);              // yesterday

  // GSC: backfill window up to today-3 (final data only).
  for (const date of dateRange(gscStart, gscEnd)) {
    const gsc = await fetchGscForDate(site.gsc_property, date);
    await upsertGsc(site.id, gsc);
    console.log(`[GSC] ${date}: ${gsc.totals.clicks} clicks, ${gsc.totals.impressions} impressions`);
  }

  // GA4: same start, but extend through yesterday for freshness.
  for (const date of dateRange(gscStart, ga4End)) {
    const ga4 = await fetchGa4ForDate(site.ga4_property_id, date);
    await upsertGa4(site.id, ga4);
    console.log(`[GA4] ${date}: ${ga4.totals.users} users, ${ga4.totals.sessions} sessions`);
  }

  return { site, reportDate: gscEnd };
}

// Full daily pipeline: ingest → AI narrative → email. Idempotent and safe to re-run.
export async function runDailyJob() {
  const { site, reportDate } = await runDailyIngest();

  let narrative = '';
  try {
    narrative = await generateNarrative(site, reportDate);
    await saveNarrative(site.id, reportDate, narrative);
    console.log(`[report] narrative saved for ${reportDate}`);
  } catch (err) {
    console.error('[report] narrative failed:', err.message);
  }

  try {
    // Email idempotency: only send once per report date, even across restarts/catch-ups.
    const existing = await getNarrative(site.id, reportDate);
    if (existing?.emailed_at) {
      console.log(`[report] email already sent for ${reportDate} — skipping.`);
    } else {
      const day = await getDay(site.id, reportDate);
      const sent = await sendDailyEmail(site, reportDate, day, narrative);
      if (sent) await saveNarrative(site.id, reportDate, narrative, new Date().toISOString());
    }
  } catch (err) {
    console.error('[report] email failed:', err.message);
  }

  return { site, reportDate, narrative };
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
    console.log(`[weekly] week of ${start} already written — skipping.`);
    return null;
  }
  const r = await runWeeklyDocReport(site); // no anchor → previous full week
  await query('UPDATE sites SET weekly_last_done = $1 WHERE id = $2', [start, site.id]);
  console.log(`[weekly] week of ${start} written; marker updated.`);
  return r;
}

// One-shot catch-up run on server boot: ingest recent days (backfills anything
// missed while the Mac was off/asleep) and write the weekly doc if it's due.
// Guarded by DISABLE_CATCHUP. Errors are logged, never crash the server.
export async function runStartupCatchup() {
  if (process.env.DISABLE_CATCHUP === 'true') {
    console.log('[catchup] disabled via DISABLE_CATCHUP.');
    return;
  }
  try {
    console.log('[catchup] running daily job on startup…');
    const { site } = await runDailyJob();
    await runWeeklyIfDue(site);
    console.log('[catchup] done.');
  } catch (err) {
    console.error('[catchup] error:', err.message);
  }
}
