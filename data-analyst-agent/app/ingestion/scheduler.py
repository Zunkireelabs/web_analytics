import logging

from apscheduler.schedulers.asyncio import AsyncIOScheduler
from apscheduler.triggers.cron import CronTrigger

from app.config import settings
from app.ingestion.run_nightly import run_nightly

logger = logging.getLogger(__name__)

_scheduler: AsyncIOScheduler | None = None


def start_scheduler() -> None:
    """Starts the in-process nightly ingestion cron. Without this, run_nightly()
    only ever runs when someone execs it manually inside the container — there
    was previously no scheduled trigger anywhere (no cron container, no
    GitHub Action, nothing in main.py)."""
    global _scheduler
    if not settings.ingest_schedule_enabled or _scheduler is not None:
        return
    _scheduler = AsyncIOScheduler(timezone="UTC")
    _scheduler.add_job(
        _run_and_log,
        CronTrigger(hour=settings.ingest_schedule_hour_utc, minute=0),
        id="nightly-ingestion",
        max_instances=1,
        coalesce=True,
        misfire_grace_time=3600,
    )
    _scheduler.start()
    logger.info("Nightly ingestion scheduler started: daily at %02d:00 UTC", settings.ingest_schedule_hour_utc)


def stop_scheduler() -> None:
    global _scheduler
    if _scheduler is not None:
        _scheduler.shutdown(wait=False)
        _scheduler = None


async def _run_and_log() -> None:
    logger.info("Nightly ingestion run starting")
    try:
        await run_nightly()
        logger.info("Nightly ingestion run finished")
    except Exception:  # noqa: BLE001 — a bad run must never kill the scheduler itself
        logger.exception("Nightly ingestion run failed")
