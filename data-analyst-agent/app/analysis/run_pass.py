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
They remain scripts/run_nightly_pipeline.py-only until that decision is made
explicitly.

Note that this is no longer only a hand-run script: staging installs it as a
host crontab at 22:00 UTC (.github/workflows/deploy-staging.yml), so on
staging those alerts and briefings DO send nightly. An earlier version of
this docstring described that crontab as something nothing in the repo
installs, which was true when written. The opt-in question above is
therefore already answered in the affirmative on staging — revisit it there
deliberately rather than assuming these paths are still dormant.
Recorded, dependency-aware stages (Stage 1 of the Autonomous Growth Intelligence work). The chain above is no longer one block
that dies at its first exception: each stage is run by app/analysis/pass_runner.py, which records its own outcome and duration,
blocks stages whose dependency did not complete, runs a stage only for clients with fresh inputs
(app/analysis/freshness.py), keeps independent stages running (predictions do not wait behind the insight engine), and writes the
`findings_complete` marker only when every required stage completed. A pass that did not complete raises PassIncomplete after
recording everything, and sends no notifications.
"""

import logging
from datetime import date, datetime, timezone

from app.activity.log import FINDINGS_COMPLETE_TASK, run_in_progress  # noqa: F401 — FINDINGS_COMPLETE_TASK re-exported for callers
from app.analysis import freshness as fresh
from app.analysis.ledger import MANUAL, SCHEDULER, DbLedger  # noqa: F401
from app.analysis.pass_runner import Ledger, PassIncomplete, Stage, coverage, run_stages, summarise
from app.notifications.nightly import send_nightly_notifications
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
from app.predict.run import has_pooled_model, run_pooled_training, run_predictions
from app.stats.anomalies import run_anomaly_detection
from app.stats.deltas import run_stats

logger = logging.getLogger(__name__)

# Inputs a stage needs. Generic engines need at least one core site series (GSC or GA4); the prediction layer reads weekly
# site clicks and per-page rows, so it needs GSC site data AND page/query data, all fresh.
CORE_ANY = ("gsc_site", "ga4_site")
PREDICT_ALL = ("gsc_site", "page_query")


def is_training_day(today: date) -> bool:
    """The pooled prediction model is retrained on Mondays (and once on the very first night, so the
    platform-admin view has a real record from day one instead of waiting up to a week)."""
    return today.weekday() == 0


def build_stages(*, train_pooled_model: bool) -> list[Stage]:
    """The pipeline in its real dependency order. Callables are looked up when called, not now, so a test (or a hotfix) that
    replaces a module-level stage function is honoured."""
    S = Stage
    stages = [
        S("run_stats", "monitoring", lambda: run_stats(), needs_any=CORE_ANY),
        S("run_anomaly_detection", "monitoring", lambda: run_anomaly_detection(), needs_any=CORE_ANY),

        S("run_forecasts", "forecasting", lambda: run_forecasts(), needs_any=CORE_ANY),
        # Measurement of past predictions against what landed: not scoped to fresh clients (it reads history, produces no finding).
        S("run_forecast_accuracy_evaluation", "forecasting", lambda: run_forecast_accuracy_evaluation()),
        S("run_investigation_outcome_evaluation", "forecasting", lambda: run_investigation_outcome_evaluation()),

        S("run_feature_importance", "investigating", lambda: run_feature_importance(), needs_any=CORE_ANY),
        S("run_insight_engine", "investigating", lambda: run_insight_engine(), deps=("run_stats", "run_anomaly_detection", "run_forecasts"), needs_any=CORE_ANY),
    ]
    if train_pooled_model:
        # Optional: a failed training leaves the stored model in use (recorded, never silent).
        stages.append(S("run_pooled_training", "investigating", lambda: run_pooled_training(), required=False))
    stages += [
        # Next-week predictions. Runs AFTER the insight engine (its forecast_risk insights must not be wiped by the engine's own
        # reset) but does NOT depend on its success: it needs only its own fresh inputs.
        S("run_predictions", "investigating", lambda: run_predictions(), needs_all=PREDICT_ALL),
        S("run_target_keyword_evidence", "investigating", lambda: run_target_keyword_evidence(), needs_any=("gsc_site",)),
        S("run_cannibalization_detection", "investigating", lambda: run_cannibalization_detection(), needs_any=("gsc_site",)),
        S("run_root_cause_analysis", "investigating", lambda: run_root_cause_analysis(), deps=("run_insight_engine",), needs_any=CORE_ANY),

        S("run_recommendation_engine", "generating_recommendations", lambda: run_recommendation_engine(), deps=("run_insight_engine",), needs_any=CORE_ANY),
        S("run_effort_estimation", "generating_recommendations", lambda: run_effort_estimation(), deps=("run_recommendation_engine",), needs_any=CORE_ANY),
        S("run_impact_prediction", "generating_recommendations", lambda: run_impact_prediction(), deps=("run_recommendation_engine",), needs_any=CORE_ANY),
        S("run_opportunity_scoring", "generating_recommendations", lambda: run_opportunity_scoring(), deps=("run_effort_estimation", "run_impact_prediction"), needs_any=CORE_ANY),
        S("run_recommendation_prioritizer", "generating_recommendations", lambda: run_recommendation_prioritizer(), deps=("run_opportunity_scoring",), needs_any=CORE_ANY),
        S("run_investigation_engine", "generating_recommendations", lambda: run_investigation_engine(), deps=("run_recommendation_engine",), needs_any=CORE_ANY),
        S("run_opportunity_rollup", "generating_recommendations", lambda: run_opportunity_rollup(), deps=("run_investigation_engine",), needs_any=CORE_ANY),
        S("run_investigation_reasoning", "generating_recommendations", lambda: run_investigation_reasoning(), deps=("run_investigation_engine",), needs_any=CORE_ANY),

        # Findings only when ANALYST_DRAFT_TRIGGER=off (app/investigations/draft_switch.py): the trigger checks it itself.
        S("run_draft_trigger", "preparing_drafts", lambda: run_draft_trigger(), deps=("run_recommendation_prioritizer", "run_investigation_engine"), needs_any=CORE_ANY),
    ]
    return stages


async def run_analysis_pass(*, owner: str = MANUAL, resume_pass_id: str | None = None, ledger: Ledger | None = None) -> None:
    """Runs the analysis stages in dependency order. Raises PassIncomplete (after recording everything) when any required stage did
    not complete; the caller decides whether that is fatal (a manual script run) or merely logged (the scheduler, which must
    survive a bad night). `resume_pass_id` re-runs only the stages that did not complete in that earlier pass."""
    # Never two runs at once on the shared database (production's scheduler owns the night; a manual run must not overlap).
    live_since = await run_in_progress()
    if live_since is not None:
        logger.warning("another Data Analyst run has been in progress since %s: not starting a second one", live_since)
        return
    owns_db = ledger is None
    ledger = ledger or DbLedger()
    if owns_db:
        # A "running" row older than the live-run window belongs to a process that died: close it as interrupted, not leave it.
        from app.analysis.ledger import recover_interrupted_runs
        from app.activity.log import RUN_IN_PROGRESS_HOURS
        await recover_interrupted_runs(scheduler_owned_only=False, older_than_hours=RUN_IN_PROGRESS_HOURS)

    pass_id = resume_pass_id or datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%MZ")
    freshness = await _load_freshness()
    stages = build_stages(train_pooled_model=is_training_day(date.today()) or not await has_pooled_model())
    logger.info("analysis pass %s starting (owner=%s, resume=%s): %s", pass_id, owner, bool(resume_pass_id),
                {cid: f.verdict for cid, f in freshness.items()})

    results = await run_stages(stages, ledger=ledger, pass_id=pass_id, owner=owner, freshness=freshness, resume=bool(resume_pass_id))

    complete, why = summarise(stages, results)
    covered, excluded = coverage(stages, results, sorted(freshness))
    if complete and freshness and not covered:
        # Every stage "completed" but not one client was covered by all of them (every client stale or failed): nothing to rely on.
        complete, why = False, "no client is covered by every required stage"
    await ledger.write_marker(
        pass_id, complete, None if complete else f"findings incomplete: {why}",
        {
            "covered_clients": covered, "excluded_clients": {str(k): v for k, v in excluded.items()},
            "evidence": {str(cid): f.as_detail() for cid, f in freshness.items()},
            "stages": {n: r.outcome for n, r in results.items()},
        },
    )
    if not complete:
        # Never claim a completed analysis from partial findings, and never send "this morning's" alerts built on them.
        raise PassIncomplete(f"analysis pass {pass_id} did not complete: {why}")
    # The customer-facing notifications (predictive alerts, morning briefing), at most once a day (app/notifications/nightly.py).
    await send_nightly_notifications()


async def _load_freshness() -> dict[int, fresh.ClientFreshness]:
    from sqlalchemy import select

    from app.db.models import Client
    from app.db.session import SessionLocal

    async with SessionLocal() as session:
        ids = [c for (c,) in (await session.execute(select(Client.id).where(Client.status == "active"))).all()]
        return await fresh.load_freshness(session, ids) if ids else {}
