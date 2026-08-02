from datetime import date, datetime

from app.collectors.base import Collector, Observation
from app.mcp_client.tools import get_health_score_series


class HealthScoreCollector(Collector):
    collector_id = "health_score"
    metric_keys = ["health_score"]

    async def collect(self, *, session, client, mcp, window_start: date, window_end: date) -> list[Observation]:
        rows = await get_health_score_series(mcp, window_start.isoformat(), window_end.isoformat())
        return [
            Observation("health_score", datetime.strptime(r["date"], "%Y-%m-%d").date(), r.get("website_health_score"))
            for r in rows
        ]
