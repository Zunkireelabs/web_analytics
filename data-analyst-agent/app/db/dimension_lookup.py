"""Shared dimension-discovery helper for the stats/anomaly/forecast engines.
Each engine used to hardcode dimension_type == "site" — this is the single
place that changed to make all three dimension-aware (channel, and later
country/device/page/query) without duplicating the same discovery query
three times. The dimension_type == "site" branch reproduces the exact
pre-dimension-aware query/behavior, so existing site-level output is
unchanged."""
from dataclasses import dataclass
from datetime import date, timedelta

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import MetricCatalog, MetricDimensionSupport, MetricObservation

# Bounds reprocessing cost for a dimension whose active value set can shrink
# over time (e.g. a page that loses its top-50 streak — see
# app/collectors/gsc_page_dimension.py — simply stops receiving new
# observation rows rather than having old ones deleted). A no-op for
# device/country/channel, which get fresh rows daily regardless.
RECENCY_DAYS = 14


@dataclass
class MetricDimension:
    metric: MetricCatalog
    dimension_type: str


async def iter_enabled_metric_dimensions(
    session: AsyncSession,
    *,
    cadence: str | None = None,
    forecastable_only: bool = False,
    anomaly_only: bool = False,
) -> list[MetricDimension]:
    """Every enabled (metric, dimension_type) combination across
    metrics_catalog x metric_dimension_support — a metric+dimension
    combination only participates once metric_dimension_support marks it
    enabled, independent of whether the metric itself is enabled for its
    site-level default collector."""
    query = select(MetricCatalog, MetricDimensionSupport.dimension_type).join(
        MetricDimensionSupport, MetricDimensionSupport.metric_key == MetricCatalog.metric_key
    ).where(MetricCatalog.enabled.is_(True), MetricDimensionSupport.enabled.is_(True))
    if cadence is not None:
        query = query.where(MetricCatalog.cadence == cadence)
    if forecastable_only:
        query = query.where(MetricCatalog.is_forecastable.is_(True))
    if anomaly_only:
        query = query.where(MetricCatalog.supports_anomaly_detection.is_(True))

    rows = (await session.execute(query)).all()
    return [MetricDimension(metric=m, dimension_type=d) for m, d in rows]


async def dimension_values_for(session: AsyncSession, client_id: int, metric_key: str, dimension_type: str) -> list[str]:
    """Real dimension_values already present in metric_observations for this
    (client, metric, dimension_type) — discovered from data, never a
    hardcoded enum (channels/countries/devices aren't closed vocabularies).
    dimension_type='site' always returns exactly ['__site__'] without a
    query, reproducing the pre-dimension-aware behavior exactly."""
    if dimension_type == "site":
        return ["__site__"]
    recent_cutoff = date.today() - timedelta(days=RECENCY_DAYS)
    rows = (
        await session.execute(
            select(MetricObservation.dimension_value).where(
                MetricObservation.client_id == client_id,
                MetricObservation.metric_key == metric_key,
                MetricObservation.dimension_type == dimension_type,
            ).group_by(MetricObservation.dimension_value)
            .having(func.max(MetricObservation.period_start) >= recent_cutoff)
        )
    ).scalars().all()
    return list(rows)
