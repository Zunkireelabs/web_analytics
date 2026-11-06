"""Single nightly entrypoint chaining the full pipeline in order:
Collectors -> Metric Cache -> Statistics/Forecast/Anomaly Engines ->
Feature Importance Engine -> Insight Engine -> Root Cause Analysis Engine ->
Recommendation Engine -> Effort Estimation Engine -> Time-to-Impact
Prediction Engine -> Opportunity Scoring Engine -> Recommendation
Prioritizer -> Investigation Engine -> Predictive Alert Delivery. Each stage
reads only what the previous stage wrote (alert delivery reads the
Recommendation text the prior stage just wrote, when available). Feature
Importance runs after Forecasts but before Insights — it's descriptive of a
metric's whole history, independent of that night's insights, but early
enough that a later stage could cite it. Root Cause Analysis runs right
after Insights, since it's triggered BY that night's anomaly/trend_shift
insights, and before Recommendations so a future recommendation pass could
cite it too. Effort Estimation and Time-to-Impact Prediction both run after
Recommendations, since both key off recommendation_id (a property of the
recommended fix, not the underlying insight) — order between the two
doesn't matter, neither reads the other's output. Opportunity Scoring runs
after Effort Estimation (consumes its affected_page_count/effort_level) and
also calls the ROI Estimation engine (app/scoring/impact_projection.py)
inline per recommendation — there's no separate standalone nightly step for
ROI Estimation, since it's only otherwise invoked on demand (the executive
summary, the direct API route). The Recommendation Prioritizer runs after
that, since its formula consumes Opportunity Scoring's and Effort
Estimation's output. Forecast Accuracy Evaluation (Phase 3 AI memory — see
app/forecast/accuracy.py) runs right after Forecasts, since it only needs
ForecastRun/ForecastPoint plus whatever MetricObservations already landed —
independent of everything else, placed here so it's evaluated early and
available to any later stage. Investigation Outcome Evaluation (Phase 4 —
see app/investigations/outcome.py) runs right after that, for the same
reason: it only needs an already-approved Investigation's own captured
forecast_outlook plus whatever MetricObservations already landed today,
closing the 'approved' -> 'completed' transition the Investigation lifecycle
always allowed but nothing wrote until this stage existed. The Investigation Engine (Phase 3 — see
app/investigations/engine.py) runs after the Prioritizer, since it
summarizes ALL of the above into one persistent Investigation row per
(client, metric, dimension, insight_type) — it needs every upstream
engine's output to already exist for tonight's recommendations. The
Opportunity Rollup and Investigation Reasoning stages (also Phase 3) both
run after the Investigation Engine, since they key off investigation_id.
The Draft Trigger stage (Phase 3 Step 7 — see app/investigations/drafts.py)
runs after those three, since it only acts on investigations already at
'recommendation_generated'; it's the one stage that can advance an
Investigation to 'draft_prepared' automatically, everything past that
requires a human review action.

Every stage is wrapped in app/activity/log.track() (Phase 3 Step 9 — AI
Command Center), grouped into task_types rather than one row per function:
'monitoring' (ingest/stats/anomalies), 'forecasting' (forecasts + accuracy
evaluation), 'investigating' (feature importance/insight engine/root cause
— NOT the Investigation Engine itself, despite the name overlap; that one
must stay grouped with the recommendation stages it depends on),
'generating_recommendations' (recommendation/intelligence engines through
the Investigation Engine, Opportunity Rollup, and Investigation Reasoning
— kept in one group specifically so the ordering above is never disturbed
by which track() block a call sits in), 'preparing_drafts' (the Draft
Trigger). Alert delivery is left unwrapped — it's a delivery/notification
step, not analysis work the Command Center needs to show progress on.
Run via cron (see docker-compose.yml comment) as:
    docker compose exec app python -m scripts.run_nightly_pipeline
"""
import asyncio
import logging
import os

from app.activity.log import FINDINGS_COMPLETE_TASK, run_in_progress, track
from app.notifications.nightly import send_nightly_notifications

logger = logging.getLogger(__name__)
from app.forecast.accuracy import run_forecast_accuracy_evaluation
from app.forecast.run import run_forecasts
from app.ingestion.run_nightly import run_nightly
from app.insights.engine import run_insight_engine
from app.insights.recommendations import run_recommendation_engine
from app.intelligence.cannibalization import run_cannibalization_detection
from app.intelligence.effort_estimation import run_effort_estimation
from app.intelligence.impact_prediction import run_impact_prediction
from app.intelligence.opportunity_scoring import run_opportunity_scoring
from app.intelligence.prioritizer import run_recommendation_prioritizer
from app.intelligence.root_cause import run_root_cause_analysis
from app.intelligence.target_keyword_evidence import run_target_keyword_evidence
from app.investigations.drafts import run_draft_trigger
from app.investigations.engine import run_investigation_engine
from app.investigations.outcome import run_investigation_outcome_evaluation
from app.investigations.reasoning import run_investigation_reasoning
from app.ml.feature_importance import run_feature_importance
from app.opportunities.rollup import run_opportunity_rollup
from app.stats.anomalies import run_anomaly_detection
from app.stats.deltas import run_stats


async def main() -> None:
    # Never two runs at once on the shared database (production's scheduler owns the night; a manual staging run must not overlap).
    live_since = await run_in_progress()
    if live_since is not None:
        logger.warning("another Data Analyst run has been in progress since %s: not starting a second one", live_since)
        return
    async with track("monitoring"):
        await run_nightly()
        await run_stats()
        await run_anomaly_detection()
    async with track("forecasting"):
        await run_forecasts()
        await run_forecast_accuracy_evaluation()
        await run_investigation_outcome_evaluation()
    async with track("investigating"):
        await run_feature_importance()
        await run_insight_engine()
        # Must mirror app/analysis/run_pass.py::run_analysis_pass exactly —
        # that module's own docstring claims stage-for-stage parity with
        # this script, which these two calls were originally missing from.
        await run_target_keyword_evidence()
        await run_cannibalization_detection()
        await run_root_cause_analysis()
    async with track("generating_recommendations"):
        await run_recommendation_engine()
        await run_effort_estimation()
        await run_impact_prediction()
        await run_opportunity_scoring()
        await run_recommendation_prioritizer()
        await run_investigation_engine()
        await run_opportunity_rollup()
        await run_investigation_reasoning()
    # Findings only when ANALYST_DRAFT_TRIGGER=off (app/investigations/draft_switch.py). run_draft_trigger() also checks it, but
    # skipping here keeps a "preparing_drafts" row that never ran out of ai_activity_log.
    from app.investigations.draft_switch import draft_trigger_enabled, log_state
    log_state("run_nightly_pipeline")
    if draft_trigger_enabled():
        async with track("preparing_drafts"):
            await run_draft_trigger()
    # Every findings stage above finished without raising: say so, for the analytics app's orchestrator. Never fatal: if the
    # marker cannot be written (migration 0042 not applied yet), the findings ARE complete but stay unconfirmed, and the
    # orchestrator safely refuses them rather than this run being reported as failed.
    try:
        async with track(FINDINGS_COMPLETE_TASK):
            pass
    except Exception:
        logger.exception("findings_complete marker could not be written (is migration 0042 applied?): today's findings will be treated as unconfirmed")
    # Predictive alerts and the morning briefing (the nightly run IS "this morning" for every client; weekly/monthly briefings run
    # from their own scripts). Shared with production's scheduled run and sent at most once a day (app/notifications/nightly.py),
    # so a manual staging run on the same day as production's cannot send them twice.
    await send_nightly_notifications()

if __name__ == "__main__":
    asyncio.run(main())
