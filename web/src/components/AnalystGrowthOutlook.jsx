import { useEffect, useMemo, useState } from 'react';
import { BrainCircuit, TrendingUp, TrendingDown, Minus, Clock, CircleSlash, Search, Wrench } from 'lucide-react';
import {
  formatByUnit, pct, horizonChange, forecastHealth, isLowerBetter, horizonUnit, insufficientHistoryLabel, HEALTH_META,
  groupDeclinesByMetric, finding, supportingLine,
} from '../lib/analystFormat.js';
import AnalystTrendCard from './AnalystTrendCard.jsx';

// The metrics worth leading with, in the order a reader wants them. This is a
// PREFERENCE, not a filter: any of these that the client's catalog actually
// enables gets a tile, and a client whose keys differ still gets tiles from
// whatever else has a live forecast (below). The previous hero hardcoded
// impressions+clicks and dropped the rest on the floor even though the backend
// forecasts every metric with is_forecastable set — position and AI
// Recommendation Rate included.
const PREFERRED_METRIC_KEYS = ['gsc_clicks', 'gsc_impressions', 'gsc_position', 'ai_recommendation_rate'];
const MAX_TILES = 4;

// A rank metric's percentage change is a confusing quantity to print —
// "position -40%" is an improvement, which reads as a loss. Ranks therefore
// show the movement in positions; everything else shows the percentage.
function deltaLabel(change, metric) {
  if (!change || change.deltaPct == null) return null;
  if (isLowerBetter(metric)) {
    if (change.baseline == null) return null;
    const places = Math.round((change.baseline - change.endValue) * 10) / 10;
    if (places === 0) return 'holding';
    return `${Math.abs(places)} ${Math.abs(places) === 1 ? 'place' : 'places'} ${places > 0 ? 'better' : 'worse'}`;
  }
  return pct(change.deltaPct);
}

function daysLabel(days) {
  if (days == null) return null;
  if (days > 0) return `${days} day${days === 1 ? '' : 's'} out`;
  if (days === 0) return 'today';
  // days_until_drop is measured from the forecast's own start date and
  // observations lag by a few days, so a predicted drop can already be behind
  // us. Printing "-10 days out" reads as broken.
  return 'already underway';
}

