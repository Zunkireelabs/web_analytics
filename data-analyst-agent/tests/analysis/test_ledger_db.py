"""The activity ledger against a REAL Postgres, including the table's real CHECK constraints (status only queued/running/completed/
failed; task_type only the migration-0030/0042 values), which the in-memory tests cannot prove.

Opt-in and local-only: set DATABASE_URL to the scratch database on the local container (127.0.0.1:55432/analyst_stage1_test, after
`alembic upgrade head`). Anything else is skipped, so this can never run against production. It deletes the rows it creates."""
import pytest
import pytest_asyncio
from sqlalchemy import delete, select

from app.config import settings

LOCAL_SCRATCH = "127.0.0.1:55432/analyst_stage1_test"
pytestmark = [
    pytest.mark.skipif(LOCAL_SCRATCH not in settings.database_url, reason="opt-in: needs the local scratch analyst database"),
    pytest.mark.asyncio(loop_scope="module"),   # the service's engine is process-global: one loop for the whole module (see tests/conftest.py)
]

from app.activity.log import FINDINGS_COMPLETE_TASK  # noqa: E402
from app.analysis import freshness as fresh  # noqa: E402
from app.analysis.ledger import DbLedger, find_resumable_pass, recover_interrupted_runs  # noqa: E402
from app.analysis.pass_runner import Stage, run_stages, summarise  # noqa: E402
from app.db.models import AiActivityLog  # noqa: E402
from app.db.session import SessionLocal  # noqa: E402
from datetime import date  # noqa: E402

PID = "itest-2026-11-25T22:00Z"


async def _rows(pass_id=None):
    async with SessionLocal() as s:
        q = select(AiActivityLog).order_by(AiActivityLog.id)
        if pass_id:
            q = q.where(AiActivityLog.detail["pass_id"].astext == pass_id)
        return (await s.execute(q)).scalars().all()


@pytest_asyncio.fixture(autouse=True, loop_scope="module")
async def _clean():
    async def wipe():
        async with SessionLocal() as s:
            await s.execute(delete(AiActivityLog))
            await s.commit()
    await wipe()
    yield
    await wipe()


async def test_a_failing_pass_is_recorded_in_the_real_table_with_the_statement_timeout_visible_and_a_failed_marker():
    async def boom():
        raise RuntimeError("(asyncpg.Error) canceling statement due to statement timeout [SQL: DELETE FROM insights WHERE insights.id = $1]")

    async def fine():
        return None
    stages = [
        Stage("run_insight_engine", "investigating", boom),
        Stage("run_recommendation_engine", "generating_recommendations", fine, deps=("run_insight_engine",)),
        Stage("run_predictions", "investigating", fine),
    ]
    ledger = DbLedger()
    today = date(2026, 11, 25)
    results = await run_stages(stages, ledger=ledger, pass_id=PID, owner="scheduler",
                               freshness={1: fresh.evaluate(1, {"gsc_site": today, "ga4_site": today, "page_query": today}, today)})
    complete, why = summarise(stages, results)
    await ledger.write_marker(PID, complete, f"findings incomplete: {why}", {"stages": {n: r.outcome for n, r in results.items()}})

    rows = {r.task_type: r for r in await _rows()}
    inv = rows["investigating"]
    assert inv.status == "failed" and "statement timeout" in inv.error and inv.took_ms is not None and inv.finished_at is not None
    assert inv.detail["stages"]["run_insight_engine"]["outcome"] == "failed"
    assert inv.detail["stages"]["run_predictions"]["outcome"] == "completed"               # independent stage still ran
    assert rows["generating_recommendations"].detail["stages"]["run_recommendation_engine"]["outcome"] == "blocked_by_dependency"
    marker = rows[FINDINGS_COMPLETE_TASK]
    assert marker.status == "failed" and marker.detail["complete"] is False                # never completed


async def test_a_complete_pass_writes_a_completed_marker():
    ledger = DbLedger()
    await ledger.write_marker(PID, True, None, {"covered_clients": [1], "excluded_clients": {}})
    (marker,) = await _rows(PID)
    assert marker.task_type == FINDINGS_COMPLETE_TASK and marker.status == "completed" and marker.detail["covered_clients"] == [1]


async def test_start_up_recovery_closes_what_a_killed_scheduler_left_running_and_a_resume_is_offered_once():
    ledger = DbLedger()
    handle = await ledger.open_group(PID, "investigating", 1, "scheduler")      # left "running": the process was killed here
    manual = await ledger.open_group("itest-manual", "monitoring", 1, "manual")
    assert await find_resumable_pass(window_hours=20, max_attempts=3) is None   # nothing is marked interrupted yet

    closed = await recover_interrupted_runs(scheduler_owned_only=True)
    assert closed == 1
    by_id = {r.id: r for r in await _rows()}
    assert by_id[handle].status == "failed" and by_id[handle].detail["outcome"] == "interrupted" and "interrupted" in by_id[handle].error
    assert by_id[manual].status == "running"                                     # a manual run is not ours to close

    assert await find_resumable_pass(window_hours=20, max_attempts=3) == (PID, 1)
    assert await find_resumable_pass(window_hours=20, max_attempts=1) is None    # attempts used up

    await ledger.write_marker(PID, True, None, {})                               # once a completed marker exists there is nothing to resume
    assert await find_resumable_pass(window_hours=20, max_attempts=3) is None


async def test_a_resumed_attempt_runs_only_unfinished_stages_and_numbers_itself():
    ran = []

    async def a():
        ran.append("a")

    async def b():
        ran.append("b")
    stages = [Stage("run_stats", "monitoring", a), Stage("run_anomaly_detection", "monitoring", b)]
    ledger = DbLedger()
    h = await ledger.open_group(PID, "monitoring", 1, "scheduler")
    from app.analysis.pass_runner import StageResult
    await ledger.update_stage(h, "run_stats", StageResult("completed"))
    await ledger.close_group(h, "failed", "interrupted", "interrupted")

    results = await run_stages(stages, ledger=ledger, pass_id=PID, owner="scheduler", freshness={}, resume=True)
    assert ran == ["b"] and results["run_stats"].carried_over is True
    assert max(int((r.detail or {}).get("attempt") or 0) for r in await _rows(PID)) == 2
