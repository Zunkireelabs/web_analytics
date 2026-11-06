// Which way is "worse" for a metric: THE one place the app decides it (mirrors data-analyst-agent/app/metrics/direction.py).
//
// For almost every metric a fall is bad. Search POSITION is the opposite: position 1 is the top, so a higher number is a worse
// ranking. 3 -> 2 is an improvement, 3 -> 3 is unchanged, 3 -> 8 and 8 -> 15 are declines. Decline checks used to test
// `pct_change < 0` / `direction === 'low'` directly, which made every position decline invisible.

export const LOWER_IS_BETTER_METRICS = new Set(['gsc_position']);

export const lowerIsBetter = (metricKey) => LOWER_IS_BETTER_METRICS.has(metricKey);

// `change` is current minus prior (absolute or percent: only the sign matters). Zero or unknown is never worsening.
export function isWorsening(metricKey, change) {
  if (typeof change !== 'number' || !Number.isFinite(change) || change === 0) return false;
  return lowerIsBetter(metricKey) ? change > 0 : change < 0;
}

// An anomaly's direction is the raw value's ('high' | 'low'). A HIGH position is a worse ranking.
export const anomalyIsWorsening = (metricKey, direction) => direction === (lowerIsBetter(metricKey) ? 'high' : 'low');
