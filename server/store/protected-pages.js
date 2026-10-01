import { query } from '../db.js';
import { computeProtectedPages } from '../agents/lib/protected-pages.js';

// { pages: Set, unknown: boolean }. `unknown` means the lookup failed: the
// guard then fails CLOSED for the protected generators (a hiccup must never
// be the reason a title change on a top page ships unreviewed), and open for
// everything else. A site with no GSC data gets an empty set — nothing is
// known to be worth protecting, so nothing is.
const CACHE_TTL_MS = 10 * 60 * 1000;
const cache = new Map(); // siteId -> { at, value }
export function clearProtectedPagesCache() { cache.clear(); }

export async function getProtectedPageSet(siteId, { now = Date.now(), run = query } = {}) {
  const hit = cache.get(siteId);
  if (hit && now - hit.at < CACHE_TTL_MS) return hit.value;
  let value;
  try {
    const { rows } = await run(
      `WITH m AS (SELECT MAX(date) d FROM gsc_breakdown WHERE site_id = $1 AND dim_type = 'page')
       SELECT dim_value AS page, SUM(clicks)::int AS clicks, SUM(impressions)::int AS impressions,
              SUM(position * impressions) AS "positionSum"
         FROM gsc_breakdown, m
        WHERE site_id = $1 AND dim_type = 'page' AND date > m.d - 28
        GROUP BY dim_value`,
      [siteId],
    );
    value = { pages: computeProtectedPages(rows), unknown: false };
  } catch (err) {
    console.error(`[protected-pages] lookup failed for site ${siteId}, failing closed for protected generators:`, err.message);
    value = { pages: new Set(), unknown: true };
  }
  cache.set(siteId, { at: now, value });
  return value;
}

