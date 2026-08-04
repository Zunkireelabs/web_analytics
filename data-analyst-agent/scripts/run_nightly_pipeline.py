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
Estimation's output. The Investigation Engine (Phase 3 — see
app/investigations/engine.py) runs last of the analysis stages, right
before alert delivery, since it summarizes ALL of the above into one
persistent Investigation row per (client, metric, dimension, insight_type)
— it needs every upstream engine's output to already exist for tonight's
recommendations.
Run via cron (see docker-compose.yml comment) as:
    docker compose exec app python -m scripts.run_nightly_pipeline
"""
import asyncio

from app.alerts.deliver import deliver_predictive_alerts
from app.forecast.run import run_forecasts
from app.ingestion.run_nightly import run_nightly
from app.insights.engine import run_insight_engine
from app.insights.recommendations import run_recommendation_engine
from app.intelligence.effort_estimation import run_effort_estimation
from app.intelligence.impact_prediction import run_impact_prediction
from app.intelligence.opportunity_scoring import run_opportunity_scoring
from app.intelligence.prioritizer import run_recommendation_prioritizer
from app.intelligence.root_cause import run_root_cause_analysis
from app.investigations.engine import run_investigation_engine
from app.ml.feature_importance import run_feature_importance
from app.stats.anomalies import run_anomaly_detection
from app.stats.deltas import run_stats


async def main() -> None:
    await run_nightly()
    await run_stats()
    await run_anomaly_detection()
    await run_forecasts()
    await run_feature_importance()
    await run_insight_engine()
    await run_root_cause_analysis()
    await run_recommendation_engine()
    await run_effort_estimation()
    await run_impact_prediction()
    await run_opportunity_scoring()
    await run_recommendation_prioritizer()
    await run_investigation_engine()
    await deliver_predictive_alerts()


if __name__ == "__main__":
    asyncio.run(main())
