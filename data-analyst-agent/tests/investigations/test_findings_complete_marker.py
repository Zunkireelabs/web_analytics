"""The orchestrator in the analytics app trusts ONE signal that today's findings are complete: a `findings_complete` activity row.
It must be `completed` only when every required stage completed, and a run that failed or was blocked part way must leave a FAILED
marker (never none, never completed): production had nights where monitoring and forecasting completed and investigating failed,
and those must not look complete. (Rewritten for the recorded-stage runner in app/analysis/pass_runner.py; the guarantee is the
same, now with the stage-by-stage account recorded in the marker.)"""
from datetime import date

import pytest

from app.analysis import freshness as fresh
from app.analysis import ledger as ledger_module
from app.analysis import run_pass
from app.analysis.ledger import MemoryLedger
from app.analysis.pass_runner import PassIncomplete

TODAY = date(2026, 11, 25)


def _stub_stages(monkeypatch, fail_at=None):
    calls = []
    for name in dir(run_pass):
        if name.startswith("run_") and name not in {"run_analysis_pass", "run_stages", "run_in_progress"} and callable(getattr(run_pass, name)):
            async def stage(*_a, _name=name, **_k):
                calls.append(_name)
                if _name == fail_at:
                    raise RuntimeError(f"{_name} failed")
            monkeypatch.setattr(run_pass, name, stage)
    monkeypatch.setattr(run_pass, "is_training_day", lambda *_: False, raising=False)

    async def has_model(*_a, **_k):
        return True
    monkeypatch.setattr(run_pass, "has_pooled_model", has_model, raising=False)

    async def nothing_running(*_a, **_k):
        return None
    monkeypatch.setattr(run_pass, "run_in_progress", nothing_running)

    async def no_recovery(**_kw):
        return 0
    monkeypatch.setattr(ledger_module, "recover_interrupted_runs", no_recovery)

    async def load_fresh():
        return {1: fresh.evaluate(1, {"gsc_site": TODAY, "ga4_site": TODAY, "page_query": TODAY}, TODAY)}
    monkeypatch.setattr(run_pass, "_load_freshness", load_fresh)

    async def notify():
        calls.append("send_nightly_notifications")
        return True
    monkeypatch.setattr(run_pass, "send_nightly_notifications", notify)
    memory = MemoryLedger()
    monkeypatch.setattr(run_pass, "DbLedger", lambda: memory)
    return calls, memory


@pytest.mark.asyncio
async def test_a_complete_run_writes_a_completed_marker_and_only_then_notifies(monkeypatch):
    calls, memory = _stub_stages(monkeypatch)
    await run_pass.run_analysis_pass()
    assert [m["status"] for m in memory.markers] == ["completed"]
    assert memory.markers[0]["complete"] is True and memory.markers[0]["covered_clients"] == [1]
    assert calls[-1] == "send_nightly_notifications"


@pytest.mark.asyncio
async def test_a_run_that_fails_part_way_writes_a_failed_marker_with_the_account_and_sends_nothing(monkeypatch):
    calls, memory = _stub_stages(monkeypatch, fail_at="run_investigation_engine")
    with pytest.raises(PassIncomplete):
        await run_pass.run_analysis_pass()
    assert [m["status"] for m in memory.markers] == ["failed"]          # a marker exists, and it is NOT completed
    marker = memory.markers[0]
    assert marker["complete"] is False and "run_investigation_engine" in marker["error"]
    assert marker["stages"]["run_investigation_engine"] == "failed"
    assert marker["stages"]["run_opportunity_rollup"] == "blocked_by_dependency"   # downstream of the failure never ran
    assert "send_nightly_notifications" not in calls


@pytest.mark.asyncio
async def test_a_run_where_no_client_has_fresh_inputs_is_never_complete(monkeypatch):
    calls, memory = _stub_stages(monkeypatch)

    async def all_stale():
        old = date(2026, 10, 1)
        return {1: fresh.evaluate(1, {"gsc_site": old, "ga4_site": old, "page_query": old}, TODAY)}
    monkeypatch.setattr(run_pass, "_load_freshness", all_stale)
    with pytest.raises(PassIncomplete):
        await run_pass.run_analysis_pass()
    assert memory.markers[0]["status"] == "failed"
    assert "send_nightly_notifications" not in calls
