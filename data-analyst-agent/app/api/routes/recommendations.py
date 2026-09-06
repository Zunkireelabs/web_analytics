from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_active_client
from app.db.models import Client, Insight, MetricCatalog, AnalystRecommendations
from app.db.session import get_session
from app.insights.recommendations import generate_dashboard_executive_summary, generate_executive_summary

router = APIRouter()


class ResolveRequest(BaseModel):
    resolved_by: str | None = None


class DismissRequest(BaseModel):
    dismissed_by: str | None = None


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
    rec = await session.get(AnalystRecommendations, recommendation_id)
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


@router.post("/clients/{client_id}/recommendations/{recommendation_id}/dismiss")
async def dismiss_recommendation(
    recommendation_id: int,
    body: DismissRequest,
    client: Client = Depends(get_active_client),
    session: AsyncSession = Depends(get_session),
) -> dict:
    """Staff-driven "not worth acting on", distinct from resolve — same
    tenant-isolation discipline as resolve_recommendation above."""
    rec = await session.get(AnalystRecommendations, recommendation_id)
    if rec is None or rec.client_id != client.id:
        raise HTTPException(status_code=404, detail="Recommendation not found.")

    rec.status = "dismissed"
    rec.dismissed_at = datetime.now(timezone.utc)
    rec.dismissed_by = body.dismissed_by
    await session.commit()

    return {
        "id": rec.id, "status": rec.status,
        "dismissed_at": rec.dismissed_at.isoformat(), "dismissed_by": rec.dismissed_by,
    }


@router.post("/clients/{client_id}/recommendations/{recommendation_id}/summary")
async def summarize_recommendation(
    recommendation_id: int,
    client: Client = Depends(get_active_client),
    session: AsyncSession = Depends(get_session),
) -> dict:
    """On-demand "Create Executive Summary" — stateless, regenerated on
    every call (never persisted), same discipline as /ask. Same
    tenant-isolation guard as resolve/dismiss above."""
    rec = await session.get(AnalystRecommendations, recommendation_id)
    if rec is None or rec.client_id != client.id:
        raise HTTPException(status_code=404, detail="Recommendation not found.")

    insight = await session.get(Insight, rec.insight_id)
    if insight is None:
        raise HTTPException(status_code=404, detail="Underlying insight not found.")
    metric = await session.get(MetricCatalog, insight.metric_key)

    try:
        summary = await generate_executive_summary(insight, metric, rec)
    except Exception as e:
        raise HTTPException(status_code=502, detail="Summary generation failed — try again.") from e

    return {"summary": summary}


@router.post("/dashboard/{client_id}/executive-summary")
async def post_dashboard_executive_summary(
    client: Client = Depends(get_active_client), session: AsyncSession = Depends(get_session),
) -> dict:
    """The AI Executive Summary hero — on-demand, stateless, same discipline
    as summarize_recommendation above. Lives in this route file (not
    dashboard.py) to avoid a circular import: generate_dashboard_executive_
    summary itself imports dashboard.py's get_latest_forecast."""
    try:
        return await generate_dashboard_executive_summary(session, client_id=client.id)
    except Exception as e:
        raise HTTPException(status_code=502, detail="Executive summary generation failed — try again.") from e
