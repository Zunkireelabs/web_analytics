"""The orchestrator in the analytics app trusts ONE signal that today's findings are complete: a `findings_complete` activity row.
It must be written only when every findings stage finished, and never after a stage failed (production had nights where
monitoring and forecasting completed and investigating failed; those must not look complete)."""
import contextlib

import pytest

from app.activity.log import FINDINGS_COMPLETE_TASK
from app.analysis import run_pass


def _stub_stages(monkeypatch, fail_at=None):
    tracked = []

    @contextlib.asynccontextmanager
    async def fake_track(task_type, **_):
        tracked.append(task_type)
        yield

    monkeypatch.setattr(run_pass, "track", fake_track)
    for name in dir(run_pass):
        if name.startswith("run_") and name != "run_analysis_pass" and callable(getattr(run_pass, name)):
            async def stage(*_a, _name=name, **_k):
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

    async def notify():
        tracked.append("send_nightly_notifications")
        return True

    monkeypatch.setattr(run_pass, "send_nightly_notifications", notify)
    return tracked


@pytest.mark.asyncio
async def test_a_complete_run_ends_with_the_findings_complete_marker(monkeypatch):
    tracked = _stub_stages(monkeypatch)
    await run_pass.run_analysis_pass()
    # the marker is the last FINDINGS step; the customer notifications follow it
    assert tracked[-2:] == [FINDINGS_COMPLETE_TASK, "send_nightly_notifications"]


@pytest.mark.asyncio
async def test_a_run_that_fails_part_way_never_writes_the_marker(monkeypatch):
    tracked = _stub_stages(monkeypatch, fail_at="run_investigation_engine")
    with pytest.raises(RuntimeError):
        await run_pass.run_analysis_pass()
    assert FINDINGS_COMPLETE_TASK not in tracked
