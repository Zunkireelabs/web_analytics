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
available to any later stage. The Investigation Engine (Phase 3 — see
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

from app.activity.log import track
from app.alerts.deliver import deliver_predictive_alerts
from app.briefings.generator import generate_morning_briefing
from app.forecast.accuracy import run_forecast_accuracy_evaluation
from app.forecast.run import run_forecasts
from app.ingestion.run_nightly import run_nightly
from app.insights.engine import run_insight_engine
from app.insights.recommendations import run_recommendation_engine
from app.intelligence.effort_estimation import run_effort_estimation
from app.intelligence.impact_prediction import run_impact_prediction
from app.intelligence.opportunity_scoring import run_opportunity_scoring
from app.intelligence.prioritizer import run_recommendation_prioritizer
from app.intelligence.root_cause import run_root_cause_analysis
from app.investigations.drafts import run_draft_trigger
from app.investigations.engine import run_investigation_engine
from app.investigations.reasoning import run_investigation_reasoning
from app.ml.feature_importance import run_feature_importance
from app.opportunities.rollup import run_opportunity_rollup
from app.stats.anomalies import run_anomaly_detection
from app.stats.deltas import run_stats


async def main() -> None:
    async with track("monitoring"):
        await run_nightly()
        await run_stats()
        await run_anomaly_detection()
    async with track("forecasting"):
        await run_forecasts()
        await run_forecast_accuracy_evaluation()
    async with track("investigating"):
        await run_feature_importance()
        await run_insight_engine()
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
    async with track("preparing_drafts"):
        await run_draft_trigger()
    await deliver_predictive_alerts()
    # Morning Briefing (Phase 3 Step 10) — the nightly run IS "this morning"
    # for every client (single timezone-agnostic cron, see the module
    # docstring in app/briefings/generator.py); weekly/monthly cadences run
    # from their own separate cron entries (scripts/run_weekly_briefing.py,
    # scripts/run_monthly_briefing.py), not from here.
    await generate_morning_briefing()


if __name__ == "__main__":
    asyncio.run(main())
