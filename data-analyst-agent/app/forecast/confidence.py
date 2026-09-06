"""Forecast confidence scoring — Phase 2 Stage 3. Wired into
app/forecast/run.py::_forecast_one right after a successful forecast run
persists; needs app/stats/diagnostics.py's backtest (which only has real
signal once a PRIOR nightly cycle's forecast_points have target dates that
are now in the past), so this is nightly-persisted as a byproduct of each
run, not computed on-demand at request time.

Dimension-aware (Prompt 8 Option A: page as a first-class forecasting
dimension) — app/stats/diagnostics.py's backtest is scoped to the SAME
(dimension_type, dimension_value) as the forecast_run being scored, passed
through explicitly below, so a page/channel/device forecast is backtested
against its own realized series, never borrowing the site series' error.
Previously this was a hard site-only restriction (the caller in
forecast/run.py only invoked this for dimension_type == 'site' runs)
because the backtest itself was hardcoded to site — now that the backtest
takes a real dimension filter, every dimension gets its own real
confidence score instead of a null placeholder."""
import pandas as pd
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.db.models import ForecastRun
from app.forecast.accuracy import get_rolling_accuracy
from app.forecast.daily import SARIMAX_MIN_HISTORY_DAYS
from app.investigations.outcome import get_investigation_outcome_reliability
from app.scoring.confidence import ConfidenceResult, compute_confidence
from app.stats.diagnostics import compute_prediction_error

# The history length a forecast for this cadence would ideally have, used as
# the historical_coverage denominator. For weekly/monthly this is the same
# threshold the forecaster itself requires just to attempt a fit (see
# forecast/weekly.py, forecast/monthly.py) — coverage is trivially >= 1.0
# once a forecast succeeds at all for those cadences, a weaker signal than
# daily's real SARIMAX threshold, but never a fabricated one.
IDEAL_HISTORY_PERIODS = {
    "daily": SARIMAX_MIN_HISTORY_DAYS,
    "weekly": settings.min_history_weeks_for_forecast,
    "monthly": settings.min_history_months_for_forecast,
}


async def compute_forecast_confidence(
    session: AsyncSession, *, client_id: int, forecast_run: ForecastRun, series: pd.Series,
) -> tuple[int, ConfidenceResult]:
    """Only call this for a run whose status == 'ok' — nothing to score
    confidence on for an insufficient-data/error run."""
    n = len(series)
    ideal = IDEAL_HISTORY_PERIODS.get(forecast_run.cadence)
    historical_coverage = min(n / ideal, 1.0) if ideal else None

    data_completeness = None
    if n > 1:
        span_days = (series.index[-1] - series.index[0]).days
        if span_days > 0:
            data_completeness = min(n / (span_days + 1), 1.0)

    error = await compute_prediction_error(
        session, client_id=client_id, metric_key=forecast_run.metric_key,
        dimension_type=forecast_run.dimension_type, dimension_value=forecast_run.dimension_value,
    )
    model_certainty = max(0.0, 1.0 - min(error.value, 1.0)) if error.status == "ok" and error.value is not None else None

    # Phase 4 (prediction -> outcome -> learning loop): this metric's own
    # real track record of past forecast_points vs what actually landed
    # (app/forecast/accuracy.py — previously computed nightly but never
    # read by anything, per that module's own "not yet wired into
    # prioritizer.py/opportunity_scoring.py" note). Distinct from
    # model_certainty above, which is an in-sample backtest error, not a
    # real-world track record. None (never a fabricated 0) below
    # MIN_EVALUATED_POINTS_FOR_SIGNAL — a metric with no evaluated history
    # yet gets no opinion from this factor rather than a penalized one.
    rolling_accuracy = await get_rolling_accuracy(
        session, client_id, forecast_run.metric_key,
        dimension_type=forecast_run.dimension_type, dimension_value=forecast_run.dimension_value,
    )
    historical_forecast_accuracy = (
        max(0.0, 1.0 - min(rolling_accuracy["avg_abs_pct_error"] / 100, 1.0))
        if rolling_accuracy["status"] == "ok" else None
    )

    # Phase 4 (prediction -> outcome -> learning loop), same pattern as
    # historical_forecast_accuracy just above but sourced from approved
    # forecast_risk Investigations that were followed through on rather than
    # every raw forecast point (see app/investigations/outcome.py). Site-
    # wide, not per-metric — approved forecast_risk investigations are too
    # rare for a per-metric breakdown to ever clear
    # MIN_EVALUATED_OUTCOMES_FOR_SIGNAL.
    outcome_reliability = await get_investigation_outcome_reliability(session, client_id)
    investigation_outcome_reliability = (
        outcome_reliability["reliability"] if outcome_reliability["status"] == "ok" else None
    )

    return await compute_confidence(
        session, client_id=client_id, subject_type="forecast_confidence", subject_id=forecast_run.id,
        components={
            "data_completeness": data_completeness,
            "historical_coverage": historical_coverage,
            "statistical_significance": None,  # no hypothesis test here — see model_certainty instead
            "model_certainty": model_certainty,
            "anomaly_strength": None,  # not applicable to this engine
            "historical_forecast_accuracy": historical_forecast_accuracy,
            "investigation_outcome_reliability": investigation_outcome_reliability,
        },
    )
