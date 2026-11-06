"""Which way is "worse" for a metric. THE one place this is decided.

For almost every metric a fall is bad (fewer clicks, fewer sessions). Search POSITION is the opposite: position 1 is the top of the
results, so a higher number is a worse ranking. 3 -> 2 is an improvement, 3 -> 3 is unchanged, 3 -> 8 and 8 -> 15 are declines.

Several decisions used to test "pct_change < 0" or "anomaly direction == low" directly, which silently inverted every position
signal: a ranking that fell from 3 to 8 was never a decline, while one that improved was forecast as a risk and alerted on. Every
decline decision now asks this module.
"""

LOWER_IS_BETTER_METRICS = frozenset({"gsc_position"})


def lower_is_better(metric_key: str) -> bool:
    return metric_key in LOWER_IS_BETTER_METRICS


def is_worsening(metric_key: str, change) -> bool:
    """`change` is current minus prior (absolute or percent: only the sign matters). Zero or unknown is never worsening."""
    if not isinstance(change, (int, float)) or change == 0:
        return False
    return change > 0 if lower_is_better(metric_key) else change < 0


def anomaly_is_worsening(metric_key: str, direction) -> bool:
    """An anomaly's direction is the raw value's: 'high' or 'low'. A high POSITION is a worse ranking."""
    return direction == ("high" if lower_is_better(metric_key) else "low")


def forecast_breaches(metric_key: str, pct_projected_change: float, threshold_pct: float) -> bool:
    """Does a projected change cross the decline threshold in the WORSE direction for this metric?"""
    if lower_is_better(metric_key):
        return pct_projected_change >= threshold_pct
    return pct_projected_change <= -threshold_pct
