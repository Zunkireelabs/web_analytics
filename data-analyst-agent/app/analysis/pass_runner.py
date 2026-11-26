"""Runs the nightly analysis as recorded, dependency-aware stages.

Before this, the pass was one long chain: any exception stopped everything after it, a process killed mid-run left a row stuck at
"running" forever, and nothing recorded which stage failed or why. Production showed the result: from 2026-11-16 the
"investigating" group never completed, the predictions inside it never ran, and nothing said so. This module makes the pass know
what it did:

  * every stage records its own outcome, duration and reason inside its group's activity-log row (`detail.stages`);
  * a stage whose dependency did not complete is recorded `blocked_by_dependency` (naming the dependency) and does not run;
  * a stage that needs fresh inputs (app/analysis/freshness.py) runs only for the clients that have them; the others are recorded
    in `excluded_clients` with the reason, and a stage with no eligible client is `insufficient_data`;
  * an independent stage still runs when an unrelated one failed (predictions do not wait behind the insight engine);
  * a failure is recorded with its full message and is never swallowed: the pass ends by raising PassIncomplete;
  * the `findings_complete` marker is `completed` ONLY when every required stage completed. Otherwise it is written `failed`
    with the stage-by-stage account, so nothing downstream can treat partial findings as complete.

No schema change: the activity table only allows the statuses queued/running/completed/failed (migration 0030), so the finer
outcomes live in the row's JSON `detail` and any row that is not fully completed has status `failed`. A migration widening those
constraints is the clean follow-up and needs separate approval."""
from __future__ import annotations

import logging
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Awaitable, Callable, Protocol

from app.analysis import freshness as fresh
from app.analysis.scope import collecting_failures, excluding

logger = logging.getLogger(__name__)

COMPLETED = "completed"
FAILED = "failed"
INTERRUPTED = "interrupted"
BLOCKED = "blocked_by_dependency"
INSUFFICIENT = "insufficient_data"
RUNNING = "running"

# Worst first, for summarising a group.
_SEVERITY = (FAILED, INTERRUPTED, BLOCKED, INSUFFICIENT)

MAX_ERROR_CHARS = 4000


class PassIncomplete(RuntimeError):
    """The pass finished but not every required stage completed. Raised AFTER the marker and the stage records are written, so
    the scheduler's log line and the records agree; nothing here is swallowed."""


@dataclass
class Stage:
    name: str
    group: str
    call: Callable[[], Awaitable]
    deps: tuple[str, ...] = ()
    needs_all: tuple[str, ...] = ()
    needs_any: tuple[str, ...] = ()
    required: bool = True


@dataclass
class StageResult:
    outcome: str
    reason: str | None = None
    error: str | None = None
    took_ms: int | None = None
    started_at: str | None = None
    finished_at: str | None = None
    excluded_clients: dict[int, str] = field(default_factory=dict)
    carried_over: bool = False

    def as_detail(self) -> dict:
        d = {"outcome": self.outcome, "reason": self.reason, "error": self.error, "took_ms": self.took_ms,
             "started_at": self.started_at, "finished_at": self.finished_at}
        if self.excluded_clients:
            d["excluded_clients"] = {str(k): v for k, v in self.excluded_clients.items()}
        if self.carried_over:
            d["carried_over"] = True
        return d


class Ledger(Protocol):
    async def open_group(self, pass_id: str, group: str, attempt: int, owner: str) -> object: ...
    async def update_stage(self, handle: object, name: str, result: StageResult) -> None: ...
    async def close_group(self, handle: object, status: str, outcome: str, error: str | None) -> None: ...
    async def completed_stages(self, pass_id: str) -> set[str]: ...
    async def next_attempt(self, pass_id: str) -> int: ...
    async def write_marker(self, pass_id: str, complete: bool, error: str | None, detail: dict) -> None: ...


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def describe_error(exc: BaseException) -> str:
    message = str(exc).strip() or "(no message)"
    return f"{type(exc).__name__}: {message}"[:MAX_ERROR_CHARS]


def _worst(outcomes: list[str]) -> str:
    for o in _SEVERITY:
        if o in outcomes:
            return o
    return COMPLETED


