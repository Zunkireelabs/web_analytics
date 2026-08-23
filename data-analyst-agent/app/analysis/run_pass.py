"""The analysis pass: turns collected observations into forecasts, early
warnings, and — where a finding is actionable — a draft waiting in Action
Center.

This runs on a schedule (app/ingestion/scheduler.py). Previously none of it
was scheduled at all: it existed only in scripts/run_nightly_pipeline.py,
which docker-compose.yml documents as a host crontab line that nothing in
the repo installs. The visible symptom was every forecast_run sitting at
status 'insufficient-data' from the last manual run, while months of
observations accumulated behind it with nothing re-reading them.

Stage order matters and mirrors scripts/run_nightly_pipeline.py exactly,
because each stage consumes the previous one's rows:

    stats -> anomalies -> forecasts -> forecast accuracy eval
    -> investigation outcome eval          (closes out yesterday's approved
                                             investigations against today's
                                             real numbers)
    -> feature importance -> insights (incl. content_decay classification)
    -> target-keyword evidence grading -> cannibalization detection
    -> root cause
    -> recommendations -> effort estimation -> impact prediction
    -> opportunity scoring -> prioritizer  (batch, cross-recommendation rank)
    -> investigations -> opportunity rollup -> reasoning
    -> draft trigger                       (calls the generate_draft MCP tool)

The draft trigger is what makes "the agent found an issue" land in Action
Center by itself instead of waiting for a staff click. It is deliberately
narrow (app/investigations/drafts.py): a gsc_* metric, dimension_type
'page', a real decline, and an absolute URL. A site-wide decline has no page
to fix, so it stays a warning on the Analyst page rather than becoming a
draft — this pass never invents a target it can't justify. It gates on the
recommendation's priority_score — the ONE action-selection mechanism. Since
the batch opportunity/effort/prioritizer stages above now already run
earlier in this SAME pass, a real batch-ranked (cross-recommendation `rank`
included) priority_score already exists for the trigger to read by the time
it runs; app/investigations/drafts.py's on-demand per-recommendation
DEPENDENCY RESOLUTION fallback (still present, unmodified) now only ever
fires for a recommendation that genuinely slipped past this batch pass
(e.g. generated mid-run, after opportunity scoring already went by) rather
than being the primary computation path it used to be.

Every stage above except run_nightly() itself (kept on its own separate
ingest_schedule_hour_utc cron, app/ingestion/scheduler.py) mirrors
scripts/run_nightly_pipeline.py's batch pipeline exactly — this pass now
IS that pipeline's real automatic trigger, not a narrower stand-in for it.
scripts/run_nightly_pipeline.py remains runnable by hand (e.g. to replay a
missed night) and is otherwise unchanged.

Deliberately NOT included here: predictive alert delivery
(app/alerts/deliver.py) and the morning/weekly/monthly briefing generators
(app/briefings/generator.py). Both are customer-facing notification/email
sends, not analysis — wiring them into an automatic nightly cron is a
product decision about cadence and opt-in a customer hasn't made yet, not a
scheduling bug to silently fix by turning on new emails no one asked for.
They remain scripts/run_nightly_pipeline.py-only (still documented there as
a host crontab line nothing in this repo installs) until that decision is
made explicitly.
"""
import logging

from app.activity.log import track
from app.forecast.accuracy import run_forecast_accuracy_evaluation
from app.forecast.run import run_forecasts
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

logger = logging.getLogger(__name__)


async def run_analysis_pass() -> None:
    """Runs the analysis stages in dependency order. Raises on failure — the
    caller decides whether that's fatal (a manual script run) or merely logged
    (the scheduler, which must survive a bad night)."""
    async with track("monitoring"):
        await run_stats()
        await run_anomaly_detection()
    async with track("forecasting"):
        await run_forecasts()
        await run_forecast_accuracy_evaluation()
        await run_investigation_outcome_evaluation()
    async with track("investigating"):
        await run_feature_importance()
        await run_insight_engine()
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
    async with track("preparing_drafts"):
        await run_draft_trigger()
