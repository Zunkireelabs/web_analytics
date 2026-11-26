"""POST /clients/{client_id}/fix-outcomes: the Node app reports what a shipped fix actually did (measured there, 31 days after merge).

Stored per client (migration 0043) and used by impact_prediction.py for a measured confidence. Idempotent on `external_ref`, so the
sender can retry safely. The client comes from the path through the same tenant gate as every per-client route."""
from datetime import datetime

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_active_client
from app.db.models import Client
from app.db.session import get_session
from app.intelligence.fix_outcomes import record_fix_outcome

router = APIRouter()


class FixOutcomeIn(BaseModel):
    external_ref: str = Field(min_length=1, max_length=200)
    generator_id: str = Field(min_length=1, max_length=100)
    improved: bool
    clicks_delta: float | None = None
    delta: dict = Field(default_factory=dict)
    measured_at: datetime


@router.post("/clients/{client_id}/fix-outcomes")
async def post_fix_outcome(
    body: FixOutcomeIn, client: Client = Depends(get_active_client), session: AsyncSession = Depends(get_session),
) -> dict:
    row = await record_fix_outcome(
        session, client.id, external_ref=body.external_ref, generator_id=body.generator_id, improved=body.improved,
        clicks_delta=body.clicks_delta, delta=body.delta, measured_at=body.measured_at,
    )
    await session.commit()
    return {"id": row.id, "category": row.category, "counts_toward_confidence": row.category is not None}
