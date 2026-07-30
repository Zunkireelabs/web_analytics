"""Anomaly Engine — z-score and IQR over each metric's own daily
metric_observations series (site-level, cadence='daily' only in v1).
Flags only the most recent day against a trailing baseline window — this
runs nightly, so there is no need to re-flag history every run."""
import pandas as pd
from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.db.models import Anomaly, Client, MetricCatalog, MetricDimensionSupport, MetricObservation
from app.db.session import SessionLocal

BASELINE_WINDOW = 30
MIN_BASELINE_PERIODS = 7


async def run_anomaly_detection() -> None:
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
                    MetricCatalog.supports_anomaly_detection.is_(True), MetricCatalog.cadence == "daily",
                )
            )
        ).scalars().all()

    for client in clients:
        for metric in metrics:
            async with SessionLocal() as session:
                await _detect_for_metric(session, client.id, metric.metric_key)
                await session.commit()


async def _detect_for_metric(session: AsyncSession, client_id: int, metric_key: str) -> None:
    rows = (
        await session.execute(
            select(MetricObservation.period_start, MetricObservation.value)
            .where(
                MetricObservation.client_id == client_id, MetricObservation.metric_key == metric_key,
                MetricObservation.dimension_type == "site", MetricObservation.dimension_value == "__site__",
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
            client_id=client_id, metric_key=metric_key, dimension_type="site", dimension_value="__site__",
            period_start=latest_date, value=latest_value, method=method, score=float(score),
            threshold_used=threshold, direction=direction,
        )
        stmt = stmt.on_conflict_do_update(
            index_elements=["client_id", "metric_key", "dimension_type", "dimension_value", "period_start", "method"],
            set_={"score": stmt.excluded.score, "value": stmt.excluded.value, "direction": stmt.excluded.direction},
        )
        await session.execute(stmt)
