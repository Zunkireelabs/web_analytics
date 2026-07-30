from abc import ABC, abstractmethod
from dataclasses import dataclass
from datetime import date

from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import Client
from app.mcp_client.client import McpClient


@dataclass
class Observation:
    metric_key: str
    period_start: date
    value: float | None
    dimension_type: str = "site"
    dimension_value: str = "__site__"


class Collector(ABC):
    """One independent ingestion unit. A future collector (breakdowns,
    authority, ai-recommendation, competitor) is just a new subclass
    registered in registry.py — never a change to run_nightly.py or to
    any other collector."""

    collector_id: str
    metric_keys: list[str]
    requires_mcp: bool = True

    @abstractmethod
    async def collect(
        self,
        *,
        session: AsyncSession,
        client: Client,
        mcp: McpClient | None,
        window_start: date,
        window_end: date,
    ) -> list[Observation]:
        """Return every observation this collector produced for the window.
        Raise McpAuthError/McpToolError on failure — run_nightly.py catches
        these per (collector, client) and records ingestion_runs accordingly.
        Never fabricate a value for a day with no real data — omit it or
        return None, never 0 or an interpolated guess."""
        raise NotImplementedError
