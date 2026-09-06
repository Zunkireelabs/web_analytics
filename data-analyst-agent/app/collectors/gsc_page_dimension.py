from datetime import date, timedelta

from sqlalchemy import func, select

from app.collectors.base import Collector, Observation
from app.db.models import PageQueryObservation

# Phase 3 (page/query risk surfacing): lowered from 30 to 14. This changes
# only how SOON a page can qualify, never how trustworthy an admitted page's
# series is — the zero-gap-tolerance rule below is completely unchanged, so
# every admitted day is still real, contiguous, top-50-verified data. A
# 14-day-admitted page still needs its own separate minimums before
# anything downstream fires: anomalies.py's MIN_BASELINE_PERIODS (7) is
# already covered, and settings.min_history_days_for_forecast (30) simply
# keeps accruing for another 16 days before a daily forecast is attempted —
# neither engine is weakened by this change, they just start seeing real
# page-level data sooner instead of almost never.
STABILITY_WINDOW_DAYS = 14

_METRIC_COLUMNS = {
    "gsc_clicks": "clicks",
    "gsc_impressions": "impressions",
    "gsc_ctr": "ctr",
    "gsc_position": "position",
}


class GscPageDimensionCollector(Collector):
    """Admits a page into the standard metric_observations pipeline (and
    therefore anomaly/trend-shift detection) only if it held a top-50 rank
    for STABILITY_WINDOW_DAYS *consecutive* calendar days — an all-or-
    nothing gate, not a tolerance. page_query_observations (see that
    model's docstring) is a top-N-per-day sample: a page missing from one
    day's top-50 is NOT the same as a real zero, and feeding that gap into
    z-score/IQR anomaly detection or a WoW/MoM sum aggregate would produce
    a false anomaly/trend-shift whenever a page's rank crosses the top-50
    boundary for reasons unrelated to its own traffic (e.g. another page
    briefly surging past it). Requiring an unbroken streak means every
    page this collector admits has a genuinely gap-free series, so the
    generic stats/anomaly engines need no gap-handling changes of their
    own — recomputed fresh every night on a trailing window, so a page
    that later breaks its streak simply stops receiving new observation
    rows (never deleted/corrected) until it earns a fresh unbroken run.

    Must run after PageQueryCollector in registry.py's COLLECTORS list —
    it reads back what that collector already wrote this run, same
    pattern as DerivedRatiosCollector reading gsc_daily/ga4_daily's
    output."""

    collector_id = "gsc_page_dimension"
    metric_keys = list(_METRIC_COLUMNS.keys())
    requires_mcp = False

    async def collect(self, *, session, client, mcp, window_start: date, window_end: date) -> list[Observation]:
        latest_day = await session.scalar(
            select(func.max(PageQueryObservation.period_start)).where(
                PageQueryObservation.client_id == client.id,
                PageQueryObservation.dimension_type == "page",
            )
        )
        if latest_day is None:
            return []

        calendar_days = [latest_day - timedelta(days=i) for i in range(STABILITY_WINDOW_DAYS)]
        required_days = set(calendar_days)

        rows = (
            await session.execute(
                select(PageQueryObservation).where(
                    PageQueryObservation.client_id == client.id,
                    PageQueryObservation.dimension_type == "page",
                    PageQueryObservation.period_start >= calendar_days[-1],
                    PageQueryObservation.period_start <= latest_day,
                )
            )
        ).scalars().all()

        by_page: dict[str, dict[date, PageQueryObservation]] = {}
        for row in rows:
            by_page.setdefault(row.dimension_value, {})[row.period_start] = row

        observations: list[Observation] = []
        for page_url, rows_by_day in by_page.items():
            if set(rows_by_day.keys()) != required_days:
                continue  # any gap at all disqualifies this page — no tolerance
            for day, row in rows_by_day.items():
                for metric_key, column in _METRIC_COLUMNS.items():
                    value = getattr(row, column)
                    if value is None:  # never fabricate — omit rather than write a false 0
                        continue
                    observations.append(Observation(
                        metric_key, day, float(value),
                        dimension_type="page", dimension_value=page_url,
                    ))
        return observations
