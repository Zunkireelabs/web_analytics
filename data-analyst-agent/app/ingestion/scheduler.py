import logging

from apscheduler.schedulers.asyncio import AsyncIOScheduler
from apscheduler.triggers.cron import CronTrigger

from app.analysis.run_pass import run_analysis_pass
from app.config import settings
from app.ingestion.run_nightly import run_nightly

logger = logging.getLogger(__name__)

_scheduler: AsyncIOScheduler | None = None


def start_scheduler() -> None:
    """Starts the in-process nightly crons. Without this, run_nightly() only
    ever runs when someone execs it manually inside the container — there was
    previously no scheduled trigger anywhere (no cron container, no GitHub
    Action, nothing in main.py).

    Two jobs, because ingestion and analysis were previously scheduled by two
    different mechanisms: ingestion here, analysis only via a host-level
    crontab line. Both now deploy with the container. Either job can be
    disabled independently via settings if one needs to be run by hand during
    an incident.

    THAT CRONTAB LINE IS REAL AND IS INSTALLED. An earlier version of this
    docstring said "nothing in this repo installs" it; that was true when
    written and is no longer. .github/workflows/deploy-staging.yml installs it
    on every staging deploy, at 22:00 UTC, running the wider
    scripts/run_nightly_pipeline (which also sends alerts and briefings that
    app/analysis/run_pass.py deliberately excludes).

    So on staging these two mechanisms overlapped and the whole pipeline ran
    twice a day, uncoordinated. Staging now sets INGEST_SCHEDULE_ENABLED and
    ANALYSIS_SCHEDULE_ENABLED to false so the crontab is the single
    authoritative path there; production installs no crontab and runs this
    scheduler instead. Exactly one of the two is live in any environment —
    before changing either, check which one that environment uses, because the
    defaults here are enabled and a new environment inherits them."""
    global _scheduler
    if _scheduler is not None:
        return
    if not settings.ingest_schedule_enabled and not settings.analysis_schedule_enabled:
        return

    _scheduler = AsyncIOScheduler(timezone="UTC")

    if settings.ingest_schedule_enabled:
        _scheduler.add_job(
            _run_ingestion_and_log,
            CronTrigger(hour=settings.ingest_schedule_hour_utc, minute=0),
            id="nightly-ingestion",
            max_instances=1,
            coalesce=True,
            misfire_grace_time=3600,
        )
        logger.info("Nightly ingestion scheduled: daily at %02d:00 UTC", settings.ingest_schedule_hour_utc)

    if settings.analysis_schedule_enabled:
        _scheduler.add_job(
            _run_analysis_and_log,
            CronTrigger(hour=settings.analysis_schedule_hour_utc, minute=0),
            id="nightly-analysis",
            max_instances=1,
            coalesce=True,
            misfire_grace_time=3600,
        )
        logger.info("Nightly analysis scheduled: daily at %02d:00 UTC", settings.analysis_schedule_hour_utc)

    _scheduler.start()


def stop_scheduler() -> None:
    global _scheduler
    if _scheduler is not None:
        _scheduler.shutdown(wait=False)
        _scheduler = None


async def _run_ingestion_and_log() -> None:
    logger.info("Nightly ingestion run starting")
    try:
        await run_nightly()
        logger.info("Nightly ingestion run finished")
    except Exception:  # noqa: BLE001 — a bad run must never kill the scheduler itself
        logger.exception("Nightly ingestion run failed")


async def _run_analysis_and_log() -> None:
    logger.info("Nightly analysis run starting")
    try:
        await run_analysis_pass()
        logger.info("Nightly analysis run finished")
    except Exception:  # noqa: BLE001 — same rule as ingestion above
        logger.exception("Nightly analysis run failed")
