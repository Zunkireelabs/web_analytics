from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_active_client
from app.db.models import Client, Recommendation
from app.db.session import get_session

router = APIRouter()


class ResolveRequest(BaseModel):
    resolved_by: str | None = None


@router.post("/clients/{client_id}/recommendations/{recommendation_id}/resolve")
async def resolve_recommendation(
    recommendation_id: int,
    body: ResolveRequest,
    client: Client = Depends(get_active_client),
    session: AsyncSession = Depends(get_session),
) -> dict:
    """Staff-driven "mark solved". client_id is in the path (not just the
    id) so a wrong/stale recommendation_id can never resolve another
    client's alert — same tenant-isolation discipline as dashboard.py."""
    rec = await session.get(Recommendation, recommendation_id)
    if rec is None or rec.client_id != client.id:
        raise HTTPException(status_code=404, detail="Recommendation not found.")

    rec.status = "resolved"
    rec.resolved_at = datetime.now(timezone.utc)
    rec.resolved_by = body.resolved_by
    await session.commit()

    return {
        "id": rec.id, "status": rec.status,
        "resolved_at": rec.resolved_at.isoformat(), "resolved_by": rec.resolved_by,
    }
