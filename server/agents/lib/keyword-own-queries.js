// KEYWORD DISCOVERY FROM A PROJECT'S OWN SEARCH DATA. The paid path (keyword-demand.js: a model reads the homepage, DataForSEO prices the
// phrases) and the analyst service both need something that can be switched off (model credit, DataForSEO credit, a connection token). This
// path needs none of them: it reads the project's own Search Console rows (gsc_query_page) and picks the queries where the site is already
// being shown but is not yet at the top: real impressions, a real average position, the page that was shown.
//
//   - Every number saved is a measured Search Console number. NO search-volume figure is ever attached (search_volume stays NULL): a person
//     reading keyword_gaps can always tell these from DataForSEO's measured demand.
//   - Strictly one project: every query below is scoped by site_id, and the brand/existing-keyword filters use only that project's own data.
//   - It only saves candidates. Relevance and coverage are decided afterwards by the normal weekly classification, so a candidate that does
//     not fit the business is never shipped just because people searched for it.
import { query } from '../../db.js';
import { saveKeywordGaps } from '../../store/data-analyst.js';
import { recordDiscoveryStatus } from '../../store/keyword-discovery-status.js';

export const OWN_WINDOW_DAYS = 90;
export const MIN_IMPRESSIONS = 10;   // fewer is noise, not evidence
export const POSITION_FROM = 4;      // already in the top 3: nothing to gain
export const POSITION_TO = 40;       // beyond page 4: not a realistic target yet
export const MAX_NEW_PER_RUN = 20;
const MAX_WORDS = 9;

const norm = (s) => String(s || '').toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
const words = (s) => norm(s).split(' ').filter(Boolean);

/** Pure. Words that mean "this is a search for our own brand", from the project's own name and domain. */
export function brandTokens({ name, domain }) {
  const t = new Set(words(name).filter((w) => w.length >= 3));
  const label = String(domain || '').toLowerCase().replace(/^www\./, '').split('.')[0];
  if (label.length >= 3) t.add(label);
  const joined = words(name).join('');                       // "Super Rank" is also searched as "superrank" / "super rank"
  if (joined.length >= 5) t.add(joined);
  return t;
}

export function priorityFor({ impressions, position }) {
  if (impressions >= 100 && position <= 15) return 'high';
  if (impressions >= 30) return 'medium';
  return 'low';
}

/**
 * Pure. Picks the candidates from one project's aggregated Search Console rows.
 * rows: [{ query, impressions, clicks, position, page }] (position already impression-weighted).
 * existing: Set of normalised topics this project already holds in keyword_gaps (any status).
 */
export function pickOwnQueryKeywords(rows, { brand = new Set(), existing = new Set(), max = MAX_NEW_PER_RUN } = {}) {
  const seen = new Set();
  const out = [];
  const ranked = [...rows].sort((a, b) => Number(b.impressions) - Number(a.impressions) || String(a.query).localeCompare(String(b.query)));
  for (const r of ranked) {
    const key = norm(r.query);
    const w = words(r.query);
    const impressions = Number(r.impressions); const position = Number(r.position);
    if (!key || w.length < 2 || w.length > MAX_WORDS) continue;
    if (!Number.isFinite(impressions) || impressions < MIN_IMPRESSIONS) continue;
    if (!Number.isFinite(position) || position < POSITION_FROM || position > POSITION_TO) continue;
    const spaceless = w.join('');
    if (w.some((x) => brand.has(x)) || [...brand].some((b) => b.length >= 5 && spaceless.includes(b))) continue; // our own name: not a topic to publish
    if (existing.has(key)) continue;                            // already in this project's list
    const signature = [...new Set(w)].sort().join(' ');         // "ai seo tool" and "tool seo ai" are one search
    if (seen.has(signature)) continue;
    seen.add(signature);
    out.push({
      topic: String(r.query).trim(),
      reason: `Your own Search Console data: shown ${impressions} time(s) in the last ${OWN_WINDOW_DAYS} days at an average position of ${position.toFixed(1)}` +
        `${Number(r.clicks) > 0 ? ` with ${Number(r.clicks)} click(s)` : ' with no clicks'}${r.page ? `, on ${r.page}` : ''}. ` +
        'No search-volume figure is attached: it is measured visibility, not market demand.',
      priority: priorityFor({ impressions, position }),
      _position: Number(position.toFixed(2)),
    });
    if (out.length >= max) break;
  }
  return out;
}

