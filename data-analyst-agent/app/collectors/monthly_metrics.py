import logging
from datetime import date, datetime

from app.collectors.base import Collector, Observation
from app.mcp_client.client import McpToolError
from app.mcp_client.tools import (
    get_ai_recommendation_visibility_series,
    get_authority_score_series,
    get_competitor_structural_score_series,
)

logger = logging.getLogger(__name__)


class MonthlyMetricsCollector(Collector):
    """Authority Score, AI Recommendation Visibility %, Competitor Structural
    Score — three independently-sourced monthly metrics. Each is dormant
    (returns real data or a real empty list) depending on whether its
    upstream agent is configured for a given client (e.g. Authority Score
    stays empty until DataForSEO credentials are provisioned) — one metric
    being empty must never block the other two from ingesting."""

    collector_id = "monthly_metrics"
    metric_keys = ["authority_score", "ai_recommendation_rate", "competitor_structural_score"]

    async def collect(self, *, session, client, mcp, window_start: date, window_end: date) -> list[Observation]:
        observations: list[Observation] = []
        start, end = window_start.isoformat(), window_end.isoformat()

        for metric_key, fetch, date_field, value_field in (
            ("authority_score", get_authority_score_series, "snapshot_date", "authority_score"),
            ("ai_recommendation_rate", get_ai_recommendation_visibility_series, "month", "visibility_pct"),
            ("competitor_structural_score", get_competitor_structural_score_series, "snapshot_date", "own_score"),
        ):
            try:
                rows = await fetch(mcp, start, end)
            except McpToolError as e:
                logger.warning("monthly_metrics: %s fetch failed, skipping this metric only: %s", metric_key, e)
                continue

            for row in rows:
                period_start = datetime.strptime(row[date_field], "%Y-%m-%d").date()
                observations.append(Observation(metric_key, period_start, row.get(value_field)))

        return observations
