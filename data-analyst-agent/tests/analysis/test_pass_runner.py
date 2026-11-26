"""The recorded, dependency-aware stage runner (app/analysis/pass_runner.py), including fault injection that reproduces, word for
word, the two production failures from the audit: the 2026-11-16 statement timeout and the 2026-11-18 read-only transaction error.
They must be VISIBLE (recorded with their full message and type), not reclassified, hidden or swallowed."""
import asyncio
from datetime import date, timedelta
from types import SimpleNamespace

from app.analysis import freshness as fresh
from app.analysis import scope
from app.analysis.ledger import INTERRUPTED_REASON, MemoryLedger, pick_resumable_pass, recover_interrupted_runs
from app.analysis.pass_runner import (
    BLOCKED, COMPLETED, FAILED, INSUFFICIENT, Stage, coverage, run_stages, summarise,
)

TODAY = date(2026, 11, 25)
STATEMENT_TIMEOUT = (
    "(sqlalchemy.dialects.postgresql.asyncpg.Error) canceling statement due to statement timeout\n"
    "[SQL: DELETE FROM insights WHERE insights.id = $1::BIGINT]"
)
READ_ONLY = "(sqlalchemy.dialects.postgresql.asyncpg.Error) cannot execute INSERT in a read-only transaction\n[SQL: INSERT INTO feature_importance_runs"


def _fresh(cid=1, **ages):
    base = {"gsc_site": 1, "ga4_site": 1, "page_query": 1}
    base.update(ages)
    return fresh.evaluate(cid, {k: TODAY - timedelta(days=v) for k, v in base.items()}, TODAY)


def _run(stages, freshness=None, ledger=None, **kw):
    ledger = ledger or MemoryLedger()
    results = asyncio.run(run_stages(stages, ledger=ledger, pass_id="p1", owner="scheduler",
                                     freshness=freshness if freshness is not None else {1: _fresh()}, **kw))
    return results, ledger


def _ok(log, name):
    async def call():
        log.append(name)
    return call


def _boom(log, name, message):
    async def call():
        log.append(name)
        raise RuntimeError(message)
    return call


def test_a_failure_is_recorded_verbatim_and_the_dependent_stage_is_blocked_not_run():
    log = []
    stages = [
        Stage("run_insight_engine", "investigating", _boom(log, "run_insight_engine", STATEMENT_TIMEOUT)),
        Stage("run_recommendation_engine", "generating_recommendations", _ok(log, "run_recommendation_engine"), deps=("run_insight_engine",)),
    ]
    results, ledger = _run(stages)
    assert results["run_insight_engine"].outcome == FAILED
    assert "canceling statement due to statement timeout" in results["run_insight_engine"].error
    assert results["run_insight_engine"].error.startswith("RuntimeError:")            # the real exception type is kept
    assert results["run_recommendation_engine"].outcome == BLOCKED
    assert "dependency run_insight_engine failed" in results["run_recommendation_engine"].reason
    assert log == ["run_insight_engine"]                                              # the dependent never ran
    groups = {g["task_type"]: g for g in ledger.groups}
    assert groups["investigating"]["status"] == "failed" and "statement timeout" in groups["investigating"]["error"]
    assert groups["generating_recommendations"]["status"] == "failed"
    assert groups["investigating"]["stages"]["run_insight_engine"]["took_ms"] is not None   # duration recorded


def test_the_read_only_transaction_error_is_recorded_as_itself():
    log = []
    results, _ = _run([Stage("run_feature_importance", "investigating", _boom(log, "x", READ_ONLY))])
    r = results["run_feature_importance"]
    assert r.outcome == FAILED and "cannot execute INSERT in a read-only transaction" in r.error
    assert "timeout" not in r.error                                                    # not folded into any other class