async def run_stages(
    stages: list[Stage], *, ledger: Ledger, pass_id: str, owner: str, freshness: dict[int, fresh.ClientFreshness],
    resume: bool = False,
) -> dict[str, StageResult]:
    """Run `stages` in the order given (the order is the pipeline's real dependency order; `deps` additionally say which earlier
    stage's SUCCESS a stage needs). Returns every stage's result."""
    results: dict[str, StageResult] = {}
    done_before = await ledger.completed_stages(pass_id) if resume else set()
    attempt = await ledger.next_attempt(pass_id) if resume else 1

    groups: list[str] = []
    for s in stages:
        if s.group not in groups:
            groups.append(s.group)

    for group in groups:
        group_stages = [s for s in stages if s.group == group]
        handle = await ledger.open_group(pass_id, group, attempt, owner)
        for stage in group_stages:
            result = await _run_one(stage, results, done_before, freshness)
            results[stage.name] = result
            await ledger.update_stage(handle, stage.name, result)
        # Only REQUIRED stages decide a group's status; an optional stage's failure is recorded in its own entry.
        deciding = [s for s in group_stages if s.required]
        outcome = _worst([results[s.name].outcome for s in deciding])
        failed_bits = [
            f"{s.name}: {results[s.name].outcome}"
            + (f" ({results[s.name].reason or results[s.name].error})" if (results[s.name].reason or results[s.name].error) else "")
            for s in deciding if results[s.name].outcome != COMPLETED
        ]
        await ledger.close_group(
            handle, status="completed" if outcome == COMPLETED else "failed", outcome=outcome,
            error="; ".join(failed_bits)[:MAX_ERROR_CHARS] or None,
        )
    return results


async def _run_one(stage: Stage, results: dict[str, StageResult], done_before: set[str], freshness: dict[int, fresh.ClientFreshness]) -> StageResult:
    if stage.name in done_before:
        return StageResult(COMPLETED, reason="completed in an earlier attempt of this pass", carried_over=True)

    for dep in stage.deps:
        dep_result = results.get(dep)
        if dep_result is None or dep_result.outcome != COMPLETED:
            what = dep_result.outcome if dep_result else "did not run"
            return StageResult(BLOCKED, reason=f"dependency {dep} {what}", started_at=_now_iso(), finished_at=_now_iso())

    excluded: dict[int, str] = {}
    if stage.needs_all or stage.needs_any:
        for client_id, f in freshness.items():
            ok, why = f.usable(stage.needs_all, stage.needs_any)
            if not ok:
                excluded[client_id] = why or "inputs not fresh"
        if freshness and len(excluded) == len(freshness):
            first = next(iter(excluded.values()))
            return StageResult(
                INSUFFICIENT, reason=f"no client has the fresh inputs this stage needs (e.g. {first})",
                excluded_clients=excluded, started_at=_now_iso(), finished_at=_now_iso(),
            )

    started_at, t0 = _now_iso(), time.monotonic()
    try:
        with excluding(excluded), collecting_failures() as client_failures:
            await stage.call()
    except Exception as exc:  # noqa: BLE001 — recorded in full below; the pass re-raises PassIncomplete at the end, never swallows
        logger.exception("analysis stage %s failed", stage.name)
        return StageResult(
            FAILED, error=describe_error(exc), took_ms=int((time.monotonic() - t0) * 1000),
            started_at=started_at, finished_at=_now_iso(), excluded_clients=excluded,
        )
    took_ms = int((time.monotonic() - t0) * 1000)
    if client_failures:
        # The engine isolated these clients' failures and carried on. They are failures of THIS stage for THOSE clients: recorded,
        # and those clients are left out of the findings' coverage. If every client the stage ran for failed, the stage failed.
        for cid, err in client_failures.items():
            excluded[cid] = f"stage failed for this client: {err}"
        ran_for = [cid for cid in freshness if cid not in excluded or cid in client_failures] if freshness else list(client_failures)
        if len(client_failures) >= len(ran_for):
            first = next(iter(client_failures.values()))
            return StageResult(
                FAILED, error=f"failed for every client it ran for ({len(client_failures)}): {first}"[:MAX_ERROR_CHARS], took_ms=took_ms,
                started_at=started_at, finished_at=_now_iso(), excluded_clients=excluded,
            )
    return StageResult(COMPLETED, took_ms=took_ms, started_at=started_at, finished_at=_now_iso(), excluded_clients=excluded)


def summarise(stages: list[Stage], results: dict[str, StageResult]) -> tuple[bool, str | None]:
    """(complete, why not). Complete means every REQUIRED stage completed in this pass (or an earlier attempt of it)."""
    bad = [f"{s.name}: {results[s.name].outcome}" for s in stages if s.required and s.name in results and results[s.name].outcome != COMPLETED]
    missing = [s.name for s in stages if s.required and s.name not in results]
    parts = bad + [f"{n}: not run" for n in missing]
    return (not parts), ("; ".join(parts) if parts else None)


def coverage(stages: list[Stage], results: dict[str, StageResult], client_ids: list[int]) -> tuple[list[int], dict[int, str]]:
    """Which clients every required stage covered, and for the rest the first reason they were left out."""
    excluded: dict[int, str] = {}
    for s in stages:
        if not s.required:
            continue
        r = results.get(s.name)
        if r is None:
            continue
        for cid, why in r.excluded_clients.items():
            excluded.setdefault(cid, f"{s.name}: {why}")
    return [c for c in client_ids if c not in excluded], excluded
