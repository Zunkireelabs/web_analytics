"""What evidence the analyst has for a client, and how the last analysis run treated it.

The Node app and staff read this instead of guessing: which data sources are fresh, which collectors produced nothing and why
(no_mcp_token for a database-only project), whether the last findings marker covered this client, and the state of the server-side
OpenAI controls. Read-only; nothing here changes any data."""
from fastapi import APIRouter, Depends
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.activity.log import FINDINGS_COMPLETE_TASK
from app.analysis.freshness import load_freshness
from app.api.deps import get_active_client
from app.db.models import AiActivityLog, Client
from app.db.session import get_session
from app.llm.controls import controls
from app.mcp_client.token import mcp_mode

router = APIRouter()


@router.get("/clients/{client_id}/evidence-status")
async def get_evidence_status(client: Client = Depends(get_active_client), session: AsyncSession = Depends(get_session)) -> dict:
    freshness = (await load_freshness(session, [client.id]))[client.id]
    marker = (await session.execute(
        select(AiActivityLog).where(AiActivityLog.task_type == FINDINGS_COMPLETE_TASK).order_by(AiActivityLog.started_at.desc()).limit(1)
    )).scalars().first()
    last_run = None
    if marker is not None:
        d = marker.detail or {}
        covered = d.get("covered_clients")
        last_run = {
            "pass_id": d.get("pass_id"), "status": marker.status, "complete": bool(d.get("complete", marker.status == "completed")),
            "finished_at": marker.finished_at.isoformat() if marker.finished_at else None, "error": marker.error,
            # None for a marker written before coverage was recorded: treated as unknown, never as covered.
            "covers_this_client": (client.id in covered) if covered is not None else None,
            "excluded_reason": (d.get("excluded_clients") or {}).get(str(client.id)),
        }
    return {
        "client_id": client.id, "mcp_mode": mcp_mode(client), "freshness": freshness.as_detail(),
        "last_analysis": last_run, "openai": controls.status(),
    }
