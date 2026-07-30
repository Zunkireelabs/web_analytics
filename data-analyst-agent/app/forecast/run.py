import pandas as pd
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.db.models import Client, ForecastPoint, ForecastRun, MetricCatalog, MetricDimensionSupport, MetricObservation
from app.db.session import SessionLocal
from app.forecast.registry import FORECASTERS


async def run_forecasts() -> None:
    async with SessionLocal() as session:
        clients = (await session.execute(select(Client).where(Client.status == "active"))).scalars().all()
        metrics = (
            await session.execute(
                select(MetricCatalog).join(
                    MetricDimensionSupport,
                    (MetricDimensionSupport.metric_key == MetricCatalog.metric_key)
                    & (MetricDimensionSupport.dimension_type == "site"),
                ).where(
                    MetricCatalog.enabled.is_(True), MetricDimensionSupport.enabled.is_(True),
                    MetricCatalog.is_forecastable.is_(True),
                )
            )
        ).scalars().all()

    for client in clients:
        for metric in metrics:
            forecaster = FORECASTERS.get(metric.cadence)
            if forecaster is None:
                continue  # this cadence has no registered forecaster yet — documented extension point
            async with SessionLocal() as session:
                await _forecast_one(session, client.id, metric, forecaster)
                await session.commit()


async def _forecast_one(session: AsyncSession, client_id: int, metric: MetricCatalog, forecaster) -> None:
    rows = (
        await session.execute(
            select(MetricObservation.period_start, MetricObservation.value)
            .where(
                MetricObservation.client_id == client_id, MetricObservation.metric_key == metric.metric_key,
                MetricObservation.dimension_type == "site", MetricObservation.dimension_value == "__site__",
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

    result = forecaster.fit_predict(series, settings.forecast_horizon_days)

    run = ForecastRun(
        client_id=client_id, metric_key=metric.metric_key, dimension_type="site", dimension_value="__site__",
        cadence=metric.cadence, model=result.model or "none", horizon_periods=settings.forecast_horizon_days,
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
