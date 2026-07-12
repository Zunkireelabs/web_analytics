import { Router } from 'express';
import {
  getSiteById, getDailySeries, getDay, getBreakdown,
  getChannels, getNarrative, getMonthlyTotals, getRangeTotals, getWeeklyDocUrl, getDailyDocUrl, getMonthlyDocUrl,
  getGscBreakdownRange, getGa4BreakdownRange, getTopMovers, getTopPagePerQuery, getTopDeviceCountryPerQuery,
  getDataRange, getChannelsRange,
} from '../store/read.js';
import { getLatestAgentRuns } from '../store/agent-runs.js';
import { requireAuth } from './login.js';
import { countryName } from '../util/countries.js';
import { previousWeek, previousMonth, monthBounds, shiftMonth } from '../util/dates.js';
import { callLLM } from '../llm.js';
import { translateQuery } from '../report/translate.js';

const iso = (d) => String(d).slice(0, 10);
const shiftYmd = (ymd, days) => {
  const d = new Date(`${ymd}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

// Precomputed A→B percent change per metric — handed to the LLM as grounded facts
// so it never has to do (and risk botching) the comparison arithmetic itself.
const pctDelta = (cur, prev) => (prev ? Math.round(((cur - prev) / prev) * 1000) / 10 : null);
function deltasAvsB(a, b, keys) {
  const out = {};
  for (const k of keys) out[k] = pctDelta(Number(b[k] || 0), Number(a[k] || 0));
  return out;
}

// Build a grounded text context for the AI: the day's metrics, change vs the prior
// day, a 7-day average, top queries/pages/channels, and the device split.
// Returns { ok, text }. ok=false when the chosen day has no data yet.
async function buildAiContext(site, date) {
  const start = shiftYmd(date, -7);
  const [series, queries, pages, channels, devices] = await Promise.all([
    getDailySeries(site, start, date),
    getBreakdown(site, date, 'query', 5),
    getBreakdown(site, date, 'page', 5),
    getChannels(site, date),
    getGa4BreakdownRange(site, start, date, 'device', 5),
  ]);
  const today = series.find((r) => iso(r.date) === date);
  const prior = series.find((r) => iso(r.date) === shiftYmd(date, -1)) || {};
  const num = (v) => (v == null ? 0 : Number(v));

  if (!today || (today.clicks == null && today.users == null)) {
    return { ok: false, text: '' };
  }

  const past = series.filter((r) => iso(r.date) !== date);
  const avg = (k) => {
    const v = past.map((r) => num(r[k]));
    return v.length ? Math.round(v.reduce((a, b) => a + b, 0) / v.length) : 0;
  };
  const delta = (cur, prev) => {
    cur = num(cur); prev = num(prev);
    if (!prev) return `${cur} (no prior-day data)`;
    const pct = Math.round(((cur - prev) / prev) * 100);
    return `${cur} (${pct >= 0 ? '+' : ''}${pct}% vs prior day, prior was ${prev})`;
  };

  const text = `
Date: ${date}
Clicks: ${delta(today.clicks, prior.clicks)} | 7-day avg ${avg('clicks')}
Impressions: ${delta(today.impressions, prior.impressions)} | 7-day avg ${avg('impressions')}
Avg Search position (lower is better): ${num(today.position).toFixed(1)}
Users: ${delta(today.users, prior.users)}
Sessions: ${delta(today.sessions, prior.sessions)}
Conversions: ${num(today.conversions)}
Device split (last 7 days, sessions): ${devices.map((d) => `${d.dim_value} ${num(d.sessions)}`).join(', ') || 'n/a'}
Top queries: ${queries.map((q) => `"${q.dim_value}" (${num(q.clicks)} clicks, ${num(q.impressions)} impressions)`).join(', ') || 'none'}
Top pages: ${pages.map((p) => `${p.dim_value} (${num(p.clicks)} clicks)`).join(', ') || 'none'}
Top channels: ${channels.map((c) => `${c.channel} (${num(c.sessions)} sessions)`).join(', ') || 'none'}
`.trim();
  return { ok: true, text };
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

// vs-previous-entry percent change, newest-first arrays (entry i vs entry i+1).
function withDeltaPct(entries) {
  return entries.map((h, i) => {
    const older = entries[i + 1];
    const deltaPct = older && older.clicks ? Math.round(((h.clicks - older.clicks) / older.clicks) * 1000) / 10 : null;
    return { ...h, deltaPct };
  });
}

// Inline report content for the dashboard's Reports page: live metrics, a
// trend chart series, query-level movers, a short recent-report-history rail,
// and the AI narrative — preferring the latest persisted executive-report
// agent run (richer: what/why/what's-next) and falling back to the lighter
// per-period narrative already generated for the matching Google Doc report.
// This route only ever READS already-persisted results (agent_runs, the
// narrative columns) — it never triggers a run, a page-scrape, or a live LLM
// call. Plus a link to the full Doc for export. ?period=daily|weekly|monthly
router.get('/report-summary', async (req, res, next) => {
  try {
    const { period } = req.query;
    if (!['daily', 'weekly', 'monthly'].includes(period)) {
      return res.status(400).json({ error: 'period must be daily, weekly, or monthly.' });
    }
    const site = await getSiteById(req.siteId);
    if (!site) return res.status(404).json({ error: 'Site not found.' });

    const [execRun] = await getLatestAgentRuns(site.id, ['executive-report']);
    const resolveNarrative = (periodNarrative, periodMatches) => {
      if (execRun?.status === 'ok' && execRun.narrative) {
        return { narrative: execRun.narrative, narrativeSource: 'executive-report', narrativeGeneratedAt: execRun.created_at };
      }
      if (periodMatches && periodNarrative) {
        return { narrative: periodNarrative, narrativeSource: 'period', narrativeGeneratedAt: null };
      }
      return { narrative: null, narrativeSource: null, narrativeGeneratedAt: null };
    };

    if (period === 'daily') {
      const { freshest: date } = await getDataRange(site.id);
      if (!date) {
        return res.json({ period, date: null, metrics: null, series: [], movers: { gainers: [], droppers: [] }, history: [], ...resolveNarrative(null, false), docUrl: await getDailyDocUrl(site.id) });
      }
      const row = await getDay(site.id, date);
      const matches = site.daily_report_narrative_date === date;
      const series = await getDailySeries(site.id, shiftYmd(date, -7), date); // 8 days, oldest→newest
      const { gainers, droppers } = await getTopMovers(site.id, { start: date, end: date }, { start: shiftYmd(date, -1), end: shiftYmd(date, -1) }, 8);
      const history = withDeltaPct(series.slice(1).map((r) => ({ label: iso(r.date), clicks: Number(r.clicks || 0) })).reverse());
      return res.json({
        period, date,
        metrics: row && {
          clicks: row.clicks, impressions: row.impressions, position: row.position,
          users: row.users, sessions: row.sessions,
        },
        series, movers: { gainers, droppers }, history,
        ...resolveNarrative(site.daily_report_narrative, matches),
        docUrl: await getDailyDocUrl(site.id),
      });
    }

    if (period === 'weekly') {
      const { start, end } = previousWeek(site.timezone);
      const totals = await getRangeTotals(site.id, start, end);
      const matches = site.weekly_report_narrative_start === start && site.weekly_report_narrative_end === end;
      const series = await getDailySeries(site.id, start, end);
      const { gainers, droppers } = await getTopMovers(site.id, { start, end }, { start: shiftYmd(start, -7), end: shiftYmd(end, -7) }, 8);
      const weeklyTotals = [];
      for (let i = 0; i < 4; i++) {
        const wStart = shiftYmd(start, -7 * i);
        const wEnd = shiftYmd(end, -7 * i);
        const t = await getRangeTotals(site.id, wStart, wEnd);
        weeklyTotals.push({ label: `${wStart} – ${wEnd}`, clicks: Number(t.clicks || 0) });
      }
      return res.json({
        period, start, end,
        metrics: {
          clicks: totals.clicks, impressions: totals.impressions, position: totals.avg_position,
          users: totals.users, sessions: totals.sessions,
        },
        series, movers: { gainers, droppers }, history: withDeltaPct(weeklyTotals),
        ...resolveNarrative(site.weekly_report_narrative, matches),
        docUrl: await getWeeklyDocUrl(site.id),
      });
    }

    // monthly
    const { year, month } = previousMonth(site.timezone);
    const ym = `${year}-${String(month).padStart(2, '0')}`;
    const { start, end } = monthBounds(year, month);
    const totals = await getMonthlyTotals(site.id, year, month);
    const matches = site.monthly_report_narrative_ym === ym;
    const series = await getDailySeries(site.id, start, end);
    const priorYm = shiftMonth(year, month, -1);
    const priorBounds = monthBounds(priorYm.year, priorYm.month);
    const { gainers, droppers } = await getTopMovers(site.id, { start, end }, priorBounds, 8);
    const monthlyTotals = [];
    for (let i = 0; i < 6; i++) {
      const sm = shiftMonth(year, month, -i);
      const t = await getMonthlyTotals(site.id, sm.year, sm.month);
      monthlyTotals.push({ label: `${sm.year}-${String(sm.month).padStart(2, '0')}`, clicks: Number(t.clicks || 0) });
    }
    res.json({
      period, ym,
      metrics: {
        clicks: totals.clicks, impressions: totals.impressions, position: totals.avg_position,
        users: totals.users, sessions: totals.sessions,
      },
      series, movers: { gainers, droppers }, history: withDeltaPct(monthlyTotals),
      ...resolveNarrative(site.monthly_report_narrative, matches),
      docUrl: await getMonthlyDocUrl(site.id),
    });
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

// One day's overview bundle: metrics + top queries/pages + channels + narrative.
router.get('/day', async (req, res, next) => {
  try {
    const site = req.siteId;
    const date = req.query.date;
    const [metrics, queries, pages, channels, narrative] = await Promise.all([
      getDay(site, date),
      getBreakdown(site, date, 'query', 10),
      getBreakdown(site, date, 'page', 10),
      getChannels(site, date),
      getNarrative(site, date),
    ]);
    res.json({ date, metrics, queries, pages, channels, narrative: narrative?.narrative || null });
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
    const site = req.siteId;
    const { start, end } = req.query;
    const [ga4, gsc] = await Promise.all([
      getGa4BreakdownRange(site, start, end, 'country', 10),
      getGscBreakdownRange(site, start, end, 'country', 10),
    ]);
    res.json({
      visitors: ga4.map((r) => ({ country: r.dim_value, sessions: r.sessions, users: r.users })),
      search: gsc.map((r) => ({ code: r.dim_value, country: countryName(r.dim_value), clicks: r.clicks, impressions: r.impressions })),
    });
  } catch (e) { next(e); }
});

// Top movers — query-clicks change, previous full week vs the week before.
router.get('/movers', async (req, res, next) => {
  try {
    const site = req.siteId;
    const siteRow = await getSiteById(site);
    const tz = siteRow?.timezone || 'Asia/Kolkata';
    const recent = previousWeek(tz);
    // The week before `recent`: shift both ends back 7 days.
    const shift = (ymd, days) => {
      const d = new Date(`${ymd}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + days);
      return d.toISOString().slice(0, 10);
    };
    const prior = { start: shift(recent.start, -7), end: shift(recent.end, -7) };
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
    const system = 'You are an SEO & web-analytics strategist writing for a non-technical site owner. ' +
      'Given two months of metrics (A = earlier, B = later), write a short, specific recovery & growth action plan: ' +
      '4–6 sentences of concrete actions, prioritising the biggest drops. A lower average Search position is BETTER. ' +
      'If you cite a percent change, use ONLY the precomputed vsAtoBPct values given (A→B, negative = drop) — ' +
      'never calculate your own percentage. null means no baseline to compare. Plain text, no markdown, no bullet symbols.';
    const user = `Compare month ${a} (A) vs ${b} (B).\nA: ${JSON.stringify(da)}\nB: ${JSON.stringify(db)}\nvsAtoBPct: ${JSON.stringify(vsAtoBPct)}`;
    const plan = await callLLM(system, user, { maxTokens: 450 });
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
    const system = 'You are an SEO & web-analytics strategist writing for a non-technical site owner. ' +
      'Given two weeks of metrics (A = earlier, B = later), write a short, specific recovery & growth action plan: ' +
      '4–6 sentences of concrete actions, prioritising the biggest drops. A lower average Search position is BETTER. ' +
      'If you cite a percent change, use ONLY the precomputed vsAtoBPct values given (A→B, negative = drop) — ' +
      'never calculate your own percentage. null means no baseline to compare. Plain text, no markdown, no bullet symbols.';
    const user = `Compare period ${a_start}–${a_end} (A) vs ${b_start}–${b_end} (B).\nA: ${JSON.stringify(da)}\nB: ${JSON.stringify(db)}\nvsAtoBPct: ${JSON.stringify(vsAtoBPct)}`;
    const plan = await callLLM(system, user, { maxTokens: 450 });
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
// On-demand fresh AI insight for a chosen day. ?date
router.get('/ai-summary', async (req, res, next) => {
  try {
    const ctx = await buildAiContext(req.siteId, req.query.date);
    if (!ctx.ok) return res.json({ summary: 'No finalized data for that day yet — pick an earlier day.' });
    const system = 'You are a concise SEO/analytics analyst writing for a non-technical owner. ' +
      'Give sharp, specific, actionable insight in 3 sentences max. Lead with the overall trend, then the ' +
      'single most notable change, then one action. A lower Search position is BETTER. Plain text, no markdown, no bullets.';
    const summary = await callLLM(system, ctx.text, { maxTokens: 300 });
    res.json({ summary });
  } catch (e) { next(e); }
});

// Ask a free-text question about a day's data. POST { date, question }
router.post('/ai-ask', async (req, res, next) => {
  try {
    const { date, question } = req.body || {};
    if (!question || !question.trim()) return res.status(400).json({ error: 'Question is required.' });
    const ctx = await buildAiContext(req.siteId, date);
    if (!ctx.ok) return res.json({ answer: 'No finalized data for that day yet — try an earlier day.' });
    const system = 'You are an SEO/analytics assistant. Answer the user\'s question using ONLY the data provided. ' +
      'Be concise and specific, cite the real numbers, and suggest an action when relevant. If the data does not ' +
      'contain the answer, say so plainly. A lower Search position is BETTER. Plain text, no markdown, no bullets.';
    const answer = await callLLM(system, `${ctx.text}\n\nUser question: ${question}`, { maxTokens: 400 });
    res.json({ answer });
  } catch (e) { next(e); }
});

export default router;
