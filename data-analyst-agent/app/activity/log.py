"""AI Activity Log / Command Center (Phase 3 Step 9) — track() wraps a
group of nightly-pipeline stage calls without touching any of their
internals: writes a 'running' row on entry, 'completed'/'failed' (with
took_ms, and error on failure) on exit. See AiActivityLog's own docstring
in app/db/models.py for why this is stage-level, not per-client."""
import time
from contextlib import asynccontextmanager
from datetime import datetime, timezone

from app.db.models import AiActivityLog
from app.db.session import SessionLocal


@asynccontextmanager
async def track(task_type: str, *, client_id: int | None = None, detail: dict | None = None):
    async with SessionLocal() as session:
        entry = AiActivityLog(client_id=client_id, task_type=task_type, status="running", detail=detail)
        session.add(entry)
        await session.commit()
        entry_id = entry.id

    start = time.monotonic()
    try:
        yield
    except Exception as e:
        async with SessionLocal() as session:
            row = await session.get(AiActivityLog, entry_id)
            row.status = "failed"
            row.error = str(e)
            row.finished_at = datetime.now(timezone.utc)
            row.took_ms = int((time.monotonic() - start) * 1000)
            await session.commit()
        raise
    else:
        async with SessionLocal() as session:
            row = await session.get(AiActivityLog, entry_id)
            row.status = "completed"
            row.finished_at = datetime.now(timezone.utc)
            row.took_ms = int((time.monotonic() - start) * 1000)
            await session.commit()