def test_predictions_still_run_when_the_insight_engine_failed_because_they_do_not_depend_on_it():
    log = []
    stages = [
        Stage("run_insight_engine", "investigating", _boom(log, "run_insight_engine", STATEMENT_TIMEOUT)),
        Stage("run_predictions", "investigating", _ok(log, "run_predictions"), needs_all=("gsc_site", "page_query")),
    ]
    results, _ = _run(stages)
    assert results["run_predictions"].outcome == COMPLETED and log == ["run_insight_engine", "run_predictions"]
    complete, why = summarise(stages, results)
    assert complete is False and "run_insight_engine: failed" in why                   # but the pass is still NOT complete


def test_predictions_do_not_run_on_a_client_whose_page_data_is_stale_and_say_why():
    seen = {}

    async def predict():
        seen["excluded"] = set(scope._excluded.get())
    stages = [Stage("run_predictions", "investigating", predict, needs_all=("gsc_site", "page_query"))]
    results, _ = _run(stages, freshness={1: _fresh(1), 2: _fresh(2, page_query=40)})
    assert seen["excluded"] == {2}                                                     # the stage ran, but without client 2
    r = results["run_predictions"]
    assert r.outcome == COMPLETED and "page_query" in r.excluded_clients[2] and "40 day(s) old" in r.excluded_clients[2]
    covered, excluded = coverage(stages, results, [1, 2])
    assert covered == [1] and 2 in excluded


def test_a_stage_with_no_eligible_client_is_insufficient_data_and_its_dependents_are_blocked():
    log = []
    stale = {1: _fresh(1, gsc_site=40, ga4_site=40, page_query=40)}
    stages = [
        Stage("run_forecasts", "forecasting", _ok(log, "run_forecasts"), needs_any=("gsc_site", "ga4_site")),
        Stage("run_insight_engine", "investigating", _ok(log, "run_insight_engine"), deps=("run_forecasts",)),
    ]
    results, _ = _run(stages, freshness=stale)
    assert results["run_forecasts"].outcome == INSUFFICIENT and "no client has the fresh inputs" in results["run_forecasts"].reason
    assert results["run_insight_engine"].outcome == BLOCKED and log == []
    assert summarise(stages, results)[0] is False


def test_an_engine_that_isolates_a_client_failure_is_no_longer_silent():
    async def per_client():
        try:
            raise RuntimeError(READ_ONLY)
        except RuntimeError:
            scope.note_client_failure(2)                     # what the engines' except-blocks now call
    stages = [Stage("run_predictions", "investigating", per_client)]
    results, _ = _run(stages, freshness={1: _fresh(1), 2: _fresh(2)})
    r = results["run_predictions"]
    assert r.outcome == COMPLETED                              # it ran for client 1
    assert "read-only transaction" in r.excluded_clients[2]    # client 2's failure is recorded against the stage...
    assert coverage(stages, results, [1, 2])[0] == [1]         # ...and client 2 is not covered


def test_when_every_client_fails_inside_the_engine_the_stage_failed():
    async def per_client():
        for cid in (1, 2):
            try:
                raise RuntimeError(STATEMENT_TIMEOUT)
            except RuntimeError:
                scope.note_client_failure(cid)
    results, _ = _run([Stage("run_predictions", "investigating", per_client)], freshness={1: _fresh(1), 2: _fresh(2)})
    assert results["run_predictions"].outcome == FAILED and "failed for every client" in results["run_predictions"].error


def test_an_optional_stage_failure_is_recorded_but_does_not_make_the_group_or_the_pass_incomplete():
    log = []
    stages = [
        Stage("run_pooled_training", "investigating", _boom(log, "t", "training failed"), required=False),
        Stage("run_predictions", "investigating", _ok(log, "p")),
    ]
    results, ledger = _run(stages)
    assert results["run_pooled_training"].outcome == FAILED and "training failed" in results["run_pooled_training"].error
    assert ledger.groups[0]["status"] == "completed"
    assert ledger.groups[0]["stages"]["run_pooled_training"]["outcome"] == FAILED      # still on the record
    assert summarise(stages, results)[0] is True


