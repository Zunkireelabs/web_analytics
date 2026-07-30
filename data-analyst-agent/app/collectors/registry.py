from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.collectors.base import Collector
from app.collectors.derived_ratios import DerivedRatiosCollector
from app.collectors.ga4_daily import Ga4DailyCollector
from app.collectors.gsc_daily import GscDailyCollector
from app.collectors.health_score import HealthScoreCollector
from app.db.models import MetricCatalog

# Ordered — derived_ratios must run after gsc_daily/ga4_daily each night,
# since it reads their freshly-written metric_observations rows rather than
# calling MCP itself. A future collector (breakdowns, authority,
# ai-recommendation, competitor) is added here as one more entry; nothing
# else in the ingestion pipeline changes.
COLLECTORS: list[Collector] = [
    GscDailyCollector(),
    Ga4DailyCollector(),
    HealthScoreCollector(),
    DerivedRatiosCollector(),
]


async def get_enabled_collectors(session: AsyncSession) -> list[Collector]:
    """Only collectors with at least one enabled metrics_catalog row pointing
    at them actually run — flipping metrics_catalog.enabled is how a future
    collector gets turned on, not a code change here."""
    result = await session.execute(
        select(MetricCatalog.collector_id).where(MetricCatalog.enabled.is_(True)).distinct()
    )
    enabled_ids = {row[0] for row in result}
    return [c for c in COLLECTORS if c.collector_id in enabled_ids]
