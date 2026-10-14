import { Router } from 'express';
import {
  getSiteById, getDailySeries,
  getMonthlyTotals, getRangeTotals,
  getGscBreakdownRange, getGa4BreakdownRange, getTopMovers, getTopPagePerQuery, getTopDeviceCountryPerQuery,
  getDataRange, getChannelsRange,
  getAiCompareCache, saveAiCompareCache,
} from '../store/read.js';
import { requireAuth } from './login.js';
import { countryName } from '../util/countries.js';
import { previousWeek } from '../util/dates.js';
import { callLLM } from '../llm.js';
import { translateQuery } from '../report/translate.js';
import { buildReportSummary, buildCountryBreakdown } from '../report/summary.js';

// Precomputed A→B percent change per metric — handed to the LLM as grounded facts
// so it never has to do (and risk botching) the comparison arithmetic itself.
const pctDelta = (cur, prev) => (prev ? Math.round(((cur - prev) / prev) * 1000) / 10 : null);
function deltasAvsB(a, b, keys) {
  const out = {};
  for (const k of keys) out[k] = pctDelta(Number(b[k] || 0), Number(a[k] || 0));
  return out;
}

const router = Router();
router.use(requireAuth);

// The caller's own site only — never every row in the table. `site` is
// always derived from the authenticated session (req.siteId, set by
// requireAuth), never from client-supplied query/body params, on every
// route in this file.
router.get('/sites', async (req, res, next) => {
  try {
    const site = await getSiteById(req.siteId);
    res.json(site ? [site] : []);
  } catch (e) { next(e); }
});

// Inline report content for the dashboard's Reports page: live metrics, a
// trend chart series, query-level movers, a short recent-report-history rail,
// and the AI narrative for THIS specific period — the same narrative already
// generated for the matching Google Doc report (daily/weekly/monthly-doc.js),
// so it's always about the exact date/week/month being displayed, never a
// different period's data relabeled. No narrative is returned if the
// matching period hasn't been generated yet (periodMatches false) — an
// unrelated agent run is never substituted in, since that would show a
// narrative describing different dates than the ones on screen.
// This route only ever READS already-persisted results (the narrative
// columns) — it never triggers a run, a page-scrape, or a live LLM call.
// Plus a link to the full Doc for export. ?period=daily|weekly|monthly
router.get('/report-summary', async (req, res, next) => {
  try {
    const { period } = req.query;
    if (!['daily', 'weekly', 'monthly'].includes(period)) {
      return res.status(400).json({ error: 'period must be daily, weekly, or monthly.' });
    }
    const site = await getSiteById(req.siteId);
    if (!site) return res.status(404).json({ error: 'Site not found.' });

    res.json(await buildReportSummary(site, period));
  } catch (e) { next(e); }
});

// Available data date range (earliest, freshest-complete, latest visitor day).
router.get('/range', async (req, res, next) => {
  try {
    res.json(await getDataRange(req.siteId));
  } catch (e) { next(e); }
});

// Daily combined GSC+GA4 series. ?start=YYYY-MM-DD&end=YYYY-MM-DD
router.get('/series', async (req, res, next) => {
  try {
    const { start, end } = req.query;
    res.json(await getDailySeries(req.siteId, start, end));
  } catch (e) { next(e); }
});

// Traffic by channel aggregated over a range. ?start&end
router.get('/channels', async (req, res, next) => {
  try {
    const { start, end } = req.query;
    res.json(await getChannelsRange(req.siteId, start, end));
  } catch (e) { next(e); }
});

// GSC breakdown (query/page/etc) aggregated over a range. ?start&end&dim&limit
router.get('/breakdown-range', async (req, res, next) => {
  try {
    const { start, end, dim, limit } = req.query;
    res.json(await getGscBreakdownRange(req.siteId, start, end, dim, Number(limit) || 10));
  } catch (e) { next(e); }
});

