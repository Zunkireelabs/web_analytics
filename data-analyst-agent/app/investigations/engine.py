"""Investigation Engine — the Phase 3 orchestration layer over the existing
Phase 1/2 analytics pipeline. Creates/updates one persistent Investigation
per (client, metric, dimension, insight_type) — deliberately NOT keyed by
period_start (unlike Insight) so a recurring issue is tracked as one
evolving investigation across nights rather than a fresh row every time the
Insight Engine replaces its underlying Insight, satisfying the spec's
"prevent duplicate investigations" mandate.

Runs LAST in the nightly pipeline (after Root Cause, Opportunity Scoring,
and the Prioritizer), so a brand-new investigation can jump straight from
'detected' through 'recommendation_generated' in one pass — those four
automatic states genuinely do complete together, since this service's
pipeline is a single deterministic nightly run rather than a multi-day
real-time process. Everything past 'recommendation_generated' requires a
human action (draft review) or a later pipeline stage (auto-draft
triggering — see the M4 milestone), so this engine never advances an
existing investigation past what it already reached.

Never invents anything: every field written here is copied from a row an
earlier stage in tonight's run already wrote."""
from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import (
    Client, Insight, Investigation, InvestigationEvent, OpportunityScore,
    AnalystRecommendations, RecommendationRanking, RootCauseAnalysisRun,
)
from app.db.session import SessionLocal

# States a brand-new investigation reaches automatically in one nightly
# pass, in order.
AUTO_STATES = ("detected", "investigating", "evidence_collected", "recommendation_generated")
# A Recommendation reaching one of these terminal states is a direct,
# already-real human signal (via the existing resolve/dismiss endpoints)
# that closes the investigation immediately — no need to wait for the
# fuller draft/approval workflow (M4) when staff already said "done"
# through the mechanism that exists today.
RECOMMENDATION_TERMINAL_MAP = {"resolved": "completed", "dismissed": "archived"}
# An investigation already in one of these states is done — a fresh
# recurrence of the same (metric, dimension, insight_type) becomes its OWN
# new investigation instead of silently reopening staff's completed/
# archived work. That new investigation is exactly the "repeated issue"
# signal Step 11 (AI memory) wants to track.
CLOSED_STATUSES = ("completed", "archived")


async def run_investigation_engine() -> None:
    async with SessionLocal() as session:
        clients = (await session.execute(select(Client).where(Client.status == "active"))).scalars().all()

    for client in clients:
        async with SessionLocal() as session:
            await _sync_investigations(session, client.id)
            await session.commit()


async def _sync_investigations(session: AsyncSession, client_id: int) -> None:
    recs = (
        await session.execute(select(AnalystRecommendations).where(AnalystRecommendations.client_id == client_id))
    ).scalars().all()

    for rec in recs:
        # Once a recommendation's own investigation has closed, leave it
        # alone permanently — re-running the dedup lookup below would find
        # nothing (it deliberately excludes closed investigations) and spawn
        # a spurious duplicate for an insight that already has a finished
        # investigation.
        if rec.investigation_id is not None:
            linked = await session.get(Investigation, rec.investigation_id)
            if linked is not None and linked.status in CLOSED_STATUSES:
                continue
        insight = await session.get(Insight, rec.insight_id)
        if insight is None:
            continue
        await _upsert_investigation(session, client_id=client_id, insight=insight, rec=rec)


async def _upsert_investigation(
    session: AsyncSession, *, client_id: int, insight: Insight, rec: AnalystRecommendations,
) -> None:
    existing = (
        await session.execute(
            select(Investigation).where(
                Investigation.client_id == client_id,
                Investigation.metric_key == insight.metric_key,
                Investigation.dimension_type == insight.dimension_type,
                Investigation.dimension_value == insight.dimension_value,
                Investigation.insight_type == insight.insight_type,
                Investigation.status.notin_(CLOSED_STATUSES),
            )
        )
    ).scalar_one_or_none()

    confidence = await _pick_confidence(session, rec)
    fields = dict(
        severity=insight.severity,
        priority=rec.priority,
        affected_metrics=[{
            "metric_key": insight.metric_key, "dimension_type": insight.dimension_type,
            "dimension_value": insight.dimension_value,
        }],
        summary=rec.recommendation_text,
        evidence=insight.evidence,
        # forecast_risk insights already carry model/horizon/predicted_date/
        # days_until_drop in their own evidence dict (see
        # app/insights/engine.py::_forecast_risk_insights) — reused as-is
        # rather than re-deriving it from ForecastRun/ForecastPoint here.
        forecast_outlook=insight.evidence if insight.insight_type == "forecast_risk" else None,
        root_cause_text=rec.root_cause_text,
        confidence=confidence,
        source_insight_id=insight.id,
        updated_at=datetime.now(timezone.utc),
    )

    if existing is not None:
        for key, value in fields.items():
            setattr(existing, key, value)
        rec.investigation_id = existing.id
        _maybe_close(session, existing, rec)
        return

    investigation = Investigation(
        client_id=client_id, metric_key=insight.metric_key, dimension_type=insight.dimension_type,
        dimension_value=insight.dimension_value, insight_type=insight.insight_type,
        status="detected", **fields,
    )
    session.add(investigation)
    await session.flush()  # need investigation.id for the FK below and the events
    rec.investigation_id = investigation.id

    from_status = None
    for to_status in AUTO_STATES:
        session.add(InvestigationEvent(investigation_id=investigation.id, from_status=from_status, to_status=to_status))
        from_status = to_status
    investigation.status = AUTO_STATES[-1]

    _maybe_close(session, investigation, rec)


def _maybe_close(session: AsyncSession, investigation: Investigation, rec: AnalystRecommendations) -> None:
    target = RECOMMENDATION_TERMINAL_MAP.get(rec.status)
    if target is None or investigation.status == target:
        return
    session.add(InvestigationEvent(investigation_id=investigation.id, from_status=investigation.status, to_status=target))
    investigation.status = target


async def _pick_confidence(session: AsyncSession, rec: AnalystRecommendations) -> float | None:
    """Prefer the Prioritizer's confidence (the most downstream, most
    complete signal — it only exists once Opportunity Scoring and Effort
    Estimation both ran), falling back to Opportunity Scoring's own, then
    Root Cause's — whichever upstream engine actually produced a real
    number for this recommendation's insight."""
    ranking = (
        await session.execute(select(RecommendationRanking).where(RecommendationRanking.recommendation_id == rec.id))
    ).scalar_one_or_none()
    if ranking is not None and ranking.confidence is not None:
        return ranking.confidence

    opportunity = (
        await session.execute(select(OpportunityScore).where(OpportunityScore.recommendation_id == rec.id))
    ).scalar_one_or_none()
    if opportunity is not None and opportunity.confidence is not None:
        return opportunity.confidence

    rca = (
        await session.execute(select(RootCauseAnalysisRun).where(RootCauseAnalysisRun.insight_id == rec.insight_id))
    ).scalar_one_or_none()
    if rca is not None and rca.confidence is not None:
        return rca.confidence

    return None
