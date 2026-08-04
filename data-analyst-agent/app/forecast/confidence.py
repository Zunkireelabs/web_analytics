"""Forecast confidence scoring — Phase 2 Stage 3. Wired into
app/forecast/run.py::_forecast_one right after a successful forecast run
persists; needs app/stats/diagnostics.py's backtest (which only has real
signal once a PRIOR nightly cycle's forecast_points have target dates that
are now in the past), so this is nightly-persisted as a byproduct of each
run, not computed on-demand at request time.

Site-level only, deliberately: app/stats/diagnostics.py's backtest is
site-scoped (matches its one current consumer, the dashboard's per-metric
diagnostics panel). A channel/device-level forecast run would silently
borrow the SITE series' backtest error if this weren't guarded — the
caller in forecast/run.py only invokes this for dimension_type == 'site'
runs; every other dimension's forecast_runs.confidence stays null rather
than reporting a number computed from the wrong series."""
import pandas as pd
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.db.models import ForecastRun
from app.forecast.daily import SARIMAX_MIN_HISTORY_DAYS
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

    error = await compute_prediction_error(session, client_id=client_id, metric_key=forecast_run.metric_key)
    model_certainty = max(0.0, 1.0 - min(error.value, 1.0)) if error.status == "ok" and error.value is not None else None

    return await compute_confidence(
        session, client_id=client_id, subject_type="forecast_confidence", subject_id=forecast_run.id,
        components={
            "data_completeness": data_completeness,
            "historical_coverage": historical_coverage,
            "statistical_significance": None,  # no hypothesis test here — see model_certainty instead
            "model_certainty": model_certainty,
            "anomaly_strength": None,  # not applicable to this engine
        },
    )
