from datetime import date, datetime

from app.collectors.base import Collector, Observation
from app.mcp_client.tools import get_daily_series


class Ga4DailyCollector(Collector):
    collector_id = "ga4_daily"
    metric_keys = [
        "ga4_sessions", "ga4_users", "ga4_new_users", "ga4_engaged_sessions",
        "ga4_avg_engagement_time", "ga4_conversions", "ga4_bounce_rate",
    ]

    async def collect(self, *, session, client, mcp, window_start: date, window_end: date) -> list[Observation]:
        rows = await get_daily_series(mcp, window_start.isoformat(), window_end.isoformat())
        observations: list[Observation] = []
        for row in rows:
            day = datetime.strptime(row["date"], "%Y-%m-%d").date()
            observations.append(Observation("ga4_sessions", day, row.get("sessions")))
            observations.append(Observation("ga4_users", day, row.get("users")))
            observations.append(Observation("ga4_new_users", day, row.get("new_users")))
            observations.append(Observation("ga4_engaged_sessions", day, row.get("engaged_sessions")))
            observations.append(Observation("ga4_avg_engagement_time", day, row.get("avg_engagement_time")))
            observations.append(Observation("ga4_conversions", day, row.get("conversions")))
            observations.append(Observation("ga4_bounce_rate", day, row.get("bounce_rate")))
        return observations
