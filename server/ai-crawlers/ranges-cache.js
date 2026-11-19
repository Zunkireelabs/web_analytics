import { LIST_URLS, loadRangeLists, compileRanges } from './verify.js';
import { loadIpListCache, saveIpListResult } from '../store/ai-crawlers.js';

// The vendors' IP lists, kept in the database (ai_crawler_ip_lists) and refreshed at most once a day, so an upload never has to
// wait for nine vendor websites. Rules that keep verification honest:
//   - a list is refreshed when it has no good copy, or its copy is older than MAX_AGE;
//   - a failed refresh KEEPS the last good copy (a vendor outage must not turn real crawlers into "unverified"), and a list that
//     has never loaded is simply "unchecked" (verify.js);
//   - after a failed attempt a list is not retried for RETRY_AFTER, so a vendor that is down is not hammered by every upload.

export const MAX_AGE_MS = 24 * 3600 * 1000;
export const RETRY_AFTER_MS = 30 * 60 * 1000;
const MEMO_MS = 10 * 60 * 1000; // within one process, reuse the compiled lists this long without touching the database

let memo = null;
export const forgetRangesMemo = () => { memo = null; };

const ms = (d) => (d ? new Date(d).getTime() : null);

/** Which lists need a fetch now. Pure. */
export function staleListIds(cacheRows, now, urls = LIST_URLS) {
  const byId = new Map(cacheRows.map((r) => [r.list_id, r]));
  const stale = [];
  for (const id of Object.keys(urls)) {
    const row = byId.get(id);
    const lastGood = ms(row?.fetched_at);
    const lastTry = ms(row?.last_attempt_at);
    const needs = lastGood === null || now - lastGood > MAX_AGE_MS;
    // A "last tried" time in the FUTURE (clock skew, a restored backup) must not block retries until the clock catches up.
    const sinceTry = lastTry === null ? null : now - lastTry;
    const recentlyTried = sinceTry !== null && sinceTry >= 0 && sinceTry < RETRY_AFTER_MS && (row?.last_error || lastGood === null);
    if (needs && !recentlyTried) stale.push(id);
  }
  return stale;
}

/** Compiled ranges ready for aggregateLines(). Never throws: a total failure just means every visit is "unchecked". */
export async function getRanges({ now = Date.now(), fetchImpl = fetch, urls = LIST_URLS, useMemo = true } = {}) {
  if (useMemo && memo && now - memo.at < MEMO_MS) return memo.ranges;
  let rows = [];
  try { rows = await loadIpListCache(); } catch (err) { console.warn('[ai-crawlers] could not read the IP list cache:', err.message); }

  const stale = staleListIds(rows, now, urls);
  if (stale.length) {
    const wanted = Object.fromEntries(stale.map((id) => [id, urls[id]]));
    const fetched = await loadRangeLists({ fetchImpl, urls: wanted });
    for (const [id, result] of Object.entries(fetched)) {
      await saveIpListResult(id, result, new Date(now)).catch((err) => console.warn(`[ai-crawlers] could not save list ${id}:`, err.message));
    }
    try { rows = await loadIpListCache(); } catch { /* keep what we have */ }
  }

  const lists = {};
  for (const r of rows) if (Array.isArray(r.cidrs) && r.cidrs.length) lists[r.list_id] = { ok: true, cidrs: r.cidrs, creationTime: r.creation_time };
  const ranges = compileRanges(lists);
  if (useMemo) memo = { at: now, ranges };
  return ranges;
}
