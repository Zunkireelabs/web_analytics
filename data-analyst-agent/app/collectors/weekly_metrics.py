import logging
from datetime import datetime, date

from app.collectors.base import Collector, Observation
from app.mcp_client.client import McpToolError
from app.mcp_client.tools import get_ai_recommendation_visibility_weekly_series

logger = logging.getLogger(__name__)


class WeeklyMetricsCollector(Collector):
    """AI Recommendation Rate, at real weekly granularity.

    This metric started out bundled into monthly_metrics.py alongside two
    genuinely-monthly metrics (Authority Score, Competitor Structural Score),
    which meant every real ai_prompt_runs check — several a week in practice —
    got flattened into one calendar-month point before the Analyst ever saw
    it. The underlying data was never the limitation; the rollup was. See
    migration 0035 and get_ai_recommendation_visibility_weekly_series."""

    collector_id = "weekly_metrics"
    metric_keys = ["ai_recommendation_rate"]

    async def collect(self, *, session, client, mcp, window_start: date, window_end: date) -> list[Observation]:
        start, end = window_start.isoformat(), window_end.isoformat()
        try:
            rows = await get_ai_recommendation_visibility_weekly_series(mcp, start, end)
        except McpToolError as e:
            logger.warning("weekly_metrics: ai_recommendation_rate fetch failed: %s", e)
            return []

        return [
            # visibility_pct is a genuine 0-100 percentage (mentioned/total *
            # 100 — the same convention server/agents/ai-recommendation.js
            # uses for aiVisibilityPct everywhere else in this codebase), but
            # metrics_catalog's unit='ratio' contract for this metric means a
            # 0-1 fraction (every other ratio metric — gsc_ctr,
            # engagement_rate — stores one), and the frontend's formatByUnit
            # multiplies by 100 again to render it. Divide here, at the
            # ingestion boundary, so the stored value actually matches its
            # declared unit instead of the display layer silently inflating
            # a real 0.86% mention rate into a claimed "86%".
            Observation(
                "ai_recommendation_rate",
                datetime.strptime(row["week"], "%Y-%m-%d").date(),
                row["visibility_pct"] / 100 if row.get("visibility_pct") is not None else None,
            )
            for row in rows
        ]
