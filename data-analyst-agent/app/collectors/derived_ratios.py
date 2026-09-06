from datetime import date

from sqlalchemy import select

from app.collectors.base import Collector, Observation
from app.db.models import MetricObservation


class DerivedRatiosCollector(Collector):
    """Computed entirely from metric_observations rows the gsc_daily/ga4_daily
    collectors already wrote this run — no MCP call. Must run after those
    two in registry.py's ordering."""

    collector_id = "derived_ratios"
    metric_keys = ["engagement_rate", "conversion_rate"]
    requires_mcp = False

    async def collect(self, *, session, client, mcp, window_start: date, window_end: date) -> list[Observation]:
        sessions_by_day = await self._fetch(session, client.id, "ga4_sessions", window_start, window_end)
        engaged_by_day = await self._fetch(session, client.id, "ga4_engaged_sessions", window_start, window_end)
        conversions_by_day = await self._fetch(session, client.id, "ga4_conversions", window_start, window_end)

        observations: list[Observation] = []
        for day, sessions in sessions_by_day.items():
            if not sessions:  # None or 0 — no safe denominator, omit rather than divide by zero
                continue
            engaged = engaged_by_day.get(day)
            if engaged is not None:
                observations.append(Observation("engagement_rate", day, float(engaged) / float(sessions)))
            conversions = conversions_by_day.get(day)
            if conversions is not None:
                observations.append(Observation("conversion_rate", day, float(conversions) / float(sessions)))
        return observations

    @staticmethod
    async def _fetch(session, client_id: int, metric_key: str, start: date, end: date) -> dict[date, float | None]:
        result = await session.execute(
            select(MetricObservation.period_start, MetricObservation.value).where(
                MetricObservation.client_id == client_id,
                MetricObservation.metric_key == metric_key,
                MetricObservation.dimension_type == "site",
                MetricObservation.dimension_value == "__site__",
                MetricObservation.period_start.between(start, end),
            )
        )
        return {row.period_start: row.value for row in result}