def test_a_resumed_pass_runs_only_the_stages_that_did_not_complete():
    log = []
    stages = [
        Stage("run_stats", "monitoring", _ok(log, "run_stats")),
        Stage("run_insight_engine", "investigating", _ok(log, "run_insight_engine"), deps=("run_stats",)),
    ]
    ledger = MemoryLedger(completed_before={"run_stats"}, attempt=1)
    results, ledger = _run(stages, ledger=ledger, resume=True)
    assert log == ["run_insight_engine"]                                                # run_stats was not run again
    assert results["run_stats"].carried_over is True and results["run_insight_engine"].outcome == COMPLETED
    assert ledger.groups[0]["attempt"] == 2
    assert summarise(stages, results)[0] is True


def test_the_latest_interrupted_pass_with_attempts_left_is_the_one_to_resume():
    details = [
        {"pass_id": "2026-11-24T22:00Z", "attempt": 1, "outcome": "interrupted"},
        {"pass_id": "2026-11-25T22:00Z", "attempt": 1, "outcome": "interrupted"},
        {"pass_id": "2026-11-25T22:00Z", "attempt": 2, "outcome": "completed"},
    ]
    assert pick_resumable_pass(details, max_attempts=3) == ("2026-11-25T22:00Z", 2)
    assert pick_resumable_pass(details, max_attempts=2) is None                         # attempts used up
    assert pick_resumable_pass([{"pass_id": "p", "attempt": 1, "outcome": "failed"}], 3) is None   # failed, not interrupted: no blind retry
    assert pick_resumable_pass([], 3) is None


class _FakeSession:
    def __init__(self, rows):
        self.rows, self.committed = rows, False

    async def __aenter__(self):
        return self

    async def __aexit__(self, *a):
        return False

    async def execute(self, _query):
        rows = self.rows
        return SimpleNamespace(scalars=lambda: SimpleNamespace(all=lambda: rows))

    async def commit(self):
        self.committed = True


def _row(owner, stages=None):
    return SimpleNamespace(status="running", error=None, finished_at=None, took_ms=None,
                           started_at=__import__("datetime").datetime(2026, 11, 25, 4, 0, tzinfo=__import__("datetime").timezone.utc),
                           detail={"owner": owner, "stages": stages or {}, "outcome": "running"} if owner else None)


def test_start_up_recovery_closes_scheduler_rows_as_interrupted_and_leaves_manual_runs_alone(monkeypatch):
    from app.analysis import ledger as ledger_module
    sched = _row("scheduler", {"run_predictions": {"outcome": "running"}, "run_stats": {"outcome": "completed"}})
    manual = _row("manual")
    legacy = _row(None)
    monkeypatch.setattr(ledger_module, "SessionLocal", lambda: _FakeSession([sched, manual, legacy]))
    closed = asyncio.run(recover_interrupted_runs(scheduler_owned_only=True))
    assert closed == 1
    assert sched.status == "failed" and sched.status != "completed"
    assert sched.detail["outcome"] == "interrupted"
    assert sched.detail["stages"]["run_predictions"]["outcome"] == "interrupted"
    assert sched.detail["stages"]["run_stats"]["outcome"] == "completed"                # finished work is not rewritten
    assert INTERRUPTED_REASON in sched.error
    assert manual.status == "running" and legacy.status == "running"                    # not ours to close at start-up


def test_old_running_rows_with_no_owner_are_closed_as_interrupted_at_pass_start(monkeypatch):
    from app.analysis import ledger as ledger_module
    legacy = _row(None)
    monkeypatch.setattr(ledger_module, "SessionLocal", lambda: _FakeSession([legacy]))
    assert asyncio.run(recover_interrupted_runs(scheduler_owned_only=False, older_than_hours=8)) == 1
    assert legacy.status == "failed" and legacy.detail["outcome"] == "interrupted"
