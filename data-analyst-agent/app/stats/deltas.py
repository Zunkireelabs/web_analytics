"""Statistics Engine — WoW/MoM deltas. Rolling windows (7d/30d), not calendar
week/month boundaries, so this works identically regardless of a client's
onboarding date or month length. Every aggregation follows
metrics_catalog.aggregation_strategy — this is the single place the Part A
canonical-formula decision (impression-weighted CTR/position, never a raw
AVG()) gets applied inside this service."""
from datetime import date, timedelta

from sqlalchemy import select, func, text
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import Client, MetricCatalog, MetricDimensionSupport, MetricObservation, MetricPeriodStats
from app.db.session import SessionLocal

WOW_DAYS = 7
MOM_DAYS = 30


async def run_stats() -> None:
    async with SessionLocal() as session:
        clients = (await session.execute(select(Client).where(Client.status == "active"))).scalars().all()
        metrics = (
            await session.execute(
                select(MetricCatalog).join(
                    MetricDimensionSupport,
                    (MetricDimensionSupport.metric_key == MetricCatalog.metric_key)
                    & (MetricDimensionSupport.dimension_type == "site"),
                ).where(MetricCatalog.enabled.is_(True), MetricDimensionSupport.enabled.is_(True))
            )
        ).scalars().all()

    for client in clients:
        for metric in metrics:
            async with SessionLocal() as session:
                await _compute_for_metric(session, client.id, metric)
                await session.commit()


async def _compute_for_metric(session: AsyncSession, client_id: int, metric: MetricCatalog) -> None:
    latest = await session.scalar(
        select(func.max(MetricObservation.period_start)).where(
            MetricObservation.client_id == client_id,
            MetricObservation.metric_key == metric.metric_key,
            MetricObservation.dimension_type == "site",
            MetricObservation.dimension_value == "__site__",
        )
    )
    if latest is None:
        return

    for period_type, span in (("wow", WOW_DAYS), ("mom", MOM_DAYS)):
        period_end = latest
        current = await _aggregate(session, client_id, metric, period_end - timedelta(days=span - 1), period_end)
        prior = await _aggregate(session, client_id, metric, period_end - timedelta(days=2 * span - 1), period_end - timedelta(days=span))
        abs_change = (current - prior) if current is not None and prior is not None else None
        pct_change = (abs_change / prior * 100) if abs_change is not None and prior else None

        stmt = pg_insert(MetricPeriodStats).values(
            client_id=client_id, metric_key=metric.metric_key, dimension_type="site", dimension_value="__site__",
            period_type=period_type, period_end=period_end,
            current_value=current, prior_value=prior, abs_change=abs_change, pct_change=pct_change,
        )
        stmt = stmt.on_conflict_do_update(
            index_elements=["client_id", "metric_key", "dimension_type", "dimension_value", "period_type", "period_end"],
            set_={"current_value": stmt.excluded.current_value, "prior_value": stmt.excluded.prior_value,
                  "abs_change": stmt.excluded.abs_change, "pct_change": stmt.excluded.pct_change},
        )
        await session.execute(stmt)


async def _aggregate(session: AsyncSession, client_id: int, metric: MetricCatalog, start: date, end: date) -> float | None:
    strategy = metric.aggregation_strategy

    if strategy == "last_value":
        val = await session.scalar(
            select(MetricObservation.value).where(
                MetricObservation.client_id == client_id, MetricObservation.metric_key == metric.metric_key,
                MetricObservation.dimension_type == "site", MetricObservation.dimension_value == "__site__",
                MetricObservation.period_start == end,
            )
        )
        return float(val) if val is not None else None

    if strategy == "sum":
        val = await session.scalar(
            select(func.sum(MetricObservation.value)).where(
                MetricObservation.client_id == client_id, MetricObservation.metric_key == metric.metric_key,
                MetricObservation.dimension_type == "site", MetricObservation.dimension_value == "__site__",
                MetricObservation.period_start.between(start, end),
            )
        )
        return float(val) if val is not None else None

    if strategy == "avg":
        val = await session.scalar(
            select(func.avg(MetricObservation.value)).where(
                MetricObservation.client_id == client_id, MetricObservation.metric_key == metric.metric_key,
                MetricObservation.dimension_type == "site", MetricObservation.dimension_value == "__site__",
                MetricObservation.period_start.between(start, end),
            )
        )
        return float(val) if val is not None else None

    if strategy == "weighted_avg":
        if not metric.weight_metric_key:
            return None
        val = await session.scalar(
            text(
                """
                SELECT SUM(m.value * w.value) / NULLIF(SUM(w.value), 0)
                  FROM metric_observations m
                  JOIN metric_observations w
                    ON w.client_id = m.client_id AND w.period_start = m.period_start
                       AND w.metric_key = :weight_key AND w.dimension_type = 'site' AND w.dimension_value = '__site__'
                 WHERE m.client_id = :client_id AND m.metric_key = :metric_key
                   AND m.dimension_type = 'site' AND m.dimension_value = '__site__'
                   AND m.period_start BETWEEN :start AND :end
                """
            ),
            {"weight_key": metric.weight_metric_key, "client_id": client_id, "metric_key": metric.metric_key,
             "start": start, "end": end},
        )
        return float(val) if val is not None else None

    return None
