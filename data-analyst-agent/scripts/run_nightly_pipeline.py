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

from app.analysis.pass_runner import PassIncomplete
from app.analysis.run_pass import run_analysis_pass
from app.ingestion.run_nightly import run_nightly

logger = logging.getLogger(__name__)


async def main() -> None:
    """Ingest, then the SAME recorded analysis pass the scheduler runs (app/analysis/run_pass.py), owned as a manual run.

    This script used to carry its own copy of the stage chain, which had drifted: it never ran the prediction layer and its
    docstring claimed parity it did not have. One path now: the stage order, dependencies, freshness gate, per-stage records and
    the findings marker are identical to the scheduled run. (The group names in the docstring above are still the activity-log
    task types.)"""
    await run_nightly()
    try:
        await run_analysis_pass(owner="manual")
    except PassIncomplete as exc:
        # Recorded already; surface it to whoever ran this by hand.
        logger.error("%s", exc)
        raise SystemExit(1)


if __name__ == "__main__":
    asyncio.run(main())
