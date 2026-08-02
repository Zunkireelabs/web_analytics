import math
from datetime import timedelta

import pandas as pd

from app.config import settings
from app.forecast.base import ForecastModel, ForecastPointResult, ForecastResult

# Same naive-drift rationale as monthly.py: a real weekly-cadence metric
# won't have anywhere near the ~104 points (2 full yearly cycles) SARIMAX
# would need for a seasonal fit, so a straight-line extrapolation of recent
# week-over-week drift, with an uncertainty band from the metric's own real
# volatility, is the honest choice rather than a fabricated tight interval.
DRIFT_WINDOW = 8


class WeeklyForecaster(ForecastModel):
    min_history_periods = settings.min_history_weeks_for_forecast

    def fit_predict(self, series: pd.Series, horizon: int) -> ForecastResult:
        if len(series) < self.min_history_periods:
            return ForecastResult(status="insufficient-data")

        deltas = series.diff().dropna().tail(DRIFT_WINDOW)
        avg_drift = float(deltas.mean())
        stdev = float(deltas.std(ddof=0)) if len(deltas) > 1 else abs(avg_drift) * 0.5

        last_value = float(series.iloc[-1])
        last_date = series.index[-1]
        if hasattr(last_date, "date"):
            last_date = last_date.date()

        points = []
        for i in range(1, horizon + 1):
            point_estimate = last_value + i * avg_drift
            margin = 1.96 * stdev * math.sqrt(i)
            points.append(ForecastPointResult(
                target_period=last_date + timedelta(weeks=i),
                point_estimate=point_estimate,
                lower_bound=point_estimate - margin,
                upper_bound=point_estimate + margin,
            ))

        return ForecastResult(status="ok", model="naive_drift", params={"drift_window": DRIFT_WINDOW}, points=points)