/**
 * One project. Reads its own Search Console rows, saves new candidates, records what happened and why in keyword_discovery_status.
 * Never throws for a data problem: the outcome is the status row. deps are injectable for tests.
 */
export async function discoverKeywordsFromOwnQueries(site, { now = new Date(), deps = {} } = {}) {
  const run = deps.query || query;
  const save = deps.saveKeywordGaps || saveKeywordGaps;
  const record = deps.recordDiscoveryStatus || recordDiscoveryStatus;
  const since = new Date(now.getTime() - OWN_WINDOW_DAYS * 86400000).toISOString().slice(0, 10);
  const label = `${site.name || 'this project'}`;

  const { rows } = await run(
    `WITH q AS (
       SELECT query, SUM(impressions)::int AS impressions, SUM(clicks)::int AS clicks,
              CASE WHEN SUM(impressions) > 0 THEN SUM(position * impressions) / SUM(impressions) END AS position
         FROM gsc_query_page WHERE site_id = $1 AND date >= $2::date GROUP BY query HAVING SUM(impressions) >= $3),
     p AS (
       SELECT DISTINCT ON (query) query, page FROM (
         SELECT query, page, SUM(impressions) AS imp FROM gsc_query_page WHERE site_id = $1 AND date >= $2::date GROUP BY query, page) x
        ORDER BY query, imp DESC)
     SELECT q.query, q.impressions, q.clicks, q.position, p.page FROM q JOIN p USING (query)`,
    [site.id, since, MIN_IMPRESSIONS]);

  if (!rows.length) {
    await record(site.id, 'own_search_queries', {
      status: 'skipped', code: 'no_search_data',
      message: `${label}: Search Console has no queries with ${MIN_IMPRESSIONS}+ impressions in the last ${OWN_WINDOW_DAYS} days, so there is nothing to base keywords on yet. Check that the Search Console property is connected and the site is indexed.`,
    });
    return { site: site.id, saved: 0, status: 'skipped', code: 'no_search_data' };
  }

  const { rows: have } = await run(`SELECT topic FROM keyword_gaps WHERE site_id = $1`, [site.id]);
  const domain = site.website_domain || null;
  const picked = pickOwnQueryKeywords(rows, { brand: brandTokens({ name: site.name, domain }), existing: new Set(have.map((r) => norm(r.topic))) });

  if (!picked.length) {
    await record(site.id, 'own_search_queries', {
      status: 'nothing_new', code: 'no_new_candidates', details: { queriesSeen: rows.length },
      message: `${label}: ${rows.length} search quer${rows.length === 1 ? 'y' : 'ies'} checked; none is both new and in reach (average position ${POSITION_FROM}-${POSITION_TO}, ${MIN_IMPRESSIONS}+ impressions, not a brand search). This is a normal result, not a fault.`,
    });
    return { site: site.id, saved: 0, status: 'nothing_new', code: 'no_new_candidates' };
  }

  await save(site.id, picked.map(({ _position, ...g }) => g), 'gsc_own_queries');
  if (!deps.query) {
    for (const g of picked) await run(`UPDATE keyword_gaps SET our_position = $3 WHERE site_id = $1 AND topic = $2 AND source = 'gsc_own_queries'`, [site.id, g.topic, g._position]);
  }
  await record(site.id, 'own_search_queries', {
    status: 'ok', keywords: picked.length, details: { queriesSeen: rows.length },
    message: `${label}: saved ${picked.length} keyword(s) from its own Search Console queries. They are classified for relevance and coverage in the weekly review before anything is written.`,
  });
  return { site: site.id, saved: picked.length, status: 'ok' };
}
