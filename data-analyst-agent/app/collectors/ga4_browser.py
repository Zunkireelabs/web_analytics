from datetime import date, datetime

from app.collectors.base import Collector, Observation
from app.mcp_client.tools import get_ga4_breakdown_daily_series


class Ga4BrowserCollector(Collector):
    """GA4 sessions/users broken down by browser — same metric_keys as
    ga4_daily's site-level totals, but dimension_type='browser'. dim_value is
    whatever GA4's browser dimension returns (e.g. 'Chrome', 'Safari') —
    never hardcoded here."""

    collector_id = "ga4_browser"
    metric_keys = ["ga4_sessions", "ga4_users"]

    async def collect(self, *, session, client, mcp, window_start: date, window_end: date) -> list[Observation]:
        observations: list[Observation] = []
        rows = await get_ga4_breakdown_daily_series(mcp, window_start.isoformat(), window_end.isoformat(), "browser")
        for row in rows:
            day = datetime.strptime(row["date"], "%Y-%m-%d").date()
            dim_value = row["dim_value"]
            observations.append(Observation("ga4_sessions", day, row.get("sessions"), dimension_type="browser", dimension_value=dim_value))
            observations.append(Observation("ga4_users", day, row.get("users"), dimension_type="browser", dimension_value=dim_value))
        return observations
