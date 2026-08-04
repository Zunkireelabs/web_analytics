"""Read + approval surface for Investigation (Phase 3). Same tenant-
isolation discipline as recommendations.py (client_id in the path, 404 on
cross-tenant access). approve/reject/request-revision are for a
recommendation that doesn't produce a content draft — the draft/PR side of
the same workflow lives entirely in the Node app's Action Center
(drafts.approved_by/abandoned_by/revision_* — server/store/drafts.js)."""
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_active_client
from app.db.models import ApprovalHistory, Client, Investigation, InvestigationEvent
from app.db.session import get_session

router = APIRouter()

# Statuses eligible for a review decision — everything short of the two
# lifecycle terminals. 'approve' additionally requires the investigation to
# have at least reached 'recommendation_generated' (there's nothing to
# approve before then); 'reject'/'request-revision' are valid from any of
# these.
REVIEWABLE_STATUSES = (
    "detected", "investigating", "evidence_collected", "recommendation_generated",
    "draft_prepared", "waiting_human_review",
)


class ApprovalDecisionRequest(BaseModel):
    reviewer: str | None = None
    reason: str | None = None


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


async def _get_reviewable(session: AsyncSession, client: Client, investigation_id: int) -> Investigation:
    inv = await session.get(Investigation, investigation_id)
    if inv is None or inv.client_id != client.id:
        raise HTTPException(status_code=404, detail="Investigation not found.")
    if inv.status not in REVIEWABLE_STATUSES:
        raise HTTPException(status_code=400, detail=f"Investigation is already '{inv.status}' — not reviewable.")
    return inv


async def _record_decision(
    session: AsyncSession, inv: Investigation, decision: str, new_status: str, body: ApprovalDecisionRequest,
) -> dict:
    session.add(ApprovalHistory(
        investigation_id=inv.id, decision=decision, reviewer=body.reviewer, reason=body.reason,
    ))
    session.add(InvestigationEvent(
        investigation_id=inv.id, from_status=inv.status, to_status=new_status,
        actor=body.reviewer or "system", detail={"decision": decision, "reason": body.reason},
    ))
    inv.status = new_status
    inv.updated_at = datetime.now(timezone.utc)
    await session.commit()
    return _serialize(inv)


@router.post("/clients/{client_id}/investigations/{investigation_id}/approve")
async def approve_investigation(
    investigation_id: int, body: ApprovalDecisionRequest,
    client: Client = Depends(get_active_client), session: AsyncSession = Depends(get_session),
) -> dict:
    inv = await _get_reviewable(session, client, investigation_id)
    return await _record_decision(session, inv, "approved", "approved", body)


@router.post("/clients/{client_id}/investigations/{investigation_id}/reject")
async def reject_investigation(
    investigation_id: int, body: ApprovalDecisionRequest,
    client: Client = Depends(get_active_client), session: AsyncSession = Depends(get_session),
) -> dict:
    inv = await _get_reviewable(session, client, investigation_id)
    return await _record_decision(session, inv, "rejected", "archived", body)


@router.post("/clients/{client_id}/investigations/{investigation_id}/request-revision")
async def request_investigation_revision(
    investigation_id: int, body: ApprovalDecisionRequest,
    client: Client = Depends(get_active_client), session: AsyncSession = Depends(get_session),
) -> dict:
    inv = await _get_reviewable(session, client, investigation_id)
    if inv.status != "waiting_human_review":
        raise HTTPException(status_code=400, detail="Only an investigation waiting for review can have a revision requested.")
    return await _record_decision(session, inv, "revision_requested", "recommendation_generated", body)
