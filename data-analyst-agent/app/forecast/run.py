import pandas as pd
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.db.dimension_lookup import dimension_values_for, iter_enabled_metric_dimensions
from app.db.models import Client, ForecastPoint, ForecastRun, MetricCatalog, MetricObservation
from app.db.session import SessionLocal
from app.forecast.registry import FORECASTERS

HORIZON_BY_CADENCE = {
    "daily": settings.forecast_horizon_days,
    "weekly": settings.forecast_horizon_weeks,
    "monthly": settings.forecast_horizon_months,
}


async def run_forecasts() -> None:
    async with SessionLocal() as session:
        clients = (await session.execute(select(Client).where(Client.status == "active"))).scalars().all()
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
    if len(df):
        index = pd.DatetimeIndex(df["period_start"])
        series = pd.Series(df["value"].astype(float).values, index=index)
        # Only stamp an explicit daily frequency when the series is genuinely
        # contiguous (no real gaps) — a sparse metric (e.g. health_score,
        # which isn't snapshotted every day) must NOT be reindexed/filled to
        # fit a fixed frequency, since that would fabricate values for days
        # with no real observation. Sparse series simply forecast with an
        # unset frequency (statsmodels infers a coarser one, or none).
        if len(index) > 1 and (index[-1] - index[0]).days == len(index) - 1:
            series = series.asfreq("D")
    else:
        series = pd.Series(dtype=float)

    result = forecaster.fit_predict(series, horizon)

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
