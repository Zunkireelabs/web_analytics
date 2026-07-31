"""Anomaly Engine — z-score and IQR over each metric's own daily
metric_observations series (cadence='daily' only in v1). Dimension-aware:
runs once per (metric, dimension_type, dimension_value) — site-level plus
any other enabled dimension (e.g. channel) discovered from real data. Flags
only the most recent day against a trailing baseline window — this runs
nightly, so there is no need to re-flag history every run."""
import pandas as pd
from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.db.dimension_lookup import dimension_values_for, iter_enabled_metric_dimensions
from app.db.models import Anomaly, Client, MetricObservation
from app.db.session import SessionLocal

BASELINE_WINDOW = 30
MIN_BASELINE_PERIODS = 7


async def run_anomaly_detection() -> None:
    async with SessionLocal() as session:
        clients = (await session.execute(select(Client).where(Client.status == "active"))).scalars().all()
        metric_dims = await iter_enabled_metric_dimensions(session, cadence="daily", anomaly_only=True)

    for client in clients:
        for md in metric_dims:
            async with SessionLocal() as session:
                dim_values = await dimension_values_for(session, client.id, md.metric.metric_key, md.dimension_type)
            for dim_value in dim_values:
                async with SessionLocal() as session:
                    await _detect_for_metric(session, client.id, md.metric.metric_key, md.dimension_type, dim_value)
                    await session.commit()


async def _detect_for_metric(session: AsyncSession, client_id: int, metric_key: str, dimension_type: str, dimension_value: str) -> None:
    rows = (
        await session.execute(
            select(MetricObservation.period_start, MetricObservation.value)
            .where(
                MetricObservation.client_id == client_id, MetricObservation.metric_key == metric_key,
                MetricObservation.dimension_type == dimension_type, MetricObservation.dimension_value == dimension_value,
            )
            .order_by(MetricObservation.period_start)
        )
    ).all()

    df = pd.DataFrame(rows, columns=["period_start", "value"]).dropna()
    if len(df) < MIN_BASELINE_PERIODS + 1:
        return
    df["value"] = df["value"].astype(float)  # asyncpg returns NUMERIC as Decimal; pandas needs float

    latest_date, latest_value = df.iloc[-1]["period_start"], float(df.iloc[-1]["value"])
    baseline = df.iloc[:-1].tail(BASELINE_WINDOW)
    if len(baseline) < MIN_BASELINE_PERIODS:
        return

    flags = []  # (method, score, threshold, direction)

    mean, std = baseline["value"].mean(), baseline["value"].std(ddof=0)
    if std and std > 0:
        z = (latest_value - mean) / std
        if abs(z) > settings.z_score_threshold:
            flags.append(("zscore", z, settings.z_score_threshold, "high" if z > 0 else "low"))

    q1, q3 = baseline["value"].quantile(0.25), baseline["value"].quantile(0.75)
    iqr = q3 - q1
    if iqr and iqr > 0:
        lower, upper = q1 - settings.iqr_multiplier * iqr, q3 + settings.iqr_multiplier * iqr
        if latest_value < lower:
            flags.append(("iqr", (lower - latest_value) / iqr, settings.iqr_multiplier, "low"))
        elif latest_value > upper:
            flags.append(("iqr", (latest_value - upper) / iqr, settings.iqr_multiplier, "high"))

    for method, score, threshold, direction in flags:
        stmt = pg_insert(Anomaly).values(
            client_id=client_id, metric_key=metric_key, dimension_type=dimension_type, dimension_value=dimension_value,
            period_start=latest_date, value=latest_value, method=method, score=float(score),
            threshold_used=threshold, direction=direction,
        )
        stmt = stmt.on_conflict_do_update(
            index_elements=["client_id", "metric_key", "dimension_type", "dimension_value", "period_start", "method"],
            set_={"score": stmt.excluded.score, "value": stmt.excluded.value, "direction": stmt.excluded.direction},
        )
        await session.execute(stmt)
