"""Read surface for Investigation (Phase 3). Approve/reject/request-revision
land in a later milestone alongside the approval_history table — this file
is list/detail/events only for now, same tenant-isolation discipline as
recommendations.py (client_id in the path, 404 on cross-tenant access)."""
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_active_client
from app.db.models import Client, Investigation, InvestigationEvent
from app.db.session import get_session

router = APIRouter()


def _f(value) -> float | None:
    return float(value) if value is not None else None


def _serialize(inv: Investigation) -> dict:
    return {
        "id": inv.id, "metric_key": inv.metric_key, "dimension_type": inv.dimension_type,
        "dimension_value": inv.dimension_value, "insight_type": inv.insight_type,
        "severity": inv.severity, "priority": inv.priority, "status": inv.status,
        "affected_metrics": inv.affected_metrics, "summary": inv.summary, "evidence": inv.evidence,
        "forecast_outlook": inv.forecast_outlook, "root_cause_text": inv.root_cause_text,
        "confidence": _f(inv.confidence), "owner": inv.owner,
        "executive_summary": inv.executive_summary, "technical_summary": inv.technical_summary,
        "business_summary": inv.business_summary, "risk_assessment": inv.risk_assessment,
        "missing_evidence": inv.missing_evidence,
        "source_insight_id": inv.source_insight_id, "source_anomaly_id": inv.source_anomaly_id,
        "created_at": inv.created_at.isoformat(), "updated_at": inv.updated_at.isoformat(),
    }


@router.get("/clients/{client_id}/investigations")
async def list_investigations(
    status: str | None = None, severity: str | None = None,
    client: Client = Depends(get_active_client), session: AsyncSession = Depends(get_session),
) -> dict:
    query = select(Investigation).where(Investigation.client_id == client.id)
    if status:
        query = query.where(Investigation.status == status)
    if severity:
        query = query.where(Investigation.severity == severity)
    rows = (await session.execute(query.order_by(Investigation.updated_at.desc()))).scalars().all()
    return {"investigations": [_serialize(inv) for inv in rows]}


@router.get("/clients/{client_id}/investigations/{investigation_id}")
async def get_investigation(
    investigation_id: int, client: Client = Depends(get_active_client), session: AsyncSession = Depends(get_session),
) -> dict:
    inv = await session.get(Investigation, investigation_id)
    if inv is None or inv.client_id != client.id:
        raise HTTPException(status_code=404, detail="Investigation not found.")
    events = (
        await session.execute(
            select(InvestigationEvent)
            .where(InvestigationEvent.investigation_id == investigation_id)
            .order_by(InvestigationEvent.created_at)
        )
    ).scalars().all()
    return {
        **_serialize(inv),
        "events": [
            {
                "from_status": e.from_status, "to_status": e.to_status, "actor": e.actor,
                "detail": e.detail, "created_at": e.created_at.isoformat(),
            }
            for e in events
        ],
    }


@router.get("/clients/{client_id}/investigations/{investigation_id}/events")
async def get_investigation_events(
    investigation_id: int, client: Client = Depends(get_active_client), session: AsyncSession = Depends(get_session),
) -> dict:
    inv = await session.get(Investigation, investigation_id)
    if inv is None or inv.client_id != client.id:
        raise HTTPException(status_code=404, detail="Investigation not found.")
    events = (
        await session.execute(
            select(InvestigationEvent)
            .where(InvestigationEvent.investigation_id == investigation_id)
            .order_by(InvestigationEvent.created_at)
        )
    ).scalars().all()
    return {
        "events": [
            {
                "from_status": e.from_status, "to_status": e.to_status, "actor": e.actor,
                "detail": e.detail, "created_at": e.created_at.isoformat(),
            }
            for e in events
        ],
    }
