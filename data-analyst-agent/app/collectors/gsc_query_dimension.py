from datetime import date, timedelta

from sqlalchemy import func, select

from app.collectors.base import Collector, Observation
from app.db.models import PageQueryObservation

# Same gate as GscPageDimensionCollector, but queries are structurally
# noisier than pages: a query's daily rank in a top-50-by-clicks list is far
# more exposed to low-volume Poisson noise (a term with 8 clicks one day and
# 4 the next can cross the top-50 boundary from noise alone), so expect a
# much smaller admitted set than pages — likely just a site's head/branded
# terms. That's the correct outcome, not a bug: the whole point of the gate
# is to keep SARIMAX from being fit to noise, same rationale as the page
# variant's own docstring. Kept equal to STABILITY_WINDOW_DAYS below and to
# anomalies.py's BASELINE_WINDOW for the same reason the page variant gives:
# a query that clears this gate has an immediately usable anomaly baseline
# and enough history for a WoW trend-shift on day one.
STABILITY_WINDOW_DAYS = 30

_METRIC_COLUMNS = {
    "gsc_clicks": "clicks",
    "gsc_impressions": "impressions",
    "gsc_ctr": "ctr",
    "gsc_position": "position",
}


class GscQueryDimensionCollector(Collector):
    """Admits a search query into the standard metric_observations pipeline
    (and therefore anomaly/trend-shift/forecast) only if it held a top-50
    rank for STABILITY_WINDOW_DAYS *consecutive* calendar days — an
    all-or-nothing gate, not a tolerance, for exactly the reason
    GscPageDimensionCollector's own docstring gives: page_query_observations
    is a top-N-per-day sample, so a query missing from one day's top-50 is
    NOT the same as a real zero, and feeding that gap into z-score/IQR
    anomaly detection or a WoW/MoM sum aggregate would produce a false
    anomaly/trend-shift whenever a query's rank crosses the top-50 boundary
    for reasons unrelated to its own traffic. Recomputed fresh every night
    on a trailing window, so a query that later breaks its streak simply
    stops receiving new observation rows (never deleted/corrected) until it
    earns a fresh unbroken run.

    Must run after PageQueryCollector in registry.py's COLLECTORS list — it
    reads back what that collector already wrote this run, same pattern as
    GscPageDimensionCollector reading the 'page' rows from the same table."""

    collector_id = "gsc_query_dimension"
    metric_keys = list(_METRIC_COLUMNS.keys())
    requires_mcp = False

    async def collect(self, *, session, client, mcp, window_start: date, window_end: date) -> list[Observation]:
        latest_day = await session.scalar(
            select(func.max(PageQueryObservation.period_start)).where(
                PageQueryObservation.client_id == client.id,
                PageQueryObservation.dimension_type == "query",
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
                    PageQueryObservation.dimension_type == "query",
                    PageQueryObservation.period_start >= calendar_days[-1],
                    PageQueryObservation.period_start <= latest_day,
                )
            )
        ).scalars().all()

        by_query: dict[str, dict[date, PageQueryObservation]] = {}
        for row in rows:
            by_query.setdefault(row.dimension_value, {})[row.period_start] = row

        observations: list[Observation] = []
        for query_text, rows_by_day in by_query.items():
            if set(rows_by_day.keys()) != required_days:
                continue  # any gap at all disqualifies this query — no tolerance
            for day, row in rows_by_day.items():
                for metric_key, column in _METRIC_COLUMNS.items():
                    value = getattr(row, column)
                    if value is None:  # never fabricate — omit rather than write a false 0
                        continue
                    observations.append(Observation(
                        metric_key, day, float(value),
                        dimension_type="query", dimension_value=query_text,
                    ))
        return observations
