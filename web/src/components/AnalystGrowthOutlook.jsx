import { useEffect, useMemo, useState } from 'react';
import { TrendingUp, TrendingDown, Minus, Clock, CircleSlash } from 'lucide-react';
import {
  formatByUnit, pct, horizonChange, forecastHealth, isLowerBetter, horizonUnit, insufficientHistoryLabel, HEALTH_META,
} from '../lib/analystFormat.js';
import AnalystTrendCard from './AnalystTrendCard.jsx';
import Badge from './Badge.jsx';
import { Tray, TrayCard } from './layout/Tray.jsx';
import { STATUS } from '../lib/palette.js';

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
  const toneColor = health.state === 'no-data' ? STATUS.neutral.color
    : adverse == null || Math.abs(adverse) < 1 ? STATUS.neutral.text
    : adverse < 0 ? STATUS.critical.text : STATUS.good.text;
  const delta = deltaLabel(change, metric);

  return (
    <button
      type="button"
      onClick={() => onSelect(metric.metric_key)}
      aria-pressed={selected}
      className={`text-left rounded-card p-4 transition cursor-pointer w-full ${selected ? 'bg-primary-tint' : 'bg-white hover:bg-muted'}`}
      style={{ boxShadow: selected ? '0 0 0 1px var(--primary), 0 0 0 4px var(--primary-tint)' : 'var(--ring)' }}
    >
      <div className="flex items-start justify-between gap-x-2 gap-y-1 flex-wrap">
        <div className="text-[13px] leading-snug text-text min-w-0 break-words">{metric.display_name}</div>
        <Badge tone={meta.tone} className="shrink-0">{meta.label}</Badge>
      </div>

      {health.state === 'no-data' ? (
        <>
          <div className="text-[20px] font-medium tracking-[-0.02em] text-faint tnum mt-1.5">
            {metric.latest_value != null ? formatByUnit(metric.latest_value, metric.unit) : '—'}
          </div>
          <p className="text-xs text-faint mt-1 leading-snug">
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
                <span className="text-[20px] font-medium tracking-[-0.02em] text-fg tnum">
                  {formatByUnit(change.baseline, metric.unit)}
                </span>
                <span className="text-faint-2 text-sm">→</span>
              </>
            )}
            <span className={`text-[20px] font-medium tracking-[-0.02em] tnum ${change.baseline != null ? 'text-text' : 'text-fg'}`}>
              {formatByUnit(change.endValue, metric.unit)}
            </span>
          </div>
          <div className="flex items-center gap-1.5 mt-1 flex-wrap">
            <span className="flex items-center gap-1 text-xs font-medium" style={{ color: toneColor }}>
              <Icon size={12} />
              {delta || `in ${change.horizon}${horizonUnit(metric)}`}
            </span>
            {delta && (
              <span className="text-xs text-faint">
                projected · {change.horizon}{horizonUnit(metric)}
              </span>
            )}
          </div>
        </>
      )}
    </button>
  );
}

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

  const statusBadges = (
    <>
      <Badge tone={atRisk.length ? 'red' : watching.length ? 'amber' : 'green'}>{headline}</Badge>
      {soonest != null && (
        <Badge tone="grey"><Clock size={11} />soonest {daysLabel(soonest)}</Badge>
      )}
    </>
  );

  return (
    <Tray>
      <TrayCard
        title="Growth outlook"
        subtitle="Where the site is heading over the next two weeks — site-wide, not per page"
        action={<div className="hidden lg:flex items-center justify-end gap-2 flex-wrap">{statusBadges}</div>}
      >
        <div className="px-4 pb-4">
          {/* Below lg the header has no room beside the title, so the status
              badges move into the body (same content, shown once either way). */}
          <div className="lg:hidden flex items-center gap-2 flex-wrap pb-3">{statusBadges}</div>
          {tiles.length === 0 ? (
            <p className="text-[13px] text-text bg-muted rounded-card px-4 py-3">
              No forecastable metrics for this client yet. Tiles appear here once Search Console data has
              been collected and the nightly models have run.
            </p>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
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
        </div>

        {/* The forecast made visible. Past, today and the projected band in one
            picture — the thing a reader can understand without parsing "-12%". */}
        {selectedMetricKey && metrics.length > 0 && (
          <AnalystTrendCard
            clientId={clientId}
            metrics={metrics}
            selectedMetricKey={selectedMetricKey}
            onSelectMetric={setSelectedMetricKey}
            // The tiles above already pick the metric; keep the dropdown only for
            // metrics that have no tile of their own.
            showMetricPicker={metrics.length > tiles.length}
            insights={insights}
          />
        )}
      </TrayCard>
    </Tray>
  );
}
