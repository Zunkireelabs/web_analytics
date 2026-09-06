from datetime import date, datetime

from app.collectors.base import Collector, Observation
from app.mcp_client.tools import get_gsc_breakdown_daily_series

DIMENSIONS = ("device", "country")


class GscBreakdownCollector(Collector):
    """Search Console clicks/impressions/ctr/position broken down by device
    and country — same metric_keys as gsc_daily's site-level totals, but
    dimension_type='device'/'country'. dim_value is whatever the Search
    Console API returns (e.g. 'DESKTOP'/'MOBILE'/'TABLET' for device, ISO
    country codes for country) — never hardcoded here."""

    collector_id = "gsc_breakdown"
    metric_keys = ["gsc_clicks", "gsc_impressions", "gsc_ctr", "gsc_position"]

    async def collect(self, *, session, client, mcp, window_start: date, window_end: date) -> list[Observation]:
        observations: list[Observation] = []
        for dim in DIMENSIONS:
            rows = await get_gsc_breakdown_daily_series(mcp, window_start.isoformat(), window_end.isoformat(), dim)
            for row in rows:
                day = datetime.strptime(row["date"], "%Y-%m-%d").date()
                dim_value = row["dim_value"]
                observations.append(Observation("gsc_clicks", day, row.get("clicks"), dimension_type=dim, dimension_value=dim_value))
                observations.append(Observation("gsc_impressions", day, row.get("impressions"), dimension_type=dim, dimension_value=dim_value))
                observations.append(Observation("gsc_ctr", day, row.get("ctr"), dimension_type=dim, dimension_value=dim_value))
                observations.append(Observation("gsc_position", day, row.get("position"), dimension_type=dim, dimension_value=dim_value))
        return observations