// Device split (GA4 sessions/users by device) over a range. ?start&end
router.get('/device', async (req, res, next) => {
  try {
    const { start, end } = req.query;
    res.json(await getGa4BreakdownRange(req.siteId, start, end, 'device', 5));
  } catch (e) { next(e); }
});

// Country breakdown — GA4 visitors (by name) + GSC search clicks (code→name). ?start&end
router.get('/country', async (req, res, next) => {
  try {
    const { start, end } = req.query;
    res.json(await buildCountryBreakdown(req.siteId, start, end));
  } catch (e) { next(e); }
});

// Top movers — query-clicks change, previous full week vs the week before.
router.get('/movers', async (req, res, next) => {
  try {
    const site = req.siteId;
    const { start, end } = req.query;
    const shift = (ymd, days) => {
      const d = new Date(`${ymd}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + days);
      return d.toISOString().slice(0, 10);
    };
    let recent;
    if (start && end) {
      // Caller (Insights page) picked a real range — compare it against the
      // immediately preceding period of the same length, not a fixed week.
      recent = { start, end };
    } else {
      const siteRow = await getSiteById(site);
      const tz = siteRow?.timezone || 'Asia/Kolkata';
      recent = previousWeek(tz);
    }
    const spanDays = Math.round((new Date(`${recent.end}T00:00:00Z`) - new Date(`${recent.start}T00:00:00Z`)) / 86400000) + 1;
    const prior = { start: shift(recent.start, -spanDays), end: shift(recent.end, -spanDays) };
    const [movers, topPages, topDeviceCountry] = await Promise.all([
      getTopMovers(site, recent, prior, 50),
      getTopPagePerQuery(site, recent.start, recent.end),
      getTopDeviceCountryPerQuery(site, recent.start, recent.end),
    ]);
    const pageByQuery = new Map(topPages.map((r) => [r.query, r.page]));
    const dcByQuery = new Map(topDeviceCountry.map((r) => [r.query, r]));
    const withPage = (rows) => rows.map((r) => {
      const dc = dcByQuery.get(r.query);
      return {
        ...r,
        page: pageByQuery.get(r.query) || null,
        device: dc?.device || null,
        country: dc?.country ? countryName(dc.country) : null,
      };
    });
    res.json({
      recent, prior,
      gainers: withPage(movers.gainers),
      droppers: withPage(movers.droppers),
    });
  } catch (e) { next(e); }
});

// On-demand translation for a single query string. ?query=...
router.get('/translate', async (req, res, next) => {
  try {
    const q = req.query.query;
    if (!q || !String(q).trim()) return res.status(400).json({ error: 'query is required.' });
    res.json(await translateQuery(String(q)));
  } catch (e) { next(e); }
});

// AI action plan for a month-over-month comparison. POST { a, b }
router.post('/ai-compare', async (req, res, next) => {
  try {
    const { a, b } = req.body || {};
    if (!a || !b) return res.status(400).json({ error: 'Two months required.' });
    const site = req.siteId;
    const [ay, am] = String(a).split('-').map(Number);
    const [by, bm] = String(b).split('-').map(Number);
    const [da, db] = await Promise.all([
      getMonthlyTotals(site, ay, am),
      getMonthlyTotals(site, by, bm),
    ]);
    const deltaKeys = ['clicks', 'impressions', 'users', 'sessions', 'conversions'];
    const vsAtoBPct = deltasAvsB(da, db, deltaKeys);
    const dataSignature = { a: da, b: db, vsAtoBPct };
    const paramsKey = `${a}|${b}`;

    const cached = await getAiCompareCache(site, 'month', paramsKey);
    if (cached && JSON.stringify(cached.data_signature) === JSON.stringify(dataSignature)) {
      return res.json({ plan: cached.plan });
    }

    const system = 'You are an SEO & web-analytics strategist writing for a non-technical site owner. ' +
      'Given two months of metrics (A = earlier, B = later), write a short, specific recovery & growth action plan: ' +
      '4–6 sentences of concrete actions, prioritising the biggest drops. A lower average Search position is BETTER. ' +
      'If you cite a percent change, use ONLY the precomputed vsAtoBPct values given (A→B, negative = drop) — ' +
      'never calculate your own percentage. null means no baseline to compare. Plain text, no markdown, no bullet symbols.';
    const user = `Compare month ${a} (A) vs ${b} (B).\nA: ${JSON.stringify(da)}\nB: ${JSON.stringify(db)}\nvsAtoBPct: ${JSON.stringify(vsAtoBPct)}`;
    const plan = await callLLM(system, user, { maxTokens: 450 });
    await saveAiCompareCache(site, 'month', paramsKey, dataSignature, plan);
    res.json({ plan });
  } catch (e) { next(e); }
});

// Range comparison (week mode). ?a_start=YYYY-MM-DD&a_end=...&b_start=...&b_end=...
router.get('/compare-range', async (req, res, next) => {
  try {
    const site = req.siteId;
    const { a_start, a_end, b_start, b_end } = req.query;
    const [a, b] = await Promise.all([
      getRangeTotals(site, a_start, a_end),
      getRangeTotals(site, b_start, b_end),
    ]);
    res.json({ a: { start: a_start, end: a_end, ...a }, b: { start: b_start, end: b_end, ...b } });
  } catch (e) { next(e); }
});

// AI action plan for a range comparison. POST { a_start, a_end, b_start, b_end }
router.post('/ai-compare-range', async (req, res, next) => {
  try {
    const { a_start, a_end, b_start, b_end } = req.body || {};
    if (!a_start || !b_start) return res.status(400).json({ error: 'Two date ranges required.' });
    const site = req.siteId;
    const [da, db] = await Promise.all([
      getRangeTotals(site, a_start, a_end),
      getRangeTotals(site, b_start, b_end),
    ]);
    const deltaKeys = ['clicks', 'impressions', 'users', 'sessions', 'conversions'];
    const vsAtoBPct = deltasAvsB(da, db, deltaKeys);
    const dataSignature = { a: da, b: db, vsAtoBPct };
    const paramsKey = `${a_start}|${a_end}|${b_start}|${b_end}`;

    const cached = await getAiCompareCache(site, 'range', paramsKey);
    if (cached && JSON.stringify(cached.data_signature) === JSON.stringify(dataSignature)) {
      return res.json({ plan: cached.plan });
    }

    const system = 'You are an SEO & web-analytics strategist writing for a non-technical site owner. ' +
      'Given two weeks of metrics (A = earlier, B = later), write a short, specific recovery & growth action plan: ' +
      '4–6 sentences of concrete actions, prioritising the biggest drops. A lower average Search position is BETTER. ' +
      'If you cite a percent change, use ONLY the precomputed vsAtoBPct values given (A→B, negative = drop) — ' +
      'never calculate your own percentage. null means no baseline to compare. Plain text, no markdown, no bullet symbols.';
    const user = `Compare period ${a_start}–${a_end} (A) vs ${b_start}–${b_end} (B).\nA: ${JSON.stringify(da)}\nB: ${JSON.stringify(db)}\nvsAtoBPct: ${JSON.stringify(vsAtoBPct)}`;
    const plan = await callLLM(system, user, { maxTokens: 450 });
    await saveAiCompareCache(site, 'range', paramsKey, dataSignature, plan);
    res.json({ plan });
  } catch (e) { next(e); }
});

// Month-over-month comparison. ?a=YYYY-MM&b=YYYY-MM
router.get('/compare', async (req, res, next) => {
  try {
    if (!req.query.a || !req.query.b) return res.status(400).json({ error: 'a and b month params required (YYYY-MM).' });
    const site = req.siteId;
    const [ay, am] = req.query.a.split('-').map(Number);
    const [by, bm] = req.query.b.split('-').map(Number);
    const [a, b] = await Promise.all([
      getMonthlyTotals(site, ay, am),
      getMonthlyTotals(site, by, bm),
    ]);
    res.json({ a: { month: req.query.a, ...a }, b: { month: req.query.b, ...b } });
  } catch (e) { next(e); }
});
export default router;
