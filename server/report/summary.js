import {
  getDataRange, getDay, getDailySeries, getTopMovers,
  getWeeklyDocUrl, getDailyDocUrl, getMonthlyDocUrl,
  getRangeTotals, getMonthlyTotals,
  getGa4BreakdownRange, getGscBreakdownRange,
} from '../store/read.js';
import { previousWeek, previousMonth, monthBounds, shiftMonth } from '../util/dates.js';
import { countryName } from '../util/countries.js';

const iso = (d) => String(d).slice(0, 10);
const shiftYmd = (ymd, days) => {
  const d = new Date(`${ymd}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

// vs-previous-entry percent change, newest-first arrays (entry i vs entry i+1).
function withDeltaPct(entries) {
  return entries.map((h, i) => {
    const older = entries[i + 1];
    const deltaPct = older && older.clicks ? Math.round(((h.clicks - older.clicks) / older.clicks) * 1000) / 10 : null;
    return { ...h, deltaPct };
  });
}

// Shared by GET /api/report-summary (server/routes/metrics.js) and the MCP
// get_report_summary tool (mcp-server/tools.js) — one implementation so the
// two surfaces can never drift apart. `site` must already be loaded
// (getSiteById) by the caller; this never re-fetches it.
export async function buildReportSummary(site, period) {
  const resolveNarrative = (periodNarrative, periodMatches) => {
    if (periodMatches && periodNarrative) {
      return { narrative: periodNarrative, narrativeSource: 'period', narrativeGeneratedAt: null };
    }
    return { narrative: null, narrativeSource: null, narrativeGeneratedAt: null };
  };

  if (period === 'daily') {
    const { freshest: date } = await getDataRange(site.id);
    if (!date) {
      return { period, date: null, metrics: null, series: [], movers: { gainers: [], droppers: [] }, history: [], ...resolveNarrative(null, false), docUrl: await getDailyDocUrl(site.id) };
    }
    const row = await getDay(site.id, date);
    const matches = site.daily_report_narrative_date === date;
    const series = await getDailySeries(site.id, shiftYmd(date, -10), date); // 11 days, oldest→newest (first day is the delta baseline for the Recent Report History rail, leaving 10 rows shown)
    const { gainers, droppers } = await getTopMovers(site.id, { start: date, end: date }, { start: shiftYmd(date, -1), end: shiftYmd(date, -1) }, 8);
    const history = withDeltaPct(series.map((r) => ({ label: iso(r.date), clicks: Number(r.clicks || 0) })).reverse()).slice(0, 10);
    return {
      period, date,
      metrics: row && {
        clicks: row.clicks, impressions: row.impressions, position: row.position,
        users: row.users, sessions: row.sessions,
      },
      series, movers: { gainers, droppers }, history,
      ...resolveNarrative(site.daily_report_narrative, matches),
      docUrl: await getDailyDocUrl(site.id),
    };
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
    return {
      period, start, end,
      metrics: {
        clicks: totals.clicks, impressions: totals.impressions, position: totals.avg_position,
        users: totals.users, sessions: totals.sessions,
      },
      series, movers: { gainers, droppers }, history: withDeltaPct(weeklyTotals),
      ...resolveNarrative(site.weekly_report_narrative, matches),
      docUrl: await getWeeklyDocUrl(site.id),
    };
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
  return {
    period, ym,
    metrics: {
      clicks: totals.clicks, impressions: totals.impressions, position: totals.avg_position,
      users: totals.users, sessions: totals.sessions,
    },
    series, movers: { gainers, droppers }, history: withDeltaPct(monthlyTotals),
    ...resolveNarrative(site.monthly_report_narrative, matches),
    docUrl: await getMonthlyDocUrl(site.id),
  };
}

// Shared by GET /api/country (server/routes/metrics.js) and the MCP
// get_country_breakdown tool.
export async function buildCountryBreakdown(siteId, start, end) {
  const [ga4, gsc] = await Promise.all([
    getGa4BreakdownRange(siteId, start, end, 'country', 10),
    getGscBreakdownRange(siteId, start, end, 'country', 10),
  ]);
  return {
    visitors: ga4.map((r) => ({ country: r.dim_value, sessions: r.sessions, users: r.users })),
    search: gsc.map((r) => ({ code: r.dim_value, country: countryName(r.dim_value), clicks: r.clicks, impressions: r.impressions })),
  };
}
