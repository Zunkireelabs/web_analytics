// PREDICTIVE TOPIC DISCOVERY from real data. PURE: weekly Search Console series, the best page per query and the keyword-gap rows in; candidate
// topics with the evidence they came from out. Nothing here invents a number: a projection is a least-squares line through the real weekly
// impressions and says so, seasonality needs more than a year of history and reports 'insufficient history' when it has less, and a candidate with
// no real series behind it is simply not produced.
import { topicTokens, topicKey, topicMatch } from '../content-index/normalize.js';

export const DEFAULTS = Object.freeze({
  recentWeeks: 4, priorWeeks: 8, minRecentWeeklyImpressions: 15, minGrowth: 1.5, minTopicWords: 2,
  coveredPosition: 20,        // a page already ranking this well for the query serves it
  horizonWeeks: 2,            // how far ahead the projection looks (one blog cycle)
});

const sum = (a) => a.reduce((n, x) => n + x, 0);
const mean = (a) => (a.length ? sum(a) / a.length : 0);

/** Pure. [{ week: 'YYYY-MM-DD', impressions }] -> a dense array of the last `weeks` weekly totals (missing weeks are real zeros), oldest first. */
export function denseWeeks(series, { weeks, endWeek }) {
  const by = new Map(series.map((r) => [String(r.week).slice(0, 10), Number(r.impressions) || 0]));
  const out = []; const end = new Date(`${String(endWeek).slice(0, 10)}T00:00:00Z`);
  for (let i = weeks - 1; i >= 0; i--) { const d = new Date(end.getTime() - i * 7 * 86_400_000).toISOString().slice(0, 10); out.push(by.get(d) ?? 0); }
  return out;
}

/** Pure. Least-squares line through the points; returns the projected total impressions over the next `horizon` weeks (never below 0) and the slope. */
export function projectImpressions(weekly, horizon = DEFAULTS.horizonWeeks) {
  const n = weekly.length;
  if (n < 4) return { projected: null, slope: null, basis: `only ${n} weeks of data` };
  const xs = weekly.map((_, i) => i); const mx = mean(xs); const my = mean(weekly);
  const denom = sum(xs.map((x) => (x - mx) ** 2)) || 1;
  const slope = sum(xs.map((x, i) => (x - mx) * (weekly[i] - my))) / denom;
  const intercept = my - slope * mx;
  let projected = 0; for (let k = 0; k < horizon; k++) projected += Math.max(0, intercept + slope * (n + k));
  return { projected: Math.round(projected), slope: Math.round(slope * 100) / 100, basis: `least-squares line over the last ${n} weeks` };
}

/**
 * Pure. Seasonal lift: this calendar month's impressions last year against that year's monthly average. Needs at least 13 months of weeks to say
 * anything; with less it returns { known: false } and the caller records "insufficient history", never a guess.
 */
export function seasonalLift(monthlyTotals, nowMonth) {
  const months = Object.keys(monthlyTotals).sort();
  if (months.length < 13) return { known: false, reason: `only ${months.length} month(s) of history; a seasonal read needs 13` };
  const avg = mean(months.map((m) => monthlyTotals[m]));
  const same = months.filter((m) => m.slice(5, 7) === String(nowMonth).padStart(2, '0') && m !== months.at(-1));
  if (!same.length || !avg) return { known: false, reason: 'no same-month history' };
  const lift = mean(same.map((m) => monthlyTotals[m])) / avg;
  return { known: true, lift: Math.round(lift * 100) / 100, seasonal: lift >= 1.3 };
}

const brandTokens = (site) => new Set(topicTokens(`${site?.name || ''} ${site?.website_domain || ''}`.replace(/\.[a-z]{2,}\b/g, ' ')));

/**
 * Pure. Queries whose recent weekly impressions have clearly risen against the weeks before, that no page already serves, and that are not about
 * the brand itself. Each carries its real series and a projection.
 * @param {Array} rows            [{ query, week, impressions, clicks }] weekly, per query
 * @param {Map}  bestPageByQuery  query -> { page, position } (the best-ranking own page in the last 90 days)
 */
