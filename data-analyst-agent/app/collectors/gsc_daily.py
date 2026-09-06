from datetime import date, datetime

from app.collectors.base import Collector, Observation
from app.mcp_client.tools import get_daily_series


class GscDailyCollector(Collector):
    collector_id = "gsc_daily"
    metric_keys = ["gsc_clicks", "gsc_impressions", "gsc_ctr", "gsc_position"]

    async def collect(self, *, session, client, mcp, window_start: date, window_end: date) -> list[Observation]:
        rows = await get_daily_series(mcp, window_start.isoformat(), window_end.isoformat())
        observations: list[Observation] = []
        for row in rows:
            day = datetime.strptime(row["date"], "%Y-%m-%d").date()
            observations.append(Observation("gsc_clicks", day, row.get("clicks")))
            observations.append(Observation("gsc_impressions", day, row.get("impressions")))
            observations.append(Observation("gsc_ctr", day, row.get("ctr")))
            observations.append(Observation("gsc_position", day, row.get("position")))
        return observations
