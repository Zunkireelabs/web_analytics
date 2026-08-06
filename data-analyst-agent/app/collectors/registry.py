from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.collectors.base import Collector
from app.collectors.derived_ratios import DerivedRatiosCollector
from app.collectors.ga4_breakdown import Ga4BreakdownCollector
from app.collectors.ga4_browser import Ga4BrowserCollector
from app.collectors.ga4_channels import Ga4ChannelsCollector
from app.collectors.ga4_daily import Ga4DailyCollector
from app.collectors.ga4_source_medium import Ga4SourceMediumCollector
from app.collectors.gsc_breakdown import GscBreakdownCollector
from app.collectors.gsc_daily import GscDailyCollector
from app.collectors.gsc_page_dimension import GscPageDimensionCollector
from app.collectors.gsc_query_dimension import GscQueryDimensionCollector
from app.collectors.health_score import HealthScoreCollector
from app.collectors.monthly_metrics import MonthlyMetricsCollector
from app.collectors.page_query import PageQueryCollector
from app.db.models import MetricCatalog, MetricDimensionSupport

# Ordered — derived_ratios must run after gsc_daily/ga4_daily each night,
# since it reads their freshly-written metric_observations rows rather than
# calling MCP itself. Likewise gsc_page_dimension and gsc_query_dimension
# must run after page_query, since both read page_query_observations rows
# that collector just wrote this run rather than calling MCP itself (order
# between the two of them doesn't matter — neither reads the other's
# output). A future collector (breakdowns, authority, ai-recommendation,
# competitor) is added here as one more entry; nothing else in the
# ingestion pipeline changes.
COLLECTORS: list[Collector] = [
    GscDailyCollector(),
    Ga4DailyCollector(),
    HealthScoreCollector(),
    DerivedRatiosCollector(),
    MonthlyMetricsCollector(),
    Ga4ChannelsCollector(),
    GscBreakdownCollector(),
    Ga4BreakdownCollector(),
    Ga4BrowserCollector(),
    Ga4SourceMediumCollector(),
    PageQueryCollector(),
    GscPageDimensionCollector(),
    GscQueryDimensionCollector(),
]


async def get_enabled_collectors(session: AsyncSession) -> list[Collector]:
    """Only collectors with at least one enabled row pointing at them
    actually run — flipping metrics_catalog.enabled (site-level collectors,
    e.g. gsc_daily/ga4_daily/monthly_metrics) or metric_dimension_support.
    enabled (dimension-specific collectors, e.g. ga4_channels — a metric's
    site-level collector_id in metrics_catalog and its per-dimension
    collector_id here are independent) is how a collector gets turned on,
    not a code change here.

    A writes_own_storage collector (e.g. page_query) is the one exception —
    its data doesn't fit metric_observations, so metrics_catalog/
    metric_dimension_support have no row that correctly represents it
    (flipping a metric_dimension_support row for it would also make it show
    up in iter_enabled_metric_dimensions(), which the stats/anomaly/forecast
    engines use — exactly what it must stay out of). It is therefore always
    included rather than gated through either table."""
    catalog_ids = await session.execute(
        select(MetricCatalog.collector_id).where(MetricCatalog.enabled.is_(True)).distinct()
    )
    dimension_ids = await session.execute(
        select(MetricDimensionSupport.collector_id).where(MetricDimensionSupport.enabled.is_(True)).distinct()
    )
    enabled_ids = {row[0] for row in catalog_ids} | {row[0] for row in dimension_ids}
    return [c for c in COLLECTORS if c.writes_own_storage or c.collector_id in enabled_ids]
