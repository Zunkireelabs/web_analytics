import { normalizePageKey } from './protected-pages.js';
import { riskTierForGenerator } from './risk-tiers.js';

// Pages Google never shows: listed on the site (page_inventory, from its sitemap and crawl) for a while, yet with no
// Search Console impressions at all over the last LOOKBACK_DAYS. Search Console only reports pages that WERE shown
// (gsc-url-audit.js says so), so these are invisible to every other check; this one finds them by difference.
//
// The fix it queues is the safe, additive one: a link TO the page from a related page that already earns clicks
// (generators/internal-links.js with mustLinkTo). Google finds and values pages through links; an orphaned page (no
// internal link reaches it, page_inventory.orphaned) gets one first. It ships through the ordinary auto-fix rails
// (safe tier, daily budget, a person merges the PR). Internal links are not a protected change, so this never touches a
// page's own title or content.
//
// Limits: at most MAX_PER_SITE_PER_DAY new pages per project per day, and the same page is not queued again for
// REQUEUE_DAYS, so a page that stays invisible does not pile up links.

export const LOOKBACK_DAYS = 90;
export const MIN_AGE_DAYS = 30;          // a page younger than this may simply not be indexed yet
export const MIN_SITE_IMPRESSIONS = 100; // without real Search Console data, "no impressions" means nothing
export const MAX_PER_SITE_PER_DAY = 3;
export const REQUEUE_DAYS = 30;
export const AGENT_ID = 'zero-impression-pages';

// Pages that are not meant to be found in search: legal, account, cart, listing/pagination, feeds, files.
const NOT_FOR_SEARCH = /\/(privacy|terms|cookie|cookies|legal|login|log-in|signin|sign-in|signup|sign-up|register|account|my-account|cart|basket|checkout|search|thank-you|thanks|404|wp-admin|wp-login|feed|rss|tag|tags|author|page\/\d+)(\/|$)|\.(xml|pdf|jpg|jpeg|png|gif|webp|svg|txt|json)$/i;

const pathOf = (url) => { try { return new URL(url).pathname; } catch { return String(url || ''); } };
const segments = (url) => pathOf(url).split('/').filter(Boolean);

/**
 * Pure. inventory: [{ page, firstSeenAt, orphaned }]; gscPages: [{ page, impressions, clicks }] over the lookback window.
 * Returns the invisible pages, orphaned first, then shallowest path first (a top-level page matters more than a deep one).
 */
export function findZeroImpressionPages({ inventory, gscPages, now = new Date() }) {
  const seen = new Set(gscPages.filter((p) => Number(p.impressions) > 0).map((p) => normalizePageKey(p.page)));
  const cutoff = now.getTime() - MIN_AGE_DAYS * 86400000;
  const out = []; const keys = new Set();
  for (const p of inventory) {
    const key = normalizePageKey(p.page);
    if (!key || keys.has(key) || seen.has(key)) continue;
    if (NOT_FOR_SEARCH.test(pathOf(p.page))) continue;
    if (p.firstSeenAt && new Date(p.firstSeenAt).getTime() > cutoff) continue;
    keys.add(key);
    out.push({ page: p.page, key, orphaned: !!p.orphaned, depth: segments(p.page).length });
  }
  return out.sort((a, b) => Number(b.orphaned) - Number(a.orphaned) || a.depth - b.depth || a.page.localeCompare(b.page));
}

/**
 * Pure. The page that should link to `target`: among pages that earn clicks, the one sharing the longest leading path
 * with it (a /blog/ post links to a /blog/ post), most clicks breaking ties. Never the target itself, never a page in
 * `busy` (one that already has an open link fix: a page carries one open internal-links recommendation at a time). Null if none.
 */
export function pickLinkSource(target, sources, busy = new Set()) {
  const t = segments(target); const tKey = normalizePageKey(target);
  let best = null;
  for (const s of sources) {
    if (!(Number(s.clicks) > 0) || normalizePageKey(s.page) === tKey || busy.has(s.page)) continue;
    const ss = segments(s.page);
    let shared = 0; while (shared < Math.min(t.length - 1, ss.length) && t[shared] === ss[shared]) shared++;
    if (!best || shared > best.shared || (shared === best.shared && Number(s.clicks) > Number(best.clicks))) best = { ...s, shared };
  }
  return best ? best.page : null;
}

/** Daily, per project (job.js, with the growth sync). Writes at most MAX_PER_SITE_PER_DAY recommendations. */
export async function syncZeroImpressionPages(siteId, { now = new Date() } = {}) {
  const { query } = await import('../../db.js');
  const { insertRecommendation } = await import('../../store/recommendations.js');
  const since = new Date(now.getTime() - LOOKBACK_DAYS * 86400000).toISOString().slice(0, 10);

  const [{ rows: gscPages }, { rows: inventory }] = await Promise.all([
    query(`SELECT page, SUM(impressions)::int AS impressions, SUM(clicks)::int AS clicks
             FROM gsc_query_page WHERE site_id = $1 AND date >= $2 GROUP BY page`, [siteId, since]),
    query(`SELECT page, first_seen_at AS "firstSeenAt", orphaned FROM page_inventory WHERE site_id = $1`, [siteId]),
  ]);
  const siteImpressions = gscPages.reduce((n, p) => n + Number(p.impressions || 0), 0);
  if (siteImpressions < MIN_SITE_IMPRESSIONS) return { created: 0, invisible: 0, reason: 'not enough Search Console data' };

  const invisible = findZeroImpressionPages({ inventory, gscPages, now });
  const sources = [...gscPages].sort((a, b) => b.clicks - a.clicks).slice(0, 50);
  const { rows: open } = await query(
    `SELECT page FROM recommendations WHERE site_id = $1 AND recommendation_type = 'internal-links' AND status = 'open'`, [siteId]);
  const busy = new Set(open.map((r) => r.page));
  let created = 0;
  for (const p of invisible) {
    if (created >= MAX_PER_SITE_PER_DAY) break;
    const findingId = `${AGENT_ID}:${p.key}`;
    const { rows: recent } = await query(
      `SELECT 1 FROM recommendations WHERE site_id = $1 AND $2 = ANY(finding_ids) AND created_at > now() - ($3 || ' days')::interval LIMIT 1`,
      [siteId, findingId, String(REQUEUE_DAYS)]);
    if (recent.length) continue;
    const source = pickLinkSource(p.page, sources, busy);
    if (!source) continue;
    busy.add(source);
    await insertRecommendation(siteId, {
      page: source,
      recommendationType: 'internal-links',
      issue: `Google has not shown ${pathOf(p.page)} in search for ${LOOKBACK_DAYS} days`,
      reason: `${pathOf(p.page)} is on the site but had no search impressions in the last ${LOOKBACK_DAYS} days${p.orphaned ? ', and no page on the site links to it' : ''}. A link from ${pathOf(source)}, which already earns clicks, helps Google find and rank it.`,
      params: { page: source, mustLinkTo: p.page, measurePage: p.page },
      findingId,
      detectingAgent: AGENT_ID,
      priority: p.orphaned ? 'high' : 'medium',
      riskTier: riskTierForGenerator('internal-links'),
    });
    created++;
  }
  return { created, invisible: invisible.length };
}
