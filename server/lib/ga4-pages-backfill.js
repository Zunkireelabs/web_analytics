import { fetchGa4PagesForDate } from '../ingest/ga4.js';
import { replaceGa4PagesForDay, recordPagesQuality, listDaysMissingPages, shiftYmd } from '../store/ga4-pages.js';

// Fills in the Overview's "Top pages" history for a project that has Google Analytics data but no page lists yet.
//
// The daily ingest only re-fetches the last week, so without this a project would show a "Top pages" card built from
// seven days until a month had passed, and its "vs previous" column would be empty for another month after that.
// Page titles for past days still exist in the client's GA4, so the missing days are fetched once.
//
// It only fetches days that HAD traffic and have no list (a zero-traffic day has nothing to list, and re-asking for it
// every night would be wasted calls), capped per run, one cheap page-title query per day. Once everything is filled
// it does one indexed query and stops. Never throws into the caller: it rides on the daily ingest, which it must not
// be able to break; every outcome is returned and logged instead.

const DEFAULT_DAYS = 35;
const MAX_DAYS = 90;
const MAX_FETCHES_PER_RUN = 40;

export async function backfillGa4Pages(site, { days = DEFAULT_DAYS, now = new Date(), deps = {} } = {}) {
  const fetchPages = deps.fetchGa4PagesForDate || fetchGa4PagesForDate;
  const replace = deps.replaceGa4PagesForDay || replaceGa4PagesForDay;
  const record = deps.recordPagesQuality || recordPagesQuality;
  const listMissing = deps.listDaysMissingPages || listDaysMissingPages;

  const span = Math.min(Math.max(Number(days) || DEFAULT_DAYS, 1), MAX_DAYS);
  const end = shiftYmd(now.toISOString().slice(0, 10), -1); // yesterday: today is partial and is re-fetched by the daily run
  const start = shiftYmd(end, -(span - 1));
  const out = { ok: true, fetched: 0, failed: 0, from: start, to: end };
  try {
    if (!site?.ga4_property_id) return { ...out, ok: false, reason: 'no_ga4_property' };
    const missing = await listMissing(site.id, start, end, MAX_FETCHES_PER_RUN);
    for (const date of missing) {
      try {
        const p = await fetchPages(site, date);
        await replace(site.id, date, p.pages);
        await record(site.id, date, p.quality);
        out.fetched += 1;
      } catch (err) {
        out.failed += 1;
        console.warn(`[ga4-pages-backfill] site ${site.id} ${date}: ${err.message}`);
      }
    }
    if (out.fetched || out.failed) console.log(`[ga4-pages-backfill] site ${site.id}: ${out.fetched} day(s) filled, ${out.failed} failed`);
    return out;
  } catch (err) {
    console.error(`[ga4-pages-backfill] site ${site?.id}:`, err.message);
    return { ...out, ok: false, reason: 'error', detail: err.message };
  }
}
