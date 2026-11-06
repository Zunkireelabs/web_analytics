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
        "run_feature_importance", "run_insight_engine", "run_predictions", "run_pooled_training",
        "run_target_keyword_evidence", "run_cannibalization_detection", "run_root_cause_analysis",
        "run_recommendation_engine", "run_effort_estimation", "run_impact_prediction",
        "run_opportunity_scoring", "run_recommendation_prioritizer", "run_investigation_engine",
        "run_opportunity_rollup", "run_investigation_reasoning", "run_draft_trigger",
    ]
    for name in stage_names:
        async def _record(name=name):
            calls.append(name)
        monkeypatch.setattr(run_pass, name, _record)
    monkeypatch.setattr(run_pass, "is_training_day", lambda today: False)  # weekday-independent
    async def _has_model():
        return True
    monkeypatch.setattr(run_pass, "has_pooled_model", _has_model)
    # the "another run is live" guard reads the database; these tests are about stage ORDER, so nothing is running
    async def _nothing_running():
        return None
    monkeypatch.setattr(run_pass, "run_in_progress", _nothing_running)
    async def _notify():
        calls.append("send_nightly_notifications")
        return True
    monkeypatch.setattr(run_pass, "send_nightly_notifications", _notify)

    return calls


def test_run_analysis_pass_now_runs_the_full_batch_pipeline_in_dependency_order(monkeypatch):
    calls = _install_recorder(monkeypatch)

    asyncio.run(run_pass.run_analysis_pass())

    stage_order = [c for c in calls if not c.startswith("track:") and c != "send_nightly_notifications"]
    assert stage_order == [
        "run_stats", "run_anomaly_detection",
        "run_forecasts", "run_forecast_accuracy_evaluation", "run_investigation_outcome_evaluation",
        "run_feature_importance", "run_insight_engine", "run_predictions",
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

    stage_order = [c for c in calls if not c.startswith("track:") and c != "send_nightly_notifications"]
    assert stage_order.index("run_opportunity_scoring") < stage_order.index("run_draft_trigger")
    assert stage_order.index("run_recommendation_prioritizer") < stage_order.index("run_draft_trigger")
    assert stage_order.index("run_effort_estimation") < stage_order.index("run_opportunity_scoring")


def test_notifications_are_sent_by_the_scheduled_pass_after_the_findings_and_never_before(monkeypatch):
    # Decision (Nov 2026): production's scheduled pass sends the predictive alerts and the morning briefing, which only the staging
    # script used to send, at the same moment it did: after every findings stage. (Previously a deliberate exclusion.)
    calls = _install_recorder(monkeypatch)
    asyncio.run(run_pass.run_analysis_pass())
    assert calls[-1] == "send_nightly_notifications"
    assert calls.index("send_nightly_notifications") > calls.index("run_draft_trigger")


def test_a_pass_that_fails_part_way_sends_no_notifications(monkeypatch):
    calls = _install_recorder(monkeypatch)
    async def boom():
        calls.append("run_insight_engine")
        raise RuntimeError("insight engine failed")
    monkeypatch.setattr(run_pass, "run_insight_engine", boom)
    try:
        asyncio.run(run_pass.run_analysis_pass())
    except RuntimeError:
        pass
    assert "send_nightly_notifications" not in calls


def test_predictions_run_after_insights_and_before_recommendations_and_pooled_training_only_on_training_days(monkeypatch):
    calls = _install_recorder(monkeypatch)
    monkeypatch.setattr(run_pass, "is_training_day", lambda today: True)

    asyncio.run(run_pass.run_analysis_pass())

    order = [c for c in calls if not c.startswith("track:")]
    assert order.index("run_insight_engine") < order.index("run_pooled_training") < order.index("run_predictions") < order.index("run_recommendation_engine")


def test_first_ever_night_trains_even_when_it_is_not_a_monday(monkeypatch):
    calls = _install_recorder(monkeypatch)

    async def _no_model_yet():
        return False
    monkeypatch.setattr(run_pass, "has_pooled_model", _no_model_yet)

    asyncio.run(run_pass.run_analysis_pass())

    assert "run_pooled_training" in calls


def test_pooled_training_is_a_monday_job():
    from datetime import date
    assert run_pass.is_training_day(date(2026, 10, 26)) is True   # Monday
    assert run_pass.is_training_day(date(2026, 10, 28)) is False  # Wednesday
