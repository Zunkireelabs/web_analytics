"""AI Command Center feed (Phase 3 Step 9). Cross-client, same convention
as alerts.py (nightly-pipeline activity isn't scoped to one client — see
AiActivityLog's own docstring). Admin-key gated like every other route."""
from fastapi import APIRouter, Depends
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import AiActivityLog
from app.db.session import get_session
from app.security.auth import require_admin_key

router = APIRouter()


def _serialize(entry: AiActivityLog) -> dict:
    return {
        "id": entry.id, "client_id": entry.client_id, "task_type": entry.task_type, "status": entry.status,
        "detail": entry.detail, "error": entry.error, "started_at": entry.started_at.isoformat(),
        "finished_at": entry.finished_at.isoformat() if entry.finished_at else None, "took_ms": entry.took_ms,
    }


@router.get("/activity")
async def list_activity(
    limit: int = 50, _admin: None = Depends(require_admin_key), session: AsyncSession = Depends(get_session),
) -> dict:
    rows = (
        await session.execute(select(AiActivityLog).order_by(AiActivityLog.started_at.desc()).limit(min(limit, 200)))
    ).scalars().all()
    return {"activity": [_serialize(e) for e in rows]}
