"""Never two Data Analyst runs at once on the shared database. Production's scheduler is the only scheduled owner; a manual staging
run writes the same database, so both entry points refuse to start while another run is live.

Needs a real Postgres with this service's schema (ANALYST_TEST_DATABASE_URL, and DATABASE_URL pointing at the same database so the
service's own session sees the rows). Skipped otherwise. Removes its own rows."""
import os
from datetime import datetime, timedelta, timezone

import pytest

DB_URL = os.environ.get("ANALYST_TEST_DATABASE_URL")
pytestmark = [
    pytest.mark.skipif(not DB_URL or os.environ.get("DATABASE_URL") != DB_URL,
                       reason="set ANALYST_TEST_DATABASE_URL and DATABASE_URL to the same test database"),
    # the service's session pool is process-global, so these tests share one event loop instead of one per test
    pytest.mark.asyncio(loop_scope="module"),
]


async def _insert_running(hours_ago: float) -> int:
    from sqlalchemy import text
    from app.db.session import SessionLocal
    async with SessionLocal() as s:
        rid = (await s.execute(text("INSERT INTO ai_activity_log (task_type, status, started_at) VALUES ('monitoring', 'running', :t) RETURNING id"),
                               {"t": datetime.now(timezone.utc) - timedelta(hours=hours_ago)})).scalar_one()
        await s.commit()
        return rid


async def _delete(rid: int) -> None:
    from sqlalchemy import text
    from app.db.session import SessionLocal
    async with SessionLocal() as s:
        await s.execute(text("DELETE FROM ai_activity_log WHERE id = :i"), {"i": rid})
        await s.commit()


async def _clear_recent_running():
    from sqlalchemy import text
    from app.db.session import SessionLocal
    async with SessionLocal() as s:
        await s.execute(text("UPDATE ai_activity_log SET status = 'failed', finished_at = now() WHERE status = 'running' AND started_at > now() - interval '9 hours'"))
        await s.commit()


async def test_a_live_run_is_reported_and_a_stale_leftover_is_not():
    from app.activity.log import run_in_progress
    await _clear_recent_running()
    stale = await _insert_running(hours_ago=30)          # a killed process from long ago
    try:
        assert await run_in_progress() is None
        live = await _insert_running(hours_ago=1)
        try:
            assert await run_in_progress() is not None
        finally:
            await _delete(live)
    finally:
        await _delete(stale)


async def test_the_analysis_pass_does_not_start_while_another_run_is_live(monkeypatch):
    import contextlib
    from app.analysis import run_pass
    await _clear_recent_running()
    started = []

    @contextlib.asynccontextmanager
    async def fake_track(task_type, **_):
        started.append(task_type)
        yield

    monkeypatch.setattr(run_pass, "track", fake_track)
    live = await _insert_running(hours_ago=0.5)
    try:
        await run_pass.run_analysis_pass()
        assert started == [], "no stage may start while another run is live"
    finally:
        await _delete(live)
