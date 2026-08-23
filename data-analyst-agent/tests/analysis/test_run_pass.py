"""Prompt 7 audit, section 11/12: the batch intelligence pipeline (effort
estimation, impact prediction, opportunity scoring, the prioritizer's
cross-recommendation ranking, forecast accuracy evaluation, investigation
outcome evaluation, opportunity rollup) previously ran ONLY from
scripts/run_nightly_pipeline.py, whose only documented trigger is a host
crontab line docker-compose.yml says nothing in this repo installs — so in
practice it never ran automatically. run_analysis_pass() (the function
app/ingestion/scheduler.py actually schedules) now includes every one of
those stages, in the same dependency order scripts/run_nightly_pipeline.py
uses. This proves that ordering from the actual code, not from re-reading
the docstring.

No test harness/DB fixtures exist anywhere else in this repo (see
tests/investigations/test_drafts.py's own docstring) — same convention
here: every stage function and the track() context manager are monkeypatched
to record their own name, so this never touches a real database or event
loop beyond asyncio.run.
"""
import asyncio
from contextlib import asynccontextmanager

from app.analysis import run_pass


def _install_recorder(monkeypatch):
    calls = []

    async def _noop_track(task_type, **_kw):
        calls.append(f"track:{task_type}")
        yield

    monkeypatch.setattr(run_pass, "track", lambda task_type, **kw: asynccontextmanager(_noop_track)(task_type, **kw))

    stage_names = [
        "run_stats", "run_anomaly_detection", "run_forecasts",
        "run_forecast_accuracy_evaluation", "run_investigation_outcome_evaluation",
        "run_feature_importance", "run_insight_engine",
        "run_target_keyword_evidence", "run_cannibalization_detection", "run_root_cause_analysis",
        "run_recommendation_engine", "run_effort_estimation", "run_impact_prediction",
        "run_opportunity_scoring", "run_recommendation_prioritizer", "run_investigation_engine",
        "run_opportunity_rollup", "run_investigation_reasoning", "run_draft_trigger",
    ]
    for name in stage_names:
        async def _record(name=name):
            calls.append(name)
        monkeypatch.setattr(run_pass, name, _record)

    return calls


def test_run_analysis_pass_now_runs_the_full_batch_pipeline_in_dependency_order(monkeypatch):
    calls = _install_recorder(monkeypatch)

    asyncio.run(run_pass.run_analysis_pass())

    stage_order = [c for c in calls if not c.startswith("track:")]
    assert stage_order == [
        "run_stats", "run_anomaly_detection",
        "run_forecasts", "run_forecast_accuracy_evaluation", "run_investigation_outcome_evaluation",
        "run_feature_importance", "run_insight_engine",
        "run_target_keyword_evidence", "run_cannibalization_detection", "run_root_cause_analysis",
        "run_recommendation_engine", "run_effort_estimation", "run_impact_prediction",
        "run_opportunity_scoring", "run_recommendation_prioritizer",
        "run_investigation_engine", "run_opportunity_rollup", "run_investigation_reasoning",
        "run_draft_trigger",
    ]


def test_opportunity_scoring_and_prioritizer_run_before_the_draft_trigger(monkeypatch):
    # The whole point of scheduling these: a real batch-ranked priority_score
    # must already exist by the time run_draft_trigger reads it, so its
    # on-demand per-recommendation fallback (app/investigations/drafts.py)
    # is a safety net, not the primary computation path.
    calls = _install_recorder(monkeypatch)

    asyncio.run(run_pass.run_analysis_pass())

    stage_order = [c for c in calls if not c.startswith("track:")]
    assert stage_order.index("run_opportunity_scoring") < stage_order.index("run_draft_trigger")
    assert stage_order.index("run_recommendation_prioritizer") < stage_order.index("run_draft_trigger")
    assert stage_order.index("run_effort_estimation") < stage_order.index("run_opportunity_scoring")


def test_predictive_alerts_and_briefings_remain_deliberately_unscheduled(monkeypatch):
    # A product decision (cadence/opt-in), not a scheduling bug — see the
    # module docstring. Proves the pass never imports/calls either.
    import inspect
    source = inspect.getsource(run_pass)
    assert "deliver_predictive_alerts" not in source
    assert "generate_morning_briefing" not in source
