"""On-demand statistical diagnostics for a single (client, metric) — Phase 2
Stage 3. Distinct from feature_importance.py/root_cause.py: nothing here is
a "run" another engine reads back later, so there's no persistence and no
nightly-pipeline stage. Each function is O(n) or O(n log n) over a single
metric's own series (already the cost class of dashboard.py's per-metric
loop, never a model fit) and reports 'insufficient-data' rather than a
fabricated number when the series is too short or too sparse — same
discipline as feature_importance.py and root_cause.py."""
import math
from dataclasses import dataclass, field
from datetime import date

import numpy as np
import pandas as pd
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import ForecastPoint, ForecastRun, MetricCatalog, MetricObservation

VOLATILITY_WINDOW_DAYS = 28
MIN_VOLATILITY_OBSERVATIONS = 14
STL_PERIOD_DAYS = 7
MIN_STL_OBSERVATIONS = 2 * STL_PERIOD_DAYS
MIN_BACKTEST_POINTS = 3


@dataclass
class DiagnosticResult:
    status: str  # 'ok' | 'insufficient-data'
    value: float | None
    detail: dict = field(default_factory=dict)


async def _site_series(session: AsyncSession, client_id: int, metric_key: str) -> pd.Series:
    rows = (
        await session.execute(
            select(MetricObservation.period_start, MetricObservation.value).where(
                MetricObservation.client_id == client_id, MetricObservation.metric_key == metric_key,
                MetricObservation.dimension_type == "site", MetricObservation.dimension_value == "__site__",
            ).order_by(MetricObservation.period_start)
        )
    ).all()
    df = pd.DataFrame(rows, columns=["period_start", "value"]).dropna()
    if df.empty:
        return pd.Series(dtype=float)
    df["value"] = df["value"].astype(float)
    return pd.Series(df["value"].values, index=pd.DatetimeIndex(df["period_start"]))


def _is_contiguous(series: pd.Series) -> bool:
    return len(series) > 1 and (series.index[-1] - series.index[0]).days == len(series) - 1


async def compute_volatility(
    session: AsyncSession, *, client_id: int, metric_key: str, window_days: int = VOLATILITY_WINDOW_DAYS,
) -> DiagnosticResult:
    """Rolling coefficient of variation (std/mean) over the trailing
    window — a real, standard dispersion measure, not a fabricated score."""
    series = await _site_series(session, client_id, metric_key)
    if series.empty:
        return DiagnosticResult(status="insufficient-data", value=None, detail={"reason": "no observations"})

    window = series.tail(window_days)
    n = len(window)
    if n < MIN_VOLATILITY_OBSERVATIONS:
        return DiagnosticResult(
            status="insufficient-data", value=None,
            detail={"window_days": window_days, "n_observations": n, "reason": f"need >= {MIN_VOLATILITY_OBSERVATIONS} observations in window"},
        )
    mean = float(window.mean())
    if mean == 0:
        return DiagnosticResult(status="insufficient-data", value=None, detail={"window_days": window_days, "n_observations": n, "reason": "mean is zero"})
    cv = float(window.std(ddof=0)) / abs(mean)
    return DiagnosticResult(status="ok", value=cv, detail={"window_days": window_days, "n_observations": n})


def _stl_strength(series: pd.Series, component: str) -> DiagnosticResult:
    """Hyndman & Athanasopoulos trend/seasonality strength:
    max(0, 1 - Var(remainder) / Var(component + remainder)). Requires a
    contiguous daily series (a gap would misalign the fixed 7-day period)
    with at least two full periods of history — same never-fabricate
    threshold discipline as feature_importance.py's MIN_OBSERVATIONS_FOR_MODEL."""
    if len(series) < MIN_STL_OBSERVATIONS:
        return DiagnosticResult(
            status="insufficient-data", value=None,
            detail={"n_observations": len(series), "reason": f"need >= {MIN_STL_OBSERVATIONS} observations (2 full weekly periods)"},
        )
    if not _is_contiguous(series):
        return DiagnosticResult(status="insufficient-data", value=None, detail={"reason": "gaps in daily series prevent seasonal decomposition"})

    from statsmodels.tsa.seasonal import STL

    try:
        result = STL(series.values, period=STL_PERIOD_DAYS, robust=True).fit()
    except Exception as e:  # noqa: BLE001 — any statsmodels failure reports honestly, never fabricates
        return DiagnosticResult(status="insufficient-data", value=None, detail={"reason": str(e)})

    remainder_var = float(np.var(result.resid))
    component_series = result.trend if component == "trend" else result.seasonal
    denom = float(np.var(component_series + result.resid))
    if denom == 0 or math.isnan(denom):
        return DiagnosticResult(status="insufficient-data", value=None, detail={"reason": "degenerate decomposition (zero variance)"})
    strength = max(0.0, 1.0 - remainder_var / denom)
    return DiagnosticResult(status="ok", value=strength, detail={"n_observations": len(series), "period_days": STL_PERIOD_DAYS})


async def compute_trend_strength(session: AsyncSession, *, client_id: int, metric_key: str) -> DiagnosticResult:
    metric = await session.get(MetricCatalog, metric_key)
    if metric is None or metric.cadence != "daily":
        return DiagnosticResult(status="insufficient-data", value=None, detail={"reason": "cadence != daily"})
    series = await _site_series(session, client_id, metric_key)
    return _stl_strength(series, "trend")


async def compute_seasonality_strength(session: AsyncSession, *, client_id: int, metric_key: str) -> DiagnosticResult:
    metric = await session.get(MetricCatalog, metric_key)
    if metric is None or metric.cadence != "daily":
        return DiagnosticResult(status="insufficient-data", value=None, detail={"reason": "cadence != daily"})
    series = await _site_series(session, client_id, metric_key)
    return _stl_strength(series, "seasonal")


