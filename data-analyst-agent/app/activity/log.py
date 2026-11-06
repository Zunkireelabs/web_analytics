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


# Written as the LAST step of a nightly run that finished every findings stage (analysis, insights, investigations,
# recommendations). Only a run that raised nowhere reaches it, so its presence is the one reliable "the findings are complete for
# today" signal. The analytics app's 05:30 orchestrator waits for exactly this row and refuses to use findings without it: a run
# that completed some stages and then failed (monitoring and forecasting done, investigating failed) must never look complete.
FINDINGS_COMPLETE_TASK = "findings_complete"


# How long a "running" row counts as a live run. A real production run takes several hours (monitoring and forecasting are about an
# hour each), so this is generous; older "running" rows are leftovers from a killed process (production has two, from August and
# October) and must not block anything.
RUN_IN_PROGRESS_HOURS = 8


async def run_in_progress(within_hours: int = RUN_IN_PROGRESS_HOURS):
    """When another nightly run is live (a task row still 'running', started within the window), returns when it started; else
    None. Both entry points call this before starting: production's scheduler is the only scheduled owner of the shared database,
    but a MANUAL staging run writes the same database and must never overlap it."""
    from datetime import timedelta

    from sqlalchemy import select

    cutoff = datetime.now(timezone.utc) - timedelta(hours=within_hours)
    async with SessionLocal() as session:
        return (await session.execute(
            select(AiActivityLog.started_at).where(AiActivityLog.status == "running", AiActivityLog.started_at >= cutoff)
            .order_by(AiActivityLog.started_at.desc()).limit(1)
        )).scalar_one_or_none()
