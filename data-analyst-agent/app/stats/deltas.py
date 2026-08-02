"""Statistics Engine — WoW/MoM deltas. Rolling windows (7d/30d), not calendar
week/month boundaries, so this works identically regardless of a client's
onboarding date or month length. Every aggregation follows
metrics_catalog.aggregation_strategy — this is the single place the Part A
canonical-formula decision (impression-weighted CTR/position, never a raw
AVG()) gets applied inside this service. Dimension-aware: runs once per
(metric, dimension_type, dimension_value) — site-level plus any other
enabled dimension (e.g. channel) discovered from real data."""
from datetime import date, timedelta

from sqlalchemy import select, func, text
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.dimension_lookup import dimension_values_for, iter_enabled_metric_dimensions
from app.db.models import Client, MetricCatalog, MetricObservation, MetricPeriodStats
from app.db.session import SessionLocal

WOW_DAYS = 7
MOM_DAYS = 30


async def run_stats() -> None:
    async with SessionLocal() as session:
        clients = (await session.execute(select(Client).where(Client.status == "active"))).scalars().all()
        metric_dims = await iter_enabled_metric_dimensions(session)

    for client in clients:
        for md in metric_dims:
            async with SessionLocal() as session:
                dim_values = await dimension_values_for(session, client.id, md.metric.metric_key, md.dimension_type)
            for dim_value in dim_values:
                async with SessionLocal() as session:
                    await _compute_for_metric(session, client.id, md.metric, md.dimension_type, dim_value)
                    await session.commit()


async def _compute_for_metric(session: AsyncSession, client_id: int, metric: MetricCatalog, dimension_type: str, dimension_value: str) -> None:
    latest = await session.scalar(
        select(func.max(MetricObservation.period_start)).where(
            MetricObservation.client_id == client_id,
            MetricObservation.metric_key == metric.metric_key,
            MetricObservation.dimension_type == dimension_type,
            MetricObservation.dimension_value == dimension_value,
        )
    )
    if latest is None:
        return

    if metric.cadence == "monthly":
        await _compute_monthly(session, client_id, metric, dimension_type, dimension_value, latest)
        return

    for period_type, span in (("wow", WOW_DAYS), ("mom", MOM_DAYS)):
        period_end = latest
        current = await _aggregate(session, client_id, metric, dimension_type, dimension_value, period_end - timedelta(days=span - 1), period_end)
        prior = await _aggregate(session, client_id, metric, dimension_type, dimension_value, period_end - timedelta(days=2 * span - 1), period_end - timedelta(days=span))
        abs_change = (current - prior) if current is not None and prior is not None else None
        pct_change = (abs_change / prior * 100) if abs_change is not None and prior else None

        stmt = pg_insert(MetricPeriodStats).values(
            client_id=client_id, metric_key=metric.metric_key, dimension_type=dimension_type, dimension_value=dimension_value,
            period_type=period_type, period_end=period_end,
            current_value=current, prior_value=prior, abs_change=abs_change, pct_change=pct_change,
        )
        stmt = stmt.on_conflict_do_update(
            index_elements=["client_id", "metric_key", "dimension_type", "dimension_value", "period_type", "period_end"],
            set_={"current_value": stmt.excluded.current_value, "prior_value": stmt.excluded.prior_value,
                  "abs_change": stmt.excluded.abs_change, "pct_change": stmt.excluded.pct_change},
        )
        await session.execute(stmt)


