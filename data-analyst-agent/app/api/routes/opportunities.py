"""Read surface for Opportunity (Phase 3) — see app/opportunities/rollup.py.
Same tenant-isolation discipline as investigations.py."""
from fastapi import APIRouter, Depends
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_active_client
from app.db.models import Client, Opportunity
from app.db.session import get_session

router = APIRouter()


def _f(value) -> float | None:
    return float(value) if value is not None else None


def _serialize(opp: Opportunity) -> dict:
    return {
        "id": opp.id, "investigation_id": opp.investigation_id, "opportunity_score": _f(opp.opportunity_score),
        "priority": opp.priority, "forecast_gain": opp.forecast_gain, "business_impact": _f(opp.business_impact),
        "business_impact_currency": opp.business_impact_currency, "confidence": _f(opp.confidence),
        "recommendation_count": opp.recommendation_count, "status": opp.status,
        "created_at": opp.created_at.isoformat(), "updated_at": opp.updated_at.isoformat(),
    }


@router.get("/clients/{client_id}/opportunities")
async def list_opportunities(
    status: str | None = None,
    client: Client = Depends(get_active_client), session: AsyncSession = Depends(get_session),
) -> dict:
    query = select(Opportunity).where(Opportunity.client_id == client.id)
    if status:
        query = query.where(Opportunity.status == status)
    rows = (await session.execute(query.order_by(Opportunity.updated_at.desc()))).scalars().all()
    return {"opportunities": [_serialize(o) for o in rows]}
