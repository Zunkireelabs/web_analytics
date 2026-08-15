import logging
from datetime import date, datetime

from app.collectors.base import Collector, Observation
from app.mcp_client.client import McpToolError
from app.mcp_client.tools import (
    get_authority_score_series,
    get_competitor_structural_score_series,
)

logger = logging.getLogger(__name__)


class MonthlyMetricsCollector(Collector):
    """Authority Score, Competitor Structural Score — two independently-sourced
    monthly metrics, each genuinely monthly at the source (DataForSEO
    snapshots / structural crawls, not just a rollup of finer data). Each is
    dormant (returns real data or a real empty list) depending on whether its
    upstream agent is configured for a given client (e.g. Authority Score
    stays empty until DataForSEO credentials are provisioned) — one metric
    being empty must never block the other from ingesting.

    AI Recommendation Rate used to live here too, but its underlying data
    (ai_prompt_runs) is real at near-daily granularity — the monthly rollup
    was a rollup choice, not a source limitation — so it now has its own
    weekly_metrics.py collector instead. See migration 0035."""

    collector_id = "monthly_metrics"
    metric_keys = ["authority_score", "competitor_structural_score"]

    async def collect(self, *, session, client, mcp, window_start: date, window_end: date) -> list[Observation]:
        observations: list[Observation] = []
        start, end = window_start.isoformat(), window_end.isoformat()

        for metric_key, fetch, date_field, value_field in (
            ("authority_score", get_authority_score_series, "snapshot_date", "authority_score"),
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
