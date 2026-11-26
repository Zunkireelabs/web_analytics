"""Where the analysis pass writes what it did, and how an interrupted run is recognised and recovered.

Rows live in the existing ai_activity_log (see pass_runner.py for why no migration): one row per stage GROUP per attempt, with the
per-stage records, pass id, attempt number and owner in the JSON `detail`.

Interrupted runs. Production's scheduler runs inside the app container, and `docker compose up -d` on every deploy replaces that
container, killing a pass in progress. The row it was writing stays "running" forever (nine nights of "investigating" rows in
production). Two recoveries, both recorded, never silent:

  * at start-up, every row this service's SCHEDULER left "running" belongs to a process that no longer exists: mark it
    failed / outcome `interrupted` and its running stages `interrupted`. Rows owned by a manual run are left alone (a manual run
    on the same database may be live), and
  * at the start of any pass, any "running" row older than RUN_IN_PROGRESS_HOURS is dead for the same reason (this also closes the
    pre-existing orphans that have no owner on record).

A pass that was interrupted can be resumed: `find_resumable_pass` returns the latest scheduler pass that has an interrupted stage,
never reached a completed findings marker, is recent enough, and has attempts left. The resume runs only the stages that did not
complete (`completed_stages`)."""
from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone

from sqlalchemy import select, update

from app.activity.log import FINDINGS_COMPLETE_TASK, RUN_IN_PROGRESS_HOURS
from app.analysis.pass_runner import COMPLETED, INTERRUPTED, RUNNING, StageResult
from app.db.models import AiActivityLog
from app.db.session import SessionLocal

logger = logging.getLogger(__name__)

SCHEDULER = "scheduler"
MANUAL = "manual"
INTERRUPTED_REASON = "process ended before this stage finished (container restart or crash); recovered by the next start-up"


class DbLedger:
    async def open_group(self, pass_id: str, group: str, attempt: int, owner: str) -> int:
        async with SessionLocal() as session:
            row = AiActivityLog(
                client_id=None, task_type=group, status="running",
                detail={"pass_id": pass_id, "attempt": attempt, "owner": owner, "outcome": RUNNING, "stages": {}},
            )
            session.add(row)
            await session.commit()
            return row.id

    async def update_stage(self, handle: int, name: str, result: StageResult) -> None:
        async with SessionLocal() as session:
            row = await session.get(AiActivityLog, handle)
            detail = dict(row.detail or {})
            stages = dict(detail.get("stages") or {})
            stages[name] = result.as_detail()
            detail["stages"] = stages
            row.detail = detail  # reassigned, so the JSONB change is seen
            await session.commit()

    async def close_group(self, handle: int, status: str, outcome: str, error: str | None) -> None:
        async with SessionLocal() as session:
            row = await session.get(AiActivityLog, handle)
            detail = dict(row.detail or {})
            detail["outcome"] = outcome
            row.detail = detail
            row.status = status
            row.error = error
            row.finished_at = datetime.now(timezone.utc)
            if row.started_at is not None:
                row.took_ms = int((row.finished_at - row.started_at).total_seconds() * 1000)
            await session.commit()

    async def completed_stages(self, pass_id: str) -> set[str]:
        async with SessionLocal() as session:
            rows = (await session.execute(select(AiActivityLog.detail).where(AiActivityLog.detail["pass_id"].astext == pass_id))).scalars().all()
        done: set[str] = set()
        for detail in rows:
            for name, rec in ((detail or {}).get("stages") or {}).items():
                if rec.get("outcome") == COMPLETED:
                    done.add(name)
        return done

    async def next_attempt(self, pass_id: str) -> int:
        async with SessionLocal() as session:
            rows = (await session.execute(select(AiActivityLog.detail).where(AiActivityLog.detail["pass_id"].astext == pass_id))).scalars().all()
        return 1 + max([int((d or {}).get("attempt") or 1) for d in rows] or [0])

    async def write_marker(self, pass_id: str, complete: bool, error: str | None, detail: dict) -> None:
        """`findings_complete`, status `completed` only when every required stage completed; otherwise `failed` with the account.
        Never raises into the pass: if it cannot be written (migration 0042 not applied) the findings stay unconfirmed, which the
        Node side treats as not complete."""
        now = datetime.now(timezone.utc)
        try:
            async with SessionLocal() as session:
                session.add(AiActivityLog(
                    client_id=None, task_type=FINDINGS_COMPLETE_TASK, status="completed" if complete else "failed",
                    detail={"pass_id": pass_id, "complete": complete, **detail}, error=None if complete else error,
                    finished_at=now, took_ms=0,
                ))
                await session.commit()
        except Exception:
            logger.exception("findings_complete marker could not be written; today's findings stay unconfirmed")


