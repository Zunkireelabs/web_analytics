"""ONE definition of prediction error, used by every place that scores a prediction against what happened.

Before this there were two. forecast_accuracy stored a PERCENT (|predicted - actual| / |actual| * 100, null when the actual was 0);
prediction_log stored a FRACTION divided by max(actual, 1). The two could not be compared, a value of 0.5 meant 50% in one table
and 0.5% in the other, and the weekly one quietly treated an actual of 0 as 1. Now both are percent and both are undefined (null,
never invented) when the actual is exactly 0: an error relative to nothing has no meaning, and the scorecard counts those rows
separately instead of hiding them."""
from __future__ import annotations


def abs_pct_error(predicted: float, actual: float) -> float | None:
    """|predicted - actual| / |actual| * 100, or None when the actual is 0."""
    actual = float(actual)
    if actual == 0:
        return None
    return abs(float(predicted) - actual) / abs(actual) * 100
