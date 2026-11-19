import { operatorDetail } from '../lib/errors.js';
// Keeps gsc_screen_daily (migration 253) equal to what Search Console's own screen shows, so the Overview matches it.
// Fresh days move until Google finalises them, so the last REFRESH_DAYS are re-read on every run (every few hours); the first
// run for a project reads its whole available history (Search Console keeps 16 months) in the same single call.

export const REFRESH_DAYS = 7;
export const HISTORY_DAYS = 480;

const MS_DAY = 86400000;
const ymd = (d) => d.toISOString().slice(0, 10);

/** Pure. The date window to read: whole history the first time, the recent days afterwards. */
export function screenWindow({ hasRows, now = new Date() }) {
  const end = ymd(now);
  const back = hasRows ? REFRESH_DAYS : HISTORY_DAYS;
  return { start: ymd(new Date(now.getTime() - back * MS_DAY)), end };
}

/** One project. Never throws: a failure is returned so one project's Google trouble cannot stop the others. */
export async function refreshScreenDaysForSite(site, { now = new Date(), deps = {} } = {}) {
  try {
    const query = deps.query || (await import('../db.js')).query;
    const fetchDays = deps.fetchDays || (await import('./gsc.js')).fetchGscScreenDays;
    const upsert = deps.upsert || (await import('../store/upsert.js')).upsertGscScreenDays;
    const { rows } = await query('SELECT 1 FROM gsc_screen_daily WHERE site_id = $1 LIMIT 1', [site.id]);
    const { start, end } = screenWindow({ hasRows: rows.length > 0, now });
    const days = await fetchDays(site, start, end);
    await upsert(site.id, days);
    return { siteId: site.id, ok: true, days: days.length, start, end };
  } catch (err) {
    return { siteId: site.id, ok: false, error: operatorDetail(err, 300) };
  }
}
