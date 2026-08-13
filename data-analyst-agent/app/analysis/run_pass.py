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

    stats -> anomalies -> forecasts        (what happened / what's coming)
    -> insights -> root cause              (what's worth flagging, and why)
    -> recommendations                     (the one-sentence fix guidance)
    -> investigations -> reasoning         (promotes a finding to actionable)
    -> draft trigger                       (calls the generate_draft MCP tool)

The draft trigger is what makes "the agent found an issue" land in Action
Center by itself instead of waiting for a staff click. It is deliberately
narrow (app/investigations/drafts.py): a gsc_* metric, dimension_type
'page', a real decline, and an absolute URL. A site-wide decline has no page
to fix, so it stays a warning on the Analyst page rather than becoming a
draft — this pass never invents a target it can't justify.

Still excluded, because nothing currently rendered consumes them: forecast
accuracy evaluation, feature importance, effort estimation, impact
prediction, opportunity scoring/rollup, prioritizer, briefings, and
predictive alert delivery. scripts/run_nightly_pipeline.py remains the full
pass and is unchanged.
"""
import logging

from app.activity.log import track
from app.forecast.run import run_forecasts
from app.insights.engine import run_insight_engine
from app.insights.recommendations import run_recommendation_engine
from app.intelligence.root_cause import run_root_cause_analysis
from app.investigations.drafts import run_draft_trigger
from app.investigations.engine import run_investigation_engine
from app.investigations.reasoning import run_investigation_reasoning
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
    async with track("investigating"):
        await run_insight_engine()
        await run_root_cause_analysis()
    async with track("generating_recommendations"):
        await run_recommendation_engine()
        await run_investigation_engine()
        await run_investigation_reasoning()
    async with track("preparing_drafts"):
        await run_draft_trigger()