function MetricTile({ metric, health, selected, onSelect }) {
  const meta = HEALTH_META[health.state];
  const change = health.change;
  const adverse = health.adversePct;
  const Icon = health.state === 'no-data' ? CircleSlash
    : adverse == null || Math.abs(adverse) < 1 ? Minus
    : adverse < 0 ? TrendingDown : TrendingUp;
  const tone = health.state === 'no-data' ? 'text-slate-400'
    : adverse == null || Math.abs(adverse) < 1 ? 'text-slate-500'
    : adverse < 0 ? 'text-rose-600' : 'text-emerald-600';
  const delta = deltaLabel(change, metric);

  return (
    <button
      type="button"
      onClick={() => onSelect(metric.metric_key)}
      aria-pressed={selected}
      className={`text-left rounded-2xl border p-4 transition cursor-pointer w-full ${
        selected ? 'ring-2 ring-indigo-500/40 border-indigo-300 bg-white' : 'bg-white/60 hover:bg-white border-slate-200'
      }`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="an-label truncate">{metric.display_name}</div>
        <span
          className="text-[8.5px] font-black uppercase tracking-wider px-1.5 py-0.5 rounded shrink-0"
          style={{ color: meta.color, backgroundColor: meta.bg }}
        >
          {meta.label}
        </span>
      </div>

      {health.state === 'no-data' ? (
        <>
          <div className="text-lg font-black text-slate-400 tabular-nums mt-1.5">
            {metric.latest_value != null ? formatByUnit(metric.latest_value, metric.unit) : '—'}
          </div>
          <p className="text-[10.5px] font-semibold text-slate-400 mt-1 leading-snug">
            {insufficientHistoryLabel(metric)}
          </p>
        </>
      ) : (
        <>
          {/* Observed value and projected value, always shown as two distinct
              numbers with the arrow between them, so "what it is now" is never
              confused with "what the model thinks it becomes". */}
          <div className="flex items-baseline gap-1.5 mt-1.5 flex-wrap">
            {change.baseline != null && (
              <>
                <span className="text-lg font-black text-slate-900 tabular-nums">
                  {formatByUnit(change.baseline, metric.unit)}
                </span>
                <span className="text-slate-300 text-xs font-bold">→</span>
              </>
            )}
            <span className={`text-lg font-black tabular-nums ${change.baseline != null ? 'text-slate-500' : 'text-slate-900'}`}>
              {formatByUnit(change.endValue, metric.unit)}
            </span>
          </div>
          <div className="flex items-center gap-1.5 mt-1 flex-wrap">
            <span className={`flex items-center gap-1 text-[11px] font-black ${tone}`}>
              <Icon size={11} />
              {delta || `in ${change.horizon}${horizonUnit(metric)}`}
            </span>
            {delta && (
              <span className="text-[10px] font-semibold text-slate-400">
                projected · {change.horizon}{horizonUnit(metric)}
              </span>
            )}
          </div>
        </>
      )}
    </button>
  );
}

// What happened / what's expected / why / what to fix, for the tile the
// reader has selected — same real, backend-narrated data
// AnalystMetricIntelligence's MetricCard already shows below the fold
// (groupDeclinesByMetric's `narrated.root_cause`/`narrated.recommendation`
// come verbatim from the nightly recommendation pass, never synthesized
// here), just also surfaced at the hero level so the reader doesn't have to
// scroll down to see why the metric they just clicked is doing what it's
// doing. A healthy metric with no decline insight has no group at all —
// that's the honest "nothing to report" case, shown as such rather than
// with an empty box.
function SelectedTileNarrative({ metric, insights }) {
  const group = useMemo(
    () => groupDeclinesByMetric(insights, [metric]).find((g) => g.metricKey === metric.metric_key) || null,
    [insights, metric]
  );
  if (!group) return null;

  const happenedInsight = group.happened[0];
  const expectedInsight = group.expected[0];

  return (
    <div className="relative mt-4 rounded-xl bg-white/70 border border-slate-200 p-3.5 space-y-1.5">
      {happenedInsight && (
        <p className="text-[11.5px] font-semibold text-slate-800 leading-snug">
          <span className="an-label mr-1.5">What happened</span>
          {finding(happenedInsight, metric)}
          <span className="font-medium text-slate-500"> · {supportingLine(happenedInsight, metric)}</span>
        </p>
      )}
      {expectedInsight && (
        <p className="text-[11.5px] font-semibold text-slate-800 leading-snug">
          <span className="an-label mr-1.5">What's expected</span>
          {finding(expectedInsight, metric)}
          <span className="font-medium text-slate-500"> · {supportingLine(expectedInsight, metric)}</span>
        </p>
      )}
      {group.narrated?.root_cause && (
        <p className="text-[11px] font-medium text-slate-700">
          <span className="an-label mr-1.5">Why</span>
          {group.narrated.root_cause}
          <span className="text-[9.5px] font-bold text-slate-400 ml-1.5 uppercase tracking-wider">AI inference</span>
        </p>
      )}
      {group.narrated?.recommendation ? (
        <p className="text-[11px] font-semibold text-slate-800 flex items-start gap-1.5">
          <Wrench size={11} className="shrink-0 mt-0.5 text-indigo-600" />
          <span><span className="an-label mr-1.5">What to fix</span>{group.narrated.recommendation}</span>
        </p>
      ) : (
        <p className="text-[10.5px] font-medium text-slate-500 flex items-start gap-1.5">
          <Search size={11} className="shrink-0 mt-0.5 text-slate-400" />
          No fix guidance written for this yet. The finding and its evidence are shown above; guidance is added by the nightly pass.
        </p>
      )}
    </div>
  );
}

// The Analyst page's hero: where every forecastable headline metric is
// heading, and which of them are in trouble — the future stated first, before
// any backward-looking detail. The chart underneath is the same
// AnalystTrendCard that used to be buried inside Impression Forecast at the
// bottom of the page; clicking a tile drives it.
export default function AnalystGrowthOutlook({ clientId, dashboard }) {
  const metrics = useMemo(() => Object.values(dashboard?.groups || {}).flat(), [dashboard]);
  const insights = dashboard?.insights || [];

  const tiles = useMemo(() => {
    const preferred = PREFERRED_METRIC_KEYS
      .map((key) => metrics.find((m) => m.metric_key === key))
      .filter(Boolean);
    // Fill any remaining slots with other metrics that genuinely have a
    // forecast, rather than leaving the hero half empty for a client whose
    // catalog uses different keys.
    const extras = metrics.filter(
      (m) => m.forecast?.status === 'ok' && !preferred.some((p) => p.metric_key === m.metric_key)
    );
    return [...preferred, ...extras]
      .slice(0, MAX_TILES)
      .map((metric) => ({ metric, health: forecastHealth(metric, insights) }));
  }, [metrics, insights]);

  const [selectedMetricKey, setSelectedMetricKey] = useState(null);

  // Default the chart to the most urgent tile rather than always impressions —
  // if something is projected to decline, that is what the reader should be
  // looking at first. Re-picks when the client changes.
  useEffect(() => {
    if (!tiles.length) return;
    setSelectedMetricKey((prev) => {
      if (prev && tiles.some((t) => t.metric.metric_key === prev)) return prev;
      const order = { 'at-risk': 0, watch: 1, healthy: 2, 'no-data': 3 };
      const worst = [...tiles].sort(
        (a, b) => (order[a.health.state] ?? 4) - (order[b.health.state] ?? 4)
      )[0];
      return worst.metric.metric_key;
    });
  }, [tiles]);

  const atRisk = tiles.filter((t) => t.health.state === 'at-risk');
  const watching = tiles.filter((t) => t.health.state === 'watch');
  const soonest = [...atRisk, ...watching]
    .map((t) => t.health.daysUntilDrop)
    .filter((d) => typeof d === 'number' && d > 0)
    .sort((a, b) => a - b)[0] ?? null;

  const headline = atRisk.length
    ? `${atRisk.length} metric${atRisk.length === 1 ? ' is' : 's are'} projected to decline`
    : watching.length
    ? `${watching.length} metric${watching.length === 1 ? ' is' : 's are'} trending toward trouble`
    : tiles.some((t) => t.health.state === 'healthy')
    ? 'Nothing is projected to decline'
    : 'Not enough history to project yet';

  return (
    <div className="an-panel p-6 relative overflow-hidden">
      <div aria-hidden className="absolute -top-16 -right-16 w-64 h-64 rounded-full bg-indigo-500/10 blur-3xl pointer-events-none" />
      <div aria-hidden className="absolute -bottom-20 -left-10 w-56 h-56 rounded-full bg-violet-500/8 blur-3xl pointer-events-none" />

      <div className="relative flex items-start gap-3 mb-5 flex-wrap">
        <div className="w-10 h-10 rounded-2xl grid place-items-center bg-gradient-to-br from-indigo-500 to-violet-600 text-white shrink-0 shadow-lg shadow-indigo-500/25">
          <BrainCircuit size={19} />
        </div>
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-black text-slate-900 tracking-tight">Growth Outlook</h2>
          <p className="text-[11px] font-medium text-slate-500">
            Where the site is heading over the next two weeks — site-wide, not per page
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <span className={`an-chip ${atRisk.length ? 'an-chip-rose' : watching.length ? 'an-chip-amber' : 'an-chip-emerald'}`}>
            {headline}
          </span>
          {soonest != null && (
            <span className="an-chip an-chip-slate">
              <Clock size={9} />
              soonest {daysLabel(soonest)}
            </span>
          )}
        </div>
      </div>

      {tiles.length === 0 ? (
        <p className="relative text-xs font-medium text-slate-500 bg-slate-100/60 border border-slate-200 rounded-xl px-4 py-3">
          No forecastable metrics for this client yet. Tiles appear here once Search Console data has
          been collected and the nightly models have run.
        </p>
      ) : (
        <div className="relative grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
          {tiles.map(({ metric, health }) => (
            <MetricTile
              key={metric.metric_key}
              metric={metric}
              health={health}
              selected={selectedMetricKey === metric.metric_key}
              onSelect={setSelectedMetricKey}
            />
          ))}
        </div>
      )}

      {selectedMetricKey && tiles.find((t) => t.metric.metric_key === selectedMetricKey) && (
        <SelectedTileNarrative
          metric={tiles.find((t) => t.metric.metric_key === selectedMetricKey).metric}
          insights={insights}
        />
      )}

      {/* The forecast made visible. Past, today and the projected band in one
          picture — the thing a reader can understand without parsing "-12%". */}
      {selectedMetricKey && metrics.length > 0 && (
        <div className="relative mt-4">
          <AnalystTrendCard
            clientId={clientId}
            metrics={metrics}
            selectedMetricKey={selectedMetricKey}
            onSelectMetric={setSelectedMetricKey}
            insights={insights}
          />
        </div>
      )}
    </div>
  );
}
