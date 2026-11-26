"""Forecasts must be possible values, built from a real series.

Two defects the production audit measured, both fixed here:

1. Impossible forecasts. Nothing bounded a forecast: one daily `ga4_avg_engagement_time` forecast predicted -129.3 seconds, and
   count/ratio models can extend below 0 or above 1 at the edges of their intervals. Every metric has a unit in metrics_catalog
   (count, seconds, ratio, score_0_100, rank), and the unit says what values exist. Points and intervals are clipped to that range,
   the clipping is counted in the run's params, and a forecast whose POINT estimate had to be clipped is flagged so nobody reads a
   clipped number as the model's own opinion.

2. ~13,800 daily forecast runs failing with "No supported index is available." The runner (rightly) refuses to invent days that
   have no observation, so a series with even one missing day was handed to statsmodels without a frequency, and statsmodels
   refuses a daily model on an irregular index. A series with a gap is not unusable; its latest UNBROKEN run is a real series (the
   same rule app/predict/series.py already applies to page data). The forecast now uses that run when it is long enough, and
   otherwise reports insufficient-data with the real reason (how long the unbroken run is and what is needed), which is a data
   statement, not a defect."""
from __future__ import annotations

import pandas as pd

from app.forecast.base import ForecastResult

# unit -> (lowest possible value, highest possible value); None = unbounded on that side.
RANGE_BY_UNIT: dict[str, tuple[float | None, float | None]] = {
    "count": (0.0, None),
    "seconds": (0.0, None),
    "ratio": (0.0, 1.0),
    "score_0_100": (0.0, 100.0),
    "rank": (1.0, None),   # position 1 is the best there is
}


def range_for_unit(unit: str | None) -> tuple[float | None, float | None] | None:
    return RANGE_BY_UNIT.get(unit or "")


def _clip(value: float, lo: float | None, hi: float | None) -> float:
    if lo is not None and value < lo:
        return lo
    if hi is not None and value > hi:
        return hi
    return value


def clip_result(result: ForecastResult, unit: str | None) -> ForecastResult:
    """Clip every point and interval of an ok forecast to the unit's valid range, in place. Records `clipped_points` (points whose
    estimate itself moved) and `clipped_bounds` (interval ends that moved) in params. An unknown unit is left alone: no range is
    invented for it."""
    bounds = range_for_unit(unit)
    if bounds is None or result.status != "ok" or not result.points:
        return result
    lo, hi = bounds
    clipped_points = clipped_bounds = 0
    for p in result.points:
        new_estimate = _clip(p.point_estimate, lo, hi)
        if new_estimate != p.point_estimate:
            clipped_points += 1
        new_low, new_high = _clip(p.lower_bound, lo, hi), _clip(p.upper_bound, lo, hi)
        if new_low != p.lower_bound or new_high != p.upper_bound:
            clipped_bounds += 1
        p.point_estimate = new_estimate
        # Clipping each end independently can leave the estimate outside an interval that was already entirely out of range.
        p.lower_bound = min(new_low, new_estimate)
        p.upper_bound = max(new_high, new_estimate)
    params = dict(result.params or {})
    params.update(valid_range=[lo, hi], unit=unit, clipped_points=clipped_points, clipped_bounds=clipped_bounds)
    result.params = params
    return result


def trailing_contiguous_daily(series: pd.Series) -> tuple[pd.Series, int]:
    """(the latest unbroken daily run, how many earlier observations were set aside). An empty or contiguous series comes back
    unchanged; the result has an explicit daily frequency whenever it has more than one point."""
    if series.empty:
        return series, 0
    index = pd.DatetimeIndex(series.index)
    gaps = index.to_series().diff().dt.days.fillna(1).values > 1
    start = int(max((i for i, g in enumerate(gaps) if g), default=-1) + 1) if gaps.any() else 0
    run = series.iloc[start:]
    if len(run) > 1:
        run = run.asfreq("D")
    return run, start


def gap_reason(total: int, run_length: int, needed: int) -> str:
    return (
        f"the daily series has gaps; its latest unbroken run is {run_length} day(s) of {total} observed and a forecast needs {needed}"
    )
