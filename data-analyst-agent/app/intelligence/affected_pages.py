"""Shared page-footprint resolver for the Effort Estimation Engine (this
module's only caller today) — a bigger footprint (more pages affected)
scales effort up within a fix category. page_query_observations is the only
source of page-level data this service has (see that model's docstring:
GSC top-N-per-day only, GA4 has no page dimension collected at all), so
this deliberately returns 'not-applicable' rather than a guess for any
metric outside that table."""
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import PageQueryObservation

PAGE_ATTRIBUTABLE_METRICS = {"gsc_clicks", "gsc_impressions", "gsc_ctr", "gsc_position"}


async def resolve_affected_page_count(
    session: AsyncSession, client_id: int, metric_key: str, dimension_type: str, dimension_value: str,
) -> tuple[int | None, str]:
    """Returns (count, status). status is one of:
    - 'ok': a real count was resolved.
    - 'insufficient-data': the metric is page-attributable but no
      page_query_observations rows exist for this client yet.
    - 'not-applicable': the metric has no page-level breakdown at all
      (e.g. any GA4/derived/health/authority metric) — not a data gap,
      just a metric this service can't attribute to specific pages."""
    if dimension_type == "page":
        # The insight already fired on one specific page — that page IS the
        # affected footprint, no need to re-query page_query_observations.
        return 1, "ok"

    if dimension_type == "query":
        # page_query_observations stores 'page' and 'query' dimension_value
        # rows independently, with no column linking a given query to the
        # specific page(s) that rank for it (that mapping only exists via
        # the MCP get_query_page_metrics/get_cannibalized_queries tools,
        # which this DB-only resolver has no access to). Falling through to
        # the generic branch below would silently count every page on the
        # site with page-level data, unrelated to this specific query — so,
        # per this module's own "never guess" rule, this is honestly
        # not-applicable rather than a fabricated site-wide number.
        return None, "not-applicable"

    if metric_key not in PAGE_ATTRIBUTABLE_METRICS:
        return None, "not-applicable"

    latest_date = await session.scalar(
        select(func.max(PageQueryObservation.period_start)).where(
            PageQueryObservation.client_id == client_id, PageQueryObservation.dimension_type == "page",
        )
    )
    if latest_date is None:
        return None, "insufficient-data"

    count = await session.scalar(
        select(func.count()).select_from(PageQueryObservation).where(
            PageQueryObservation.client_id == client_id, PageQueryObservation.dimension_type == "page",
            PageQueryObservation.period_start == latest_date,
        )
    )
    return int(count), "ok"
