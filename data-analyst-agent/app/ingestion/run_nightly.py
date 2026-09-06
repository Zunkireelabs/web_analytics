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


def _describe(exc: BaseException) -> str:
    """Never returns an empty string.

    `str(exc)` alone hid a twelve-day production outage. Every MCP-backed
    collector failed nightly from 2026-08-23 onward because the standalone
    MCP server (mcp-server/index.js, port 3003) was not running, and httpx's
    connect/timeout exceptions carry an EMPTY message — so `str(e)` wrote
    `error = ''` into ingestion_runs on all eleven of them. The rows said
    'error' with nothing beside it, `metric_observations` silently stopped at
    2026-08-21, and the forecast/anomaly/insight engines downstream kept
    running and kept publishing confident output computed from data that had
    stopped moving. The anomaly detector looked broken; its input was dead.

    Falling back to the exception's type name guarantees a failure always
    names itself, which is the difference between a bad night and a fortnight
    of nobody noticing.
    """
    message = str(exc).strip()
    if message:
        return f"{type(exc).__name__}: {message}"
    # httpx.ConnectError / ConnectTimeout / ReadTimeout land here.
    cause = exc.__cause__ or exc.__context__
    if cause is not None and str(cause).strip():
        return f"{type(exc).__name__} (via {type(cause).__name__}: {str(cause).strip()})"
    return f"{type(exc).__name__} (no message)"


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
            if collector.writes_own_storage:
                # Already persisted directly within collect() using the
                # passed session — an empty return here is expected, not a
                # failure signal (the collector would have raised on a real
                # MCP failure).
                status = "ok"
            elif not observations:
                status = "insufficient-data"
            else:
                await _upsert_observations(session, client.id, observations)
            await session.commit()
    except McpAuthError as e:
        status, error = "insufficient-data", _describe(e)
    except McpToolError as e:
        status, error = "error", _describe(e)
    except Exception as e:  # noqa: BLE001 — deliberately broad: this must never propagate
        status, error = "error", _describe(e)

    if status == "error":
        # Loud on the way out as well as recorded. A collector that fails
        # every night for twelve days (see _describe) produced no log line
        # anyone was reading and no alert — the only trace was a row in
        # ingestion_runs nobody queries.
        print(f"[run_nightly] collector {collector.collector_id} FAILED for client {client.id}: {error}", flush=True)

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
