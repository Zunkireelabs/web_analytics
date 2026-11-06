import { BetaAnalyticsDataClient } from '@google-analytics/data';
import { getGa4ClientOptionsAsync } from '../auth/google.js';

// One cached client per distinct credential set, keyed by site id — a single
// shared singleton would silently reuse the wrong client's credentials for
// other sites once any site has its own dedicated Google credentials file.
const clients = new Map();
// A project that connects (or disconnects) its own Google account changes which credential
// this must use, so the cached client is dropped by forgetGa4Client below.
const GA4_TIMEOUT_MS = Number(process.env.GOOGLE_API_TIMEOUT_MS) || 60_000;
async function ga4(site) {
  const key = site?.id ?? '__shared__';
  if (!clients.has(key)) {
    const client = new BetaAnalyticsDataClient(await getGa4ClientOptionsAsync(site));
    // Analytics Data calls go through gRPC, not googleapis, so they need their own time limit.
    const run = client.runReport.bind(client);
    client.runReport = (request, options, callback) => (typeof options === 'function'
      ? run(request, { timeout: GA4_TIMEOUT_MS }, options)
      : run(request, { timeout: GA4_TIMEOUT_MS, ...(options || {}) }, callback));
    clients.set(key, client);
  }
  return clients.get(key);
}
export function forgetGa4Client(siteId) { clients.delete(siteId); }

import { readReportMetadata, reconcileBreakdown, summarizeDataQuality } from './ga4-data-quality.js';

const num = (v) => (v == null || v === '' ? 0 : Number(v));


// ── Top pages (migration 245) ───────────────────────────────────────────────
// Views by page title, the same list Google Analytics shows under "Views by Page title and screen name".
//
// This is a TOP-N BY DESIGN: GA4 is asked for the 25 most viewed titles per day, so a site with more pages than that
// has a tail that is never stored. The day's own total views (screenPageViews with no dimension) is the yardstick:
// `reconciliation` says how much of it the list accounts for, and the route turns a real shortfall into a sentence
// instead of letting a top-25 read as the whole site. Withheld (thresholded) and bucketed (`(other)`) rows are read from
// Google's own response metadata, exactly as for every other breakdown here.
export const PAGES_PER_DAY = 25;
const TITLE_MAX = 300; // a page title is user text; bound what one row can store

/** One runReport response (pageTitle x [screenPageViews, totalUsers]) -> stored rows + what the list is worth. */
export function readPagesReport(response, totalViews) {
  const byTitle = new Map();
  for (const r of response?.rows || []) {
    const title = String(r.dimensionValues?.[0]?.value || '(not set)').trim().slice(0, TITLE_MAX) || '(not set)';
    const cur = byTitle.get(title) || { page_title: title, views: 0, users: 0 };
    // Two raw titles can collapse to one after trimming/truncation; adding them keeps every view accounted for.
    cur.views += num(r.metricValues?.[0]?.value);
    cur.users += num(r.metricValues?.[1]?.value);
    byTitle.set(title, cur);
  }
  const pages = [...byTitle.values()].sort((a, b) => b.views - a.views);
  return { pages, meta: readReportMetadata(response), reconciliation: reconcileBreakdown(pages, 'views', totalViews) };
}

/** The shape stored under data_quality.pages and read back by the route. */
export function summarizePages({ pages, meta, reconciliation }) {
  return {
    listedViews: pages.reduce((a, p) => a + p.views, 0),
    totalViews: reconciliation?.total ?? null,   // null = no total to compare with, which is not the same as "complete"
    thresholded: meta.thresholded,
    otherRowPresent: meta.otherRowPresent,
    sampled: meta.sampled,
  };
}

// Page titles for ONE day. Exported on its own so a backfill can fetch just this (one cheap call per day) instead of
// re-running the whole day's ingest. `totalViews` is the day's undimensioned page views when the caller has it.
export async function fetchGa4PagesForDate(site, date, totalViews = null) {
  const property = `properties/${site.ga4_property_id}`;
  let views = totalViews;
  if (views == null) {
    const [t] = await (await ga4(site)).runReport({
      property, dateRanges: [{ startDate: date, endDate: date }], metrics: [{ name: 'screenPageViews' }],
    });
    views = num(t.rows?.[0]?.metricValues?.[0]?.value);
  }
  const [res] = await (await ga4(site)).runReport({
    property,
    dateRanges: [{ startDate: date, endDate: date }],
    dimensions: [{ name: 'pageTitle' }],
    metrics: [{ name: 'screenPageViews' }, { name: 'totalUsers' }],
    orderBys: [{ metric: { metricName: 'screenPageViews' }, desc: true }],
    limit: PAGES_PER_DAY,
  });
  const report = readPagesReport(res, views);
  return { date, pages: report.pages, quality: summarizePages(report) };
}