async def _compute_monthly(session: AsyncSession, client_id: int, metric: MetricCatalog, dimension_type: str, dimension_value: str, latest: date) -> None:
    """Monthly cadence has no fixed rolling window that reliably lands on a
    real snapshot date (real calendar months aren't exactly 30 days) — wow
    doesn't apply at all, and mom here means "vs. the immediately preceding
    real snapshot", found by period_start, never by day-count arithmetic."""
    prior_start = await session.scalar(
        select(MetricObservation.period_start).where(
            MetricObservation.client_id == client_id, MetricObservation.metric_key == metric.metric_key,
            MetricObservation.dimension_type == dimension_type, MetricObservation.dimension_value == dimension_value,
            MetricObservation.period_start < latest,
        ).order_by(MetricObservation.period_start.desc()).limit(1)
    )

    current = await _aggregate(session, client_id, metric, dimension_type, dimension_value, latest, latest)
    prior = await _aggregate(session, client_id, metric, dimension_type, dimension_value, prior_start, prior_start) if prior_start is not None else None
    abs_change = (current - prior) if current is not None and prior is not None else None
    pct_change = (abs_change / prior * 100) if abs_change is not None and prior else None

    stmt = pg_insert(MetricPeriodStats).values(
        client_id=client_id, metric_key=metric.metric_key, dimension_type=dimension_type, dimension_value=dimension_value,
        period_type="mom", period_end=latest,
        current_value=current, prior_value=prior, abs_change=abs_change, pct_change=pct_change,
    )
    stmt = stmt.on_conflict_do_update(
        index_elements=["client_id", "metric_key", "dimension_type", "dimension_value", "period_type", "period_end"],
        set_={"current_value": stmt.excluded.current_value, "prior_value": stmt.excluded.prior_value,
              "abs_change": stmt.excluded.abs_change, "pct_change": stmt.excluded.pct_change},
    )
    await session.execute(stmt)


async def _aggregate(session: AsyncSession, client_id: int, metric: MetricCatalog, dimension_type: str, dimension_value: str, start: date, end: date) -> float | None:
    strategy = metric.aggregation_strategy

    if strategy == "last_value":
        # Most recent observation on or before `end`, not an exact-date
        # match — real snapshot cadences (monthly especially, since real
        # calendar months aren't exactly 30 days) don't reliably land an
        # observation exactly on `end`, which would otherwise silently
        # produce a None here.
        val = await session.scalar(
            select(MetricObservation.value).where(
                MetricObservation.client_id == client_id, MetricObservation.metric_key == metric.metric_key,
                MetricObservation.dimension_type == dimension_type, MetricObservation.dimension_value == dimension_value,
                MetricObservation.period_start <= end,
            ).order_by(MetricObservation.period_start.desc()).limit(1)
        )
        return float(val) if val is not None else None

    if strategy == "sum":
        val = await session.scalar(
            select(func.sum(MetricObservation.value)).where(
                MetricObservation.client_id == client_id, MetricObservation.metric_key == metric.metric_key,
                MetricObservation.dimension_type == dimension_type, MetricObservation.dimension_value == dimension_value,
                MetricObservation.period_start.between(start, end),
            )
        )
        return float(val) if val is not None else None

    if strategy == "avg":
        val = await session.scalar(
            select(func.avg(MetricObservation.value)).where(
                MetricObservation.client_id == client_id, MetricObservation.metric_key == metric.metric_key,
                MetricObservation.dimension_type == dimension_type, MetricObservation.dimension_value == dimension_value,
                MetricObservation.period_start.between(start, end),
            )
        )
        return float(val) if val is not None else None

    if strategy == "weighted_avg":
        if not metric.weight_metric_key:
            return None
        # Weight series uses the same dimension as the metric being
        # weighted (e.g. a channel's CTR weighted by that channel's own
        # impressions, not the site-level total) — always 'site'/'__site__'
        # today since no weighted_avg metric has a non-site dimension
        # enabled yet, but this must not silently mix dimensions once one
        # does.
        val = await session.scalar(
            text(
                """
                SELECT SUM(m.value * w.value) / NULLIF(SUM(w.value), 0)
                  FROM metric_observations m
                  JOIN metric_observations w
                    ON w.client_id = m.client_id AND w.period_start = m.period_start
                       AND w.metric_key = :weight_key AND w.dimension_type = :dimension_type AND w.dimension_value = :dimension_value
                 WHERE m.client_id = :client_id AND m.metric_key = :metric_key
                   AND m.dimension_type = :dimension_type AND m.dimension_value = :dimension_value
                   AND m.period_start BETWEEN :start AND :end
                """
            ),
            {"weight_key": metric.weight_metric_key, "client_id": client_id, "metric_key": metric.metric_key,
             "dimension_type": dimension_type, "dimension_value": dimension_value, "start": start, "end": end},
        )
        return float(val) if val is not None else None

    return None
