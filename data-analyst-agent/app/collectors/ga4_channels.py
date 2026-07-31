from datetime import date, datetime

from app.collectors.base import Collector, Observation
from app.mcp_client.tools import get_channels_daily_series


class Ga4ChannelsCollector(Collector):
    """Per-channel daily sessions/users — same metric_keys as ga4_daily's
    site-level totals, but dimension_type='channel'. Channel names are
    whatever GA4's sessionDefaultChannelGroup produces (free text, not a
    closed enum) — never hardcoded here."""

    collector_id = "ga4_channels"
    metric_keys = ["ga4_sessions", "ga4_users"]

    async def collect(self, *, session, client, mcp, window_start: date, window_end: date) -> list[Observation]:
        rows = await get_channels_daily_series(mcp, window_start.isoformat(), window_end.isoformat())
        observations: list[Observation] = []
        for row in rows:
            day = datetime.strptime(row["date"], "%Y-%m-%d").date()
            channel = row["channel"]
            observations.append(Observation("ga4_sessions", day, row.get("sessions"), dimension_type="channel", dimension_value=channel))
            observations.append(Observation("ga4_users", day, row.get("users"), dimension_type="channel", dimension_value=channel))
        return observations
