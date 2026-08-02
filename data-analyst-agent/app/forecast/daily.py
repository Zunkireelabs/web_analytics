import math
from datetime import timedelta

import pandas as pd

from app.config import settings
from app.forecast.base import ForecastModel, ForecastPointResult, ForecastResult

SARIMAX_MIN_HISTORY_DAYS = 90
SEASONAL_MIN_HISTORY_DAYS = 14  # need >= 2 full weekly cycles before trying a seasonal component


class DailyForecaster(ForecastModel):
    min_history_periods = settings.min_history_days_for_forecast

    def fit_predict(self, series: pd.Series, horizon: int) -> ForecastResult:
        if len(series) < self.min_history_periods:
            return ForecastResult(status="insufficient-data")

        if len(series) >= SARIMAX_MIN_HISTORY_DAYS:
            result = self._try_sarimax(series, horizon)
            if result is not None and self._is_sane(series, result):
                return result
            # SARIMAX failed to converge, or converged onto a degenerate fit
            # (e.g. an absurd variance estimate on a noisy low-magnitude
            # series) — fall back to ETS rather than reporting garbage
            # confidence intervals as if they were trustworthy.

        result = self._try_ets(series, horizon)
        if result.status == "ok" and not self._is_sane(series, result):
            return ForecastResult(status="error", error="forecast confidence interval was implausibly wide relative to observed history")
        return result

    def _try_ets(self, series: pd.Series, horizon: int) -> ForecastResult:
        from statsmodels.tsa.exponential_smoothing.ets import ETSModel

        seasonal = len(series) >= SEASONAL_MIN_HISTORY_DAYS
        try:
            model = ETSModel(
                series, error="add", trend="add",
                seasonal="add" if seasonal else None,
                seasonal_periods=7 if seasonal else None,
            )
            fit = model.fit(disp=False)
            pred = fit.get_prediction(start=len(series), end=len(series) + horizon - 1)
            frame = pred.summary_frame(alpha=0.05)
        except Exception as e:  # noqa: BLE001 — any statsmodels failure reports honestly, never fabricates
            return ForecastResult(status="error", error=str(e))

        points = self._points_from_frame(series, frame, "mean", "pi_lower", "pi_upper")
        return ForecastResult(status="ok", model="ets", params={"seasonal": seasonal}, points=points)

    def _try_sarimax(self, series: pd.Series, horizon: int) -> ForecastResult | None:
        from statsmodels.tsa.statespace.sarimax import SARIMAX

        try:
            model = SARIMAX(series, order=(1, 1, 1), seasonal_order=(1, 1, 1, 7),
                             enforce_stationarity=False, enforce_invertibility=False)
            fit = model.fit(disp=False)
            forecast = fit.get_forecast(horizon)
            frame = forecast.summary_frame(alpha=0.05)
        except Exception:
            return None

        points = self._points_from_frame(series, frame, "mean", "mean_ci_lower", "mean_ci_upper")
        return ForecastResult(status="ok", model="sarimax", params={"order": [1, 1, 1], "seasonal_order": [1, 1, 1, 7]}, points=points)

    @staticmethod
    def _is_sane(series: pd.Series, result: ForecastResult) -> bool:
        """Reject a fit that's numerically broken in either of two ways
        seen in practice on this service's real data:
        (a) non-convergence producing a wildly inflated variance (small
            noisy series like daily conversion counts), or
        (b) NaN/Inf bounds at specific points — observed on a near-perfectly
            deterministic series, where SARIMAX's seasonal confidence-interval
            computation hit a singularity at exact multiples of the seasonal
            period. NaN comparisons are always False in Python, so a naive
            magnitude check alone would silently let these through."""
        if not result.points:
            return False
        for p in result.points:
            values = (p.point_estimate, p.lower_bound, p.upper_bound)
            if any(math.isnan(v) or math.isinf(v) for v in values):
                return False
        historical_scale = max(float(series.abs().max()), 1.0)
        widest = max(p.upper_bound - p.lower_bound for p in result.points)
        return widest <= historical_scale * 1000

    @staticmethod
    def _points_from_frame(series: pd.Series, frame: pd.DataFrame, mean_col: str, lo_col: str, hi_col: str) -> list[ForecastPointResult]:
        last_date = series.index[-1]
        points = []
        for i, (_, row) in enumerate(frame.iterrows(), start=1):
            points.append(ForecastPointResult(
                target_period=last_date + timedelta(days=i),
                point_estimate=float(row[mean_col]),
                lower_bound=float(row[lo_col]),
                upper_bound=float(row[hi_col]),
            ))
        return points
