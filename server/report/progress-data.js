import { pool } from '../db.js';
import { getBaselineReport } from '../store/baseline-reports.js';
import { buildWorkItems, tallyWork } from './work-catalogue.js';
import { deriveBrandTheme, accentFromSite } from './brand-theme.js';
import {
  longDate, weeklyBuckets, matchingSearches, previousSiteShare, compareChecks, businessDetails,
  extractJsonLd, describeListing, checkListing, countSitemapUrls, buildHeadline,
} from './progress-helpers.js';

const isoDay = (d) => new Date(d).toISOString().slice(0, 10);

// Builds the numbers behind the standard monthly client progress report
// (report/progress-pdf.js renders it). Everything here is READ-ONLY: SELECTs
// against the site's own tables, plus public fetches of the client's own
// website. Anything that cannot be measured comes back null and the report says
// "not measured yet" instead of inventing a figure.

// ---- the database loader (read-only) ---------------------------------------

export async function buildProgressReportData(siteId, { now = new Date(), fetchImpl = fetch, manualItems = [] } = {}) {
  const { rows: [site] } = await pool.query('SELECT * FROM sites WHERE id = $1', [siteId]);
  if (!site) throw new Error(`site ${siteId} not found`);
  const baseline = await getBaselineReport(siteId);
  const theme = deriveBrandTheme(accentFromSite(site));

  const [aiRun, gsc, pagesQ, queriesQ, draftsQ, recsQ, audit] = await Promise.all([
    pool.query(`SELECT facts->'siteScore' AS score FROM agent_runs WHERE site_id=$1 AND agent_id='ai-visibility' AND facts->'siteScore' IS NOT NULL ORDER BY created_at DESC LIMIT 1`, [siteId]),
    pool.query('SELECT date, clicks, impressions FROM gsc_daily WHERE site_id=$1 ORDER BY date', [siteId]),
    pool.query(`SELECT dim_value AS page, SUM(impressions)::int AS impressions, SUM(clicks)::int AS clicks FROM gsc_breakdown WHERE site_id=$1 AND dim_type='page' GROUP BY dim_value ORDER BY 2 DESC LIMIT 500`, [siteId]),
    pool.query(`SELECT dim_value AS query, SUM(impressions)::int AS impressions, SUM(clicks)::int AS clicks, (SUM(position*impressions)/NULLIF(SUM(impressions),0))::float AS position FROM gsc_breakdown WHERE site_id=$1 AND dim_type='query' GROUP BY dim_value ORDER BY 2 DESC LIMIT 500`, [siteId]),
    pool.query(`SELECT action_type, status FROM drafts WHERE site_id=$1 AND (status <> 'implemented' OR implemented_at >= $2)`, [siteId, baseline?.generated_at || '1970-01-01']),
    pool.query(`SELECT recommendation_type, priority FROM recommendations WHERE site_id=$1 AND status='open' AND priority IN ('high','medium')`, [siteId]),
    pool.query(`SELECT pages_discovered FROM audit_runs WHERE site_id=$1 AND status='completed' ORDER BY created_at ASC LIMIT 1`, [siteId]),
  ]);

  const baseAi = baseline?.issues_snapshot?.aiVisibility;
  const nowScore = aiRun.rows[0]?.score;
  const ai = baseAi?.available && nowScore ? { base: baseAi.overall, now: nowScore.overall } : null;

  const dailyRows = gsc.rows;
  const google = dailyRows.length ? {
    impressions: dailyRows.reduce((a, r) => a + Number(r.impressions || 0), 0),
    clicks: dailyRows.reduce((a, r) => a + Number(r.clicks || 0), 0),
    lastDay: isoDay(dailyRows[dailyRows.length - 1].date),
  } : null;

  const doneByType = {};
  for (const d of draftsQ.rows) if (d.status === 'implemented') doneByType[d.action_type] = (doneByType[d.action_type] || 0) + 1;
  const checks = ai ? compareChecks(baseAi.categories, nowScore.categories, doneByType) : [];

  const work = buildWorkItems({ drafts: draftsQ.rows, openRecs: recsQ.rows, manual: manualItems });

  // The client's own website: pages, listings, business details.
  const home = site.website_domain;
  let pages = null; let listings = []; let nap = null;
  if (home) {
    try { pages = { base: audit.rows[0]?.pages_discovered ?? null, now: await countSitemapUrls(new URL('/sitemap.xml', home).toString(), fetchImpl) }; } catch { /* leave null */ }
    try {
      const html = await (await fetchImpl(home, { signal: AbortSignal.timeout(15000) })).text();
      nap = businessDetails(extractJsonLd(html));
      if (nap?.sameAs?.length) listings = await Promise.all(nap.sameAs.map((u) => checkListing(describeListing(u), nap.name, fetchImpl)));
    } catch { /* leave empty */ }
  }

  return {
    siteName: site.name,
    dateLabel: longDate(now),
    dataThrough: google ? longDate(google.lastDay) : null,
    theme,
    ai, pages, google,
    weekly: weeklyBuckets(dailyRows),
    searches: matchingSearches(queriesQ.rows),
    previousSite: previousSiteShare({ pageRows: pagesQ.rows, queryRows: queriesQ.rows }),
    checks, work, tally: tallyWork(work), listings, nap,
    headline: buildHeadline({ ai, pages }),
  };
}