async def recover_interrupted_runs(*, scheduler_owned_only: bool, older_than_hours: int | None = None) -> int:
    """Close rows a dead process left "running". Returns how many. Recorded as failed / outcome interrupted, never completed."""
    now = datetime.now(timezone.utc)
    async with SessionLocal() as session:
        query = select(AiActivityLog).where(AiActivityLog.status == "running")
        if older_than_hours is not None:
            query = query.where(AiActivityLog.started_at < now - timedelta(hours=older_than_hours))
        rows = (await session.execute(query)).scalars().all()
        closed = 0
        for row in rows:
            detail = dict(row.detail or {})
            if scheduler_owned_only and detail.get("owner") != SCHEDULER:
                continue
            stages = {n: dict(r) for n, r in (detail.get("stages") or {}).items()}
            for rec in stages.values():
                if rec.get("outcome") == RUNNING:
                    rec.update(outcome=INTERRUPTED, reason=INTERRUPTED_REASON)
            detail.update(stages=stages, outcome=INTERRUPTED)
            row.detail = detail
            row.status = "failed"
            row.error = f"interrupted: {INTERRUPTED_REASON}"
            row.finished_at = now
            if row.started_at is not None:
                row.took_ms = int((now - row.started_at).total_seconds() * 1000)
            closed += 1
        await session.commit()
    if closed:
        logger.warning("recovered %s interrupted analysis row(s): marked failed/interrupted, not completed", closed)
    return closed


def pick_resumable_pass(details: list[dict], max_attempts: int) -> tuple[str, int] | None:
    """Pure: from the `detail` of recent scheduler rows, the latest pass id that has an interrupted group and attempts left, with
    the attempts made so far. (The caller then checks it has no completed findings marker.)"""
    passes: dict[str, dict] = {}
    for d in details:
        pid = d.get("pass_id")
        if not pid:
            continue
        p = passes.setdefault(pid, {"attempts": 0, "interrupted": False})
        p["attempts"] = max(p["attempts"], int(d.get("attempt") or 1))
        p["interrupted"] = p["interrupted"] or d.get("outcome") == INTERRUPTED
    if not passes:
        return None
    pass_id = max(passes)  # pass ids are UTC timestamps, so the greatest is the latest
    info = passes[pass_id]
    if not info["interrupted"] or info["attempts"] >= max_attempts:
        return None
    return pass_id, info["attempts"]


async def find_resumable_pass(*, window_hours: int, max_attempts: int) -> tuple[str, int] | None:
    """(pass_id, attempts so far) of the latest scheduler pass that was interrupted, has no completed findings marker, started
    within `window_hours`, and has attempts left; else None."""
    since = datetime.now(timezone.utc) - timedelta(hours=window_hours)
    async with SessionLocal() as session:
        rows = (await session.execute(
            select(AiActivityLog).where(AiActivityLog.started_at >= since, AiActivityLog.detail["owner"].astext == SCHEDULER)
            .order_by(AiActivityLog.started_at.desc())
        )).scalars().all()
        picked = pick_resumable_pass([r.detail or {} for r in rows], max_attempts)
        if picked is None:
            return None
        pass_id, attempts = picked
        marker = (await session.execute(
            select(AiActivityLog.id).where(
                AiActivityLog.task_type == FINDINGS_COMPLETE_TASK, AiActivityLog.status == "completed",
                AiActivityLog.detail["pass_id"].astext == pass_id,
            ).limit(1)
        )).scalar_one_or_none()
        if marker is not None:
            return None
        return pass_id, attempts


class MemoryLedger:
    """The same interface held in memory, for tests: no database. `groups` are the rows exactly as the database ledger would write."""

    def __init__(self, completed_before: set[str] | None = None, attempt: int = 1):
        self.groups: list[dict] = []
        self.markers: list[dict] = []
        self._completed_before = completed_before or set()
        self._attempt = attempt

    async def open_group(self, pass_id, group, attempt, owner):
        row = {"task_type": group, "status": "running", "pass_id": pass_id, "attempt": attempt, "owner": owner, "stages": {}, "error": None, "outcome": RUNNING}
        self.groups.append(row)
        return row

    async def update_stage(self, handle, name, result):
        handle["stages"][name] = result.as_detail()

    async def close_group(self, handle, status, outcome, error):
        handle.update(status=status, outcome=outcome, error=error)

    async def completed_stages(self, pass_id):
        return set(self._completed_before)

    async def next_attempt(self, pass_id):
        return self._attempt + 1

    async def write_marker(self, pass_id, complete, error, detail):
        self.markers.append({"pass_id": pass_id, "complete": complete, "status": "completed" if complete else "failed", "error": error, **detail})