export function risingQueries(rows, { bestPageByQuery = new Map(), site = null, endWeek, opts = {} } = {}) {
  const o = { ...DEFAULTS, ...opts }; const brand = brandTokens(site);
  const byQuery = new Map(); for (const r of rows) { if (!byQuery.has(r.query)) byQuery.set(r.query, []); byQuery.get(r.query).push(r); }
  const out = [];
  for (const [query, series] of byQuery) {
    const tokens = topicTokens(query);
    if (tokens.length < o.minTopicWords) continue;                               // too short to be a topic
    if (tokens.some((t) => brand.has(t))) continue;                              // about the brand, not a topic to write
    const weekly = denseWeeks(series, { weeks: o.recentWeeks + o.priorWeeks, endWeek });
    const recent = weekly.slice(-o.recentWeeks); const prior = weekly.slice(0, o.priorWeeks);
    const recentAvg = mean(recent); const priorAvg = mean(prior);
    if (recentAvg < o.minRecentWeeklyImpressions) continue;
    const growth = priorAvg === 0 ? Infinity : recentAvg / priorAvg;
    if (growth < o.minGrowth) continue;
    const best = bestPageByQuery.get(query);
    if (best && best.position != null && best.position <= o.coveredPosition) continue; // a page already serves it
    const projection = projectImpressions(weekly, o.horizonWeeks);
    out.push({ query, recentWeeklyImpressions: Math.round(recentAvg), priorWeeklyImpressions: Math.round(priorAvg), growth: growth === Infinity ? null : Math.round(growth * 100) / 100, isNew: priorAvg === 0, projection, bestPage: best || null });
  }
  return out.sort((a, b) => (b.projection.projected ?? 0) - (a.projection.projected ?? 0) || b.recentWeeklyImpressions - a.recentWeeklyImpressions);
}

/** Pure. Keyword-gap rows nobody has acted on that still look like an opportunity. */
export function gapCandidates(gaps) {
  return (gaps || []).filter((g) => g.topic && !g.recommendation_id && ['pending_review', 'approved'].includes(g.status)
    && !['duplicate', 'covered', 'uncertain'].includes(g.coverage_status)).map((g) => ({
    topic: g.topic, origin: 'keyword-gap', gapId: g.id, demand: g.search_volume != null ? { searchVolume: Number(g.search_volume) } : null,
    signals: { competitor: !!(g.competitor_evidence && Object.keys(g.competitor_evidence).length), trend: false, detectors: ['analyst-keyword-gaps'] },
  }));
}

/**
 * Pure. Merges every source into ONE candidate per topic (a topic both rising in search and found as a competitor gap carries both), drops what is
 * already an open recommendation (not proposed twice), and returns the merged candidates with their combined signals and evidence notes.
 */
export function mergeCandidates({ rising = [], gaps = [], openTopics = [], seasonal = null }) {
  const byKey = new Map();
  const add = (c) => {
    const key = topicKey(c.topic); if (!key) return;
    const prev = byKey.get(key);
    if (!prev) { byKey.set(key, { ...c, topicKey: key, origins: [c.origin], signals: { ...c.signals }, notes: [...(c.notes || [])] }); return; }
    prev.origins = [...new Set([...prev.origins, c.origin])];
    prev.signals = { competitor: prev.signals.competitor || c.signals.competitor, trend: prev.signals.trend || c.signals.trend, detectors: [...new Set([...(prev.signals.detectors || []), ...(c.signals.detectors || [])])] };
    prev.demand = prev.demand?.searchVolume != null ? prev.demand : c.demand;
    prev.projection = prev.projection || c.projection; prev.recentImpressions = prev.recentImpressions ?? c.recentImpressions; prev.notes.push(...(c.notes || []));
    prev.gapId = prev.gapId ?? c.gapId;
  };
  for (const r of rising) {
    add({ topic: r.query, origin: 'rising-query', demand: null, projection: r.projection, recentImpressions: r.recentWeeklyImpressions * DEFAULTS.recentWeeks, signals: { competitor: false, trend: false, detectors: ['topic-research'] },
      notes: [`recent weekly impressions ${r.recentWeeklyImpressions} vs ${r.priorWeeklyImpressions} before${r.isNew ? ' (new query)' : ` (x${r.growth})`}; projected ${r.projection.projected ?? 'n/a'} over the next cycle (${r.projection.basis})`, ...(seasonal && seasonal.known ? [`seasonal lift ${seasonal.lift}${seasonal.seasonal ? ' (seasonal peak)' : ''}`] : seasonal ? [`seasonality: insufficient history (${seasonal.reason})`] : [])] });
  }
  for (const g of gapCandidates(gaps)) add(g);
  const open = openTopics.map((t) => topicTokens(t)).filter((t) => t.length);
  return [...byKey.values()].filter((c) => { const tk = topicTokens(c.topic); return !open.some((o) => topicMatch(tk, o).match); });
}