async def _forecast_backtest_pairs(session: AsyncSession, *, client_id: int, metric_key: str) -> tuple[list[float], list[float], str | None]:
    """Shared backtest population for compute_prediction_error (MAPE/RMSE)
    and compute_r_squared: every past forecast_points row (across every
    historical forecast_run — forecast_runs is INSERT-only, so this
    genuinely accumulates over nightly cycles) whose target_period is now
    in the past, paired with the realized metric_observations value for
    that same day. Both diagnostics summarize this exact same population,
    just with different statistics — never two different samples silently
    disagreeing about what was backtested. Returns (actuals, predicted,
    reason) — reason is set only when the pair lists come back short/empty,
    so callers can report an honest insufficient-data detail."""
    today = date.today()
    run_rows = (
        await session.execute(
            select(ForecastRun.id).where(
                ForecastRun.client_id == client_id, ForecastRun.metric_key == metric_key,
                ForecastRun.dimension_type == "site", ForecastRun.dimension_value == "__site__",
                ForecastRun.status == "ok",
            )
        )
    ).scalars().all()
    if not run_rows:
        return [], [], "no forecast runs yet"

    point_rows = (
        await session.execute(
            select(ForecastPoint.target_period, ForecastPoint.point_estimate).where(
                ForecastPoint.forecast_run_id.in_(run_rows), ForecastPoint.target_period <= today,
            )
        )
    ).all()
    if len(point_rows) < MIN_BACKTEST_POINTS:
        return [], [], f"need >= {MIN_BACKTEST_POINTS} past-dated forecast points"

    target_dates = [p[0] for p in point_rows]
    actual_rows = dict((
        await session.execute(
            select(MetricObservation.period_start, MetricObservation.value).where(
                MetricObservation.client_id == client_id, MetricObservation.metric_key == metric_key,
                MetricObservation.dimension_type == "site", MetricObservation.dimension_value == "__site__",
                MetricObservation.period_start.in_(target_dates),
            )
        )
    ).all())

    actuals, predicted = [], []
    for target_period, point_estimate in point_rows:
        actual = actual_rows.get(target_period)
        if actual is None or point_estimate is None:
            continue
        actuals.append(float(actual))
        predicted.append(float(point_estimate))

    if len(actuals) < MIN_BACKTEST_POINTS:
        return actuals, predicted, "not enough of the forecasted days have realized observations yet"
    return actuals, predicted, None


async def compute_prediction_error(session: AsyncSession, *, client_id: int, metric_key: str) -> DiagnosticResult:
    """MAPE/RMSE over the shared forecast backtest population — see
    _forecast_backtest_pairs."""
    actuals, predicted, reason = await _forecast_backtest_pairs(session, client_id=client_id, metric_key=metric_key)
    if reason is not None:
        return DiagnosticResult(status="insufficient-data", value=None, detail={"n_backtestable_points": len(actuals), "reason": reason})

    actual_arr, pred_arr = np.array(actuals), np.array(predicted)
    sq_errors = (actual_arr - pred_arr) ** 2
    nonzero = actual_arr != 0
    mape = float(np.mean(np.abs(actual_arr[nonzero] - pred_arr[nonzero]) / np.abs(actual_arr[nonzero]))) if nonzero.any() else None
    rmse = float(np.sqrt(np.mean(sq_errors)))
    return DiagnosticResult(
        status="ok", value=mape,
        detail={"mape": mape, "rmse": rmse, "n_backtested_points": len(actuals)},
    )


async def compute_r_squared(session: AsyncSession, *, client_id: int, metric_key: str) -> DiagnosticResult:
    """Forecast backtest R² (coefficient of determination): 1 - SS_res/SS_tot
    over the same realized actual-vs-predicted pairs compute_prediction_error
    backtests — a real out-of-sample fit-quality measure, deliberately the
    same population as MAPE/RMSE so the two diagnostics describe one
    backtest from two angles, not two different samples. Reports honestly
    when the realized values have zero variance (SS_tot == 0) rather than
    dividing by zero, and is never clamped to [0, 1] — a forecast worse than
    predicting the mean legitimately scores negative, and clamping it would
    hide that from the reader."""
    actuals, predicted, reason = await _forecast_backtest_pairs(session, client_id=client_id, metric_key=metric_key)
    if reason is not None:
        return DiagnosticResult(status="insufficient-data", value=None, detail={"n_backtestable_points": len(actuals), "reason": reason})

    actual_arr, pred_arr = np.array(actuals), np.array(predicted)
    ss_res = float(np.sum((actual_arr - pred_arr) ** 2))
    ss_tot = float(np.sum((actual_arr - actual_arr.mean()) ** 2))
    if ss_tot == 0:
        return DiagnosticResult(
            status="insufficient-data", value=None,
            detail={"n_backtested_points": len(actuals), "reason": "no variance in realized values over the backtest window"},
        )
    return DiagnosticResult(status="ok", value=1.0 - (ss_res / ss_tot), detail={"n_backtested_points": len(actuals)})


async def compute_all_diagnostics(session: AsyncSession, *, client_id: int, metric_key: str) -> dict:
    """Single call site bundling all diagnostics for one metric — used by
    the /diagnostics/{metric_key} route so the frontend makes one call."""
    return {
        "volatility": await compute_volatility(session, client_id=client_id, metric_key=metric_key),
        "trend_strength": await compute_trend_strength(session, client_id=client_id, metric_key=metric_key),
        "seasonality_strength": await compute_seasonality_strength(session, client_id=client_id, metric_key=metric_key),
        "prediction_error": await compute_prediction_error(session, client_id=client_id, metric_key=metric_key),
        "r_squared": await compute_r_squared(session, client_id=client_id, metric_key=metric_key),
    }
