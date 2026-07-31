import math

import pandas as pd
from dateutil.relativedelta import relativedelta

from app.config import settings
from app.forecast.base import ForecastModel, ForecastPointResult, ForecastResult

# SARIMAX/seasonal-naive need far more periods than a real monthly-cadence
# metric will have for a long while (a full seasonal cycle alone is 12
# points). Naive-with-drift is the honest choice for sparse monthly data:
# a straight-line extrapolation of the recent trend, with an uncertainty
# band that widens with sqrt(horizon) and is derived from the metric's own
# real month-over-month volatility — never a fabricated tight interval on
# 3-4 data points.
DRIFT_WINDOW = 6


class MonthlyForecaster(ForecastModel):
    min_history_periods = settings.min_history_months_for_forecast

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
                target_period=last_date + relativedelta(months=i),
                point_estimate=point_estimate,
                lower_bound=point_estimate - margin,
                upper_bound=point_estimate + margin,
            ))

        return ForecastResult(status="ok", model="naive_drift", params={"drift_window": DRIFT_WINDOW}, points=points)
