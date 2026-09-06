"""Read surface for ExecutiveBriefing (Phase 3 Step 10) — see
app/briefings/generator.py. Same tenant-isolation discipline as
investigations.py/opportunities.py."""
from fastapi import APIRouter, Depends
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_active_client
from app.db.models import Client, ExecutiveBriefing
from app.db.session import get_session

router = APIRouter()


def _f(value) -> float | None:
    return float(value) if value is not None else None


def _serialize(b: ExecutiveBriefing) -> dict:
    return {
        "id": b.id, "cadence": b.cadence, "period_start": b.period_start.isoformat(),
        "period_end": b.period_end.isoformat(), "biggest_wins": b.biggest_wins, "biggest_risks": b.biggest_risks,
        "forecast_summary": b.forecast_summary, "recommendations_summary": b.recommendations_summary,
        "opportunity_score": _f(b.opportunity_score), "website_health_score": _f(b.website_health_score),
        "trend_summary": b.trend_summary, "narrative": b.narrative, "generated_at": b.generated_at.isoformat(),
    }


@router.get("/clients/{client_id}/briefings")
async def list_briefings(
    cadence: str | None = None, limit: int = 10,
    client: Client = Depends(get_active_client), session: AsyncSession = Depends(get_session),
) -> dict:
    query = select(ExecutiveBriefing).where(ExecutiveBriefing.client_id == client.id)
    if cadence:
        query = query.where(ExecutiveBriefing.cadence == cadence)
    rows = (
        await session.execute(query.order_by(ExecutiveBriefing.generated_at.desc()).limit(min(limit, 50)))
    ).scalars().all()
    return {"briefings": [_serialize(b) for b in rows]}