// Fetch GA4 metrics for a single date, using `site`'s own Google credentials
// if it has a dedicated file (secrets/clients/<site.id>/), else the shared
// app-wide credentials.
// Returns { totals, channels } shaped for upsert. GA4 is near-real-time (fetch date = today-1).
export async function fetchGa4ForDate(site, date) {
  const property = `properties/${site.ga4_property_id}`;

  // 1) Overall totals.
  const [totalsRes] = await (await ga4(site)).runReport({
    property,
    dateRanges: [{ startDate: date, endDate: date }],
    metrics: [
      { name: 'totalUsers' },
      { name: 'newUsers' },
      { name: 'sessions' },
      { name: 'engagedSessions' },
      { name: 'averageSessionDuration' },
      { name: 'conversions' },
      { name: 'bounceRate' },
      // The day's total page views, so the page-title list below can be checked against what it claims to cover.
      { name: 'screenPageViews' },
    ],
  });

  // What Google says this response is worth (withheld rows, sampling, bucketing) — captured, never assumed clean.
  const totalsMeta = readReportMetadata(totalsRes);

  const row = totalsRes.rows?.[0]?.metricValues || [];
  const totals = {
    users: num(row[0]?.value),
    new_users: num(row[1]?.value),
    sessions: num(row[2]?.value),
    engaged_sessions: num(row[3]?.value),
    avg_engagement_time: num(row[4]?.value),
    conversions: num(row[5]?.value),
    bounce_rate: num(row[6]?.value),
    views: num(row[7]?.value),
  };

  // 2) Traffic by default channel group.
  const [chanRes] = await (await ga4(site)).runReport({
    property,
    dateRanges: [{ startDate: date, endDate: date }],
    dimensions: [{ name: 'sessionDefaultChannelGroup' }],
    metrics: [{ name: 'sessions' }, { name: 'totalUsers' }],
  });

  const channelsMeta = readReportMetadata(chanRes);
  const channels = (chanRes.rows || []).map((r) => ({
    channel: r.dimensionValues?.[0]?.value || '(other)',
    sessions: num(r.metricValues?.[0]?.value),
    users: num(r.metricValues?.[1]?.value),
  }));

  // 3) Breakdown by device category and by country (sessions + users).
  const breakdown = async (dimName) => {
    const [res] = await (await ga4(site)).runReport({
      property,
      dateRanges: [{ startDate: date, endDate: date }],
      dimensions: [{ name: dimName }],
      metrics: [{ name: 'sessions' }, { name: 'totalUsers' }],
      limit: 25,
    });
    const rows = (res.rows || []).map((r) => ({
      dim_value: r.dimensionValues?.[0]?.value || '(other)',
      sessions: num(r.metricValues?.[0]?.value),
      users: num(r.metricValues?.[1]?.value),
    }));
    // Each breakdown is checked against the day's own sessions total: rows that do not add up mean Google withheld or
    // bucketed something, whether or not it set a flag saying so.
    return { rows, meta: readReportMetadata(res), reconciliation: reconcileBreakdown(rows, 'sessions', totals.sessions) };
  };

  const deviceReport = await breakdown('deviceCategory'); // desktop / mobile / tablet
  const countryReport = await breakdown('country');
  const cityReport = await breakdown('city');
  const languageReport = await breakdown('language'); // e.g. "English", "French"
  const browserReport = await breakdown('browser'); // e.g. "Chrome", "Safari"
  const sourceMediumReport = await breakdown('sessionSourceMedium'); // e.g. "google / organic"

  // Top pages. A NEW query must never be able to break the established daily ingest, so a failure here (a property
  // without the dimension, a quota blip) costs only this day's page list: `pages` stays null and the store leaves any
  // earlier list for the day alone.
  let pages = null;
  let pagesQuality = null;
  try {
    const p = await fetchGa4PagesForDate(site, date, totals.views);
    pages = p.pages;
    pagesQuality = p.quality;
  } catch (err) {
    console.warn(`[GA4] site ${site.id} ${date}: top pages not fetched (${err.message})`);
  }

  // One verdict for the day, so anything rendering these numbers can say what they are worth instead of implying
  // they are exact. Shape is unchanged for every existing caller: the arrays are still arrays.
  const dataQuality = summarizeDataQuality({
    totalsMeta,
    breakdowns: {
      channel: { meta: channelsMeta, reconciliation: reconcileBreakdown(channels, 'sessions', totals.sessions) },
      device: deviceReport,
      country: countryReport,
      city: cityReport,
      language: languageReport,
      browser: browserReport,
      'source / medium': sourceMediumReport,
    },
  });

  // Page-title coverage rides inside the day's quality JSON, NOT its verdict: a top-25 list is incomplete by design on
  // any site with more pages, and letting that downgrade every day to 'partial' would change what the existing
  // Reports data-quality note says about numbers that are in fact fine.
  if (pagesQuality) dataQuality.pages = pagesQuality;

  return {
    date, totals, channels, pages,
    devices: deviceReport.rows,
    countries: countryReport.rows,
    cities: cityReport.rows,
    languages: languageReport.rows,
    browsers: browserReport.rows,
    sourceMediums: sourceMediumReport.rows,
    dataQuality,
  };
}
