from datetime import date, datetime

from app.collectors.base import Collector, Observation
from app.mcp_client.tools import get_ga4_breakdown_daily_series

DIMENSIONS = ("device", "country")


class Ga4BreakdownCollector(Collector):
    """GA4 sessions/users broken down by device and country — same
    metric_keys as ga4_daily's site-level totals, but
    dimension_type='device'/'country'. dim_value is whatever GA4's
    deviceCategory/country dimensions return — never hardcoded here."""

    collector_id = "ga4_breakdown"
    metric_keys = ["ga4_sessions", "ga4_users"]

    async def collect(self, *, session, client, mcp, window_start: date, window_end: date) -> list[Observation]:
        observations: list[Observation] = []
        for dim in DIMENSIONS:
            rows = await get_ga4_breakdown_daily_series(mcp, window_start.isoformat(), window_end.isoformat(), dim)
            for row in rows:
                day = datetime.strptime(row["date"], "%Y-%m-%d").date()
                dim_value = row["dim_value"]
                observations.append(Observation("ga4_sessions", day, row.get("sessions"), dimension_type=dim, dimension_value=dim_value))
                observations.append(Observation("ga4_users", day, row.get("users"), dimension_type=dim, dimension_value=dim_value))
        return observations
