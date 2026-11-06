"""The customer-facing notifications a nightly run sends at its end: predictive alerts (pushed to the analytics app, which delivers
them in-app and by email) and the morning briefing (stored for the Analyst page).

These used to be sent ONLY by scripts/run_nightly_pipeline.py, the staging host crontab's script. Production's scheduled run
(app/analysis/run_pass.py) left them out. With production's scheduler now the only scheduled owner of the shared database, it sends
them, at the same moment the staging script did: after every findings stage of a successful run. A run that fails earlier sends
nothing, exactly as before.

ONCE PER NIGHT. Both entry points call send_nightly_notifications(), and it sends at most once per UTC day: a completed `notifying`
activity row for today means it already happened (a manual staging run on the same day, a retried pass). The briefing is also
guarded per client, cadence and day inside the generator. The app adds its own once-a-day email guard per site.
"""
import logging
from datetime import datetime, timezone

from sqlalchemy import select

from app.activity.log import track
from app.alerts.deliver import deliver_predictive_alerts
from app.briefings.generator import generate_morning_briefing
from app.db.models import AiActivityLog
from app.db.session import SessionLocal

logger = logging.getLogger(__name__)

NOTIFY_TASK = "notifying"


async def notifications_sent_today(now: datetime | None = None) -> bool:
    now = now or datetime.now(timezone.utc)
    start = now.replace(hour=0, minute=0, second=0, microsecond=0)
    async with SessionLocal() as session:
        row = (await session.execute(
            select(AiActivityLog.id).where(
                AiActivityLog.task_type == NOTIFY_TASK, AiActivityLog.status == "completed", AiActivityLog.started_at >= start,
            ).limit(1)
        )).scalar_one_or_none()
    return row is not None


async def send_nightly_notifications() -> bool:
    """Sends today's predictive alerts and morning briefing unless they already went out today. Returns whether it sent."""
    if await notifications_sent_today():
        logger.info("nightly notifications already sent today: not sending them again")
        return False
    async with track(NOTIFY_TASK):
        await deliver_predictive_alerts()
        await generate_morning_briefing()
    return True
