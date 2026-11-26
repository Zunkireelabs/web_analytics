import pandas as pd
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.db.dimension_lookup import dimension_values_for, iter_enabled_metric_dimensions
from app.db.models import Client, ForecastPoint, ForecastRun, MetricCatalog, MetricObservation
from app.db.session import SessionLocal
from app.forecast.confidence import compute_forecast_confidence
from app.forecast.registry import FORECASTERS
from app.forecast.validity import clip_result, gap_reason, trailing_contiguous_daily
from app.analysis.scope import active_clients

HORIZON_BY_CADENCE = {
    "daily": settings.forecast_horizon_days,
    "weekly": settings.forecast_horizon_weeks,
    "monthly": settings.forecast_horizon_months,
}


async def run_forecasts() -> None:
    async with SessionLocal() as session:
        clients = await active_clients(session)
        metric_dims = await iter_enabled_metric_dimensions(session, forecastable_only=True)

    for client in clients:
        for md in metric_dims:
            forecaster = FORECASTERS.get(md.metric.cadence)
            horizon = HORIZON_BY_CADENCE.get(md.metric.cadence)
            if forecaster is None or horizon is None:
                continue  # this cadence has no registered forecaster yet — documented extension point
            async with SessionLocal() as session:
                dim_values = await dimension_values_for(session, client.id, md.metric.metric_key, md.dimension_type)
            for dim_value in dim_values:
                async with SessionLocal() as session:
                    await _forecast_one(session, client.id, md.metric, md.dimension_type, dim_value, forecaster, horizon)
                    await session.commit()


async def _forecast_one(session: AsyncSession, client_id: int, metric: MetricCatalog, dimension_type: str, dimension_value: str, forecaster, horizon: int) -> None:
    rows = (
        await session.execute(
            select(MetricObservation.period_start, MetricObservation.value)
            .where(
                MetricObservation.client_id == client_id, MetricObservation.metric_key == metric.metric_key,
                MetricObservation.dimension_type == dimension_type, MetricObservation.dimension_value == dimension_value,
            )
            .order_by(MetricObservation.period_start)
        )
    ).all()

    df = pd.DataFrame(rows, columns=["period_start", "value"]).dropna()
    series = pd.Series(dtype=float)
    set_aside = 0
    total_observed = len(df)
    if len(df):
        index = pd.DatetimeIndex(df["period_start"])
        series = pd.Series(df["value"].astype(float).values, index=index)
        if metric.cadence == "daily":
            # Never reindex or fill across a gap (that would invent values for days with no observation). A series with a gap
            # forecasts from its latest UNBROKEN run (app/forecast/validity.py); statsmodels refuses a daily model on an
            # irregular index, which is what produced ~13,800 "No supported index is available." errors.
            series, set_aside = trailing_contiguous_daily(series)

    result = forecaster.fit_predict(series, horizon)
    if result.status == "insufficient-data" and set_aside:
        # The history is short BECAUSE of a gap: say so, instead of an unexplained insufficient-data.
        result.error = gap_reason(total_observed, len(series), getattr(forecaster, "min_history_periods", len(series) + 1))
    if result.status == "ok" and set_aside:
        result.params = {**(result.params or {}), "observations_set_aside_before_gap": set_aside}
    clip_result(result, metric.unit)

    run = ForecastRun(
        client_id=client_id, metric_key=metric.metric_key, dimension_type=dimension_type, dimension_value=dimension_value,
        cadence=metric.cadence, model=result.model or "none", horizon_periods=horizon,
        status=result.status, params=result.params, error=result.error,
    )
    session.add(run)
    await session.flush()  # need run.id before inserting points

    if result.status == "ok" and result.points:
        for p in result.points:
            session.add(ForecastPoint(
                forecast_run_id=run.id, target_period=p.target_period.date() if hasattr(p.target_period, "date") else p.target_period,
                point_estimate=p.point_estimate, lower_bound=p.lower_bound, upper_bound=p.upper_bound,
            ))

    # Dimension-aware (Prompt 8 Option A): compute_forecast_confidence now
    # backtests against this SAME (dimension_type, dimension_value)'s own
    # forecast history (see app/stats/diagnostics.py's dimension-scoped
    # _forecast_backtest_pairs) — no longer a site-only computation, so
    # every enabled dimension (site/channel/device/page) gets a real
    # confidence score instead of a null placeholder once it has enough
    # backtest history of its own.
    if result.status == "ok":
        confidence_id, confidence = await compute_forecast_confidence(
            session, client_id=client_id, forecast_run=run, series=series,
        )
        run.confidence_score_id = confidence_id
        run.confidence = confidence.score
