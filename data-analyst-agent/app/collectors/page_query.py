from datetime import date, datetime

from sqlalchemy.dialects.postgresql import insert as pg_insert

from app.collectors.base import Collector, Observation
from app.db.models import PageQueryObservation
from app.mcp_client.tools import get_gsc_breakdown_daily_top_n

DIMENSIONS = ("page", "query")
TOP_N_PER_DAY = 50
# Postgres caps bound parameters per statement at 65535; 8 columns per row
# keeps well under that even at the largest realistic batch.
BATCH_SIZE = 500


class PageQueryCollector(Collector):
    """Top-50-per-day page/query performance — writes directly to
    page_query_observations (see that model's docstring for why this
    doesn't go through metric_observations like every other collector).
    dim_value is a real URL or search query string, capped to the top N by
    clicks per day rather than every real value — bounded by design, not a
    a limitation of this collector alone (the source MCP tool itself caps
    the same way)."""

    collector_id = "page_query"
    metric_keys = ["gsc_clicks", "gsc_impressions", "gsc_ctr", "gsc_position"]
    writes_own_storage = True

    async def collect(self, *, session, client, mcp, window_start: date, window_end: date) -> list[Observation]:
        for dim in DIMENSIONS:
            rows = await get_gsc_breakdown_daily_top_n(
                mcp, window_start.isoformat(), window_end.isoformat(), dim, TOP_N_PER_DAY
            )
            values = [
                {
                    "client_id": client.id, "dimension_type": dim, "dimension_value": row["dim_value"],
                    "period_start": datetime.strptime(row["date"], "%Y-%m-%d").date(),
                    "clicks": row.get("clicks"), "impressions": row.get("impressions"),
                    "ctr": row.get("ctr"), "position": row.get("position"),
                }
                for row in rows
            ]
            # Batched in one multi-row upsert per chunk instead of one
            # awaited round-trip per row — a full lookback window is up to
            # TOP_N_PER_DAY * ~400 days per dimension, and at one row per
            # round-trip that made this collector alone take tens of minutes.
            for i in range(0, len(values), BATCH_SIZE):
                batch = values[i:i + BATCH_SIZE]
                stmt = pg_insert(PageQueryObservation).values(batch)
                stmt = stmt.on_conflict_do_update(
                    index_elements=["client_id", "dimension_type", "dimension_value", "period_start"],
                    set_={
                        "clicks": stmt.excluded.clicks, "impressions": stmt.excluded.impressions,
                        "ctr": stmt.excluded.ctr, "position": stmt.excluded.position,
                    },
                )
                await session.execute(stmt)
        return []
