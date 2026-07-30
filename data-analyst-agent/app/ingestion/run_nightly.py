import asyncio
import time
from datetime import date, timedelta

from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.collectors.registry import get_enabled_collectors
from app.config import settings
from app.db.models import Client, IngestionRun, MetricObservation
from app.db.session import SessionLocal
from app.mcp_client.client import McpAuthError, McpClient, McpToolError


async def run_nightly(today: date | None = None) -> None:
    today = today or date.today()
    window_start = today - timedelta(days=settings.ingest_lookback_days)

    async with SessionLocal() as session:
        clients = (
            await session.execute(select(Client).where(Client.status == "active"))
        ).scalars().all()
        collectors = await get_enabled_collectors(session)

    for client in clients:
        for collector in collectors:
            await _run_one(client, collector, window_start, today)


async def _run_one(client: Client, collector, window_start: date, window_end: date) -> None:
    """Isolated per (client, collector) — one failure never blocks any other
    client or collector. Errors are recorded, never raised further."""
    started = time.monotonic()
    status, error = "ok", None

    try:
        mcp = McpClient(client.mcp_token_ciphertext) if collector.requires_mcp else None
        async with SessionLocal() as session:
            observations = await collector.collect(
                session=session, client=client, mcp=mcp,
                window_start=window_start, window_end=window_end,
            )
            if not observations:
                status = "insufficient-data"
            else:
                await _upsert_observations(session, client.id, observations)
            await session.commit()
    except McpAuthError as e:
        status, error = "insufficient-data", str(e)
    except McpToolError as e:
        status, error = "error", str(e)
    except Exception as e:  # noqa: BLE001 — deliberately broad: this must never propagate
        status, error = "error", str(e)

    took_ms = int((time.monotonic() - started) * 1000)
    async with SessionLocal() as session:
        session.add(IngestionRun(
            client_id=client.id, collector_id=collector.collector_id,
            run_date=window_end, status=status, error=error, took_ms=took_ms,
        ))
        await session.commit()


async def _upsert_observations(session: AsyncSession, client_id: int, observations: list) -> None:
    for obs in observations:
        stmt = pg_insert(MetricObservation).values(
            client_id=client_id, metric_key=obs.metric_key,
            dimension_type=obs.dimension_type, dimension_value=obs.dimension_value,
            period_start=obs.period_start, value=obs.value,
        )
        stmt = stmt.on_conflict_do_update(
            index_elements=["client_id", "metric_key", "dimension_type", "dimension_value", "period_start"],
            set_={"value": stmt.excluded.value},
        )
        await session.execute(stmt)


if __name__ == "__main__":
    asyncio.run(run_nightly())
