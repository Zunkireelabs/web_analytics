"""Opportunity Rollup (Phase 3) — one Opportunity row per Investigation,
aggregating the existing OpportunityScore/ImpactProjectionRun engine
output. No new scoring math: every field here is copied from a row an
earlier nightly stage already wrote. Runs after the Investigation Engine,
since it needs investigation_id to exist on the current Recommendation."""
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import Client, ImpactProjectionRun, Investigation, Opportunity, OpportunityScore, AnalystRecommendations
from app.db.session import SessionLocal


def _opportunity_status(investigation_status: str) -> str:
    if investigation_status == "completed":
        return "captured"
    if investigation_status == "archived":
        return "expired"
    return "open"


async def run_opportunity_rollup() -> None:
    async with SessionLocal() as session:
        clients = (await session.execute(select(Client).where(Client.status == "active"))).scalars().all()

    for client in clients:
        async with SessionLocal() as session:
            investigations = (
                await session.execute(select(Investigation).where(Investigation.client_id == client.id))
            ).scalars().all()
            for investigation in investigations:
                await _upsert_opportunity(session, client_id=client.id, investigation=investigation)
            await session.commit()


async def _upsert_opportunity(session: AsyncSession, *, client_id: int, investigation: Investigation) -> None:
    # Investigation has no direct FK to Recommendation (it's the other way
    # around) — the current one (if any) is whichever Recommendation still
    # points back at this investigation_id. At most one exists at a time in
    # practice (see app/investigations/engine.py), but order defensively in
    # case that ever changes.
    rec = (
        await session.execute(
            select(AnalystRecommendations)
            .where(AnalystRecommendations.investigation_id == investigation.id)
            .order_by(AnalystRecommendations.generated_at.desc())
        )
    ).scalars().first()

    opportunity_score = confidence = None
    if rec is not None:
        score_row = (
            await session.execute(select(OpportunityScore).where(OpportunityScore.recommendation_id == rec.id))
        ).scalar_one_or_none()
        if score_row is not None and score_row.status == "ok":
            opportunity_score = score_row.opportunity_score
            confidence = score_row.confidence

    # ImpactProjectionRun is keyed by (metric, dimension), not
    # recommendation_id — Investigation already carries those three fields,
    # so this reuses the latest 'ok' run for the same metric/dimension
    # rather than re-projecting anything.
    impact = (
        await session.execute(
            select(ImpactProjectionRun)
            .where(
                ImpactProjectionRun.client_id == client_id,
                ImpactProjectionRun.metric_key == investigation.metric_key,
                ImpactProjectionRun.dimension_type == investigation.dimension_type,
                ImpactProjectionRun.dimension_value == investigation.dimension_value,
                ImpactProjectionRun.status == "ok",
            )
            .order_by(ImpactProjectionRun.generated_at.desc())
        )
    ).scalars().first()

    forecast_gain = None
    business_impact = None
    business_impact_currency = None
    if impact is not None and impact.mode == "currency" and impact.projected_dollar_delta is not None:
        business_impact = impact.projected_dollar_delta
        business_impact_currency = impact.currency
        forecast_gain = {"mode": "currency", "value": float(impact.projected_dollar_delta), "currency": impact.currency}
    elif impact is not None and impact.mode == "metric_unit" and impact.projected_metric_unit_delta is not None:
        forecast_gain = {"mode": "metric_unit", "value": float(impact.projected_metric_unit_delta), "unit": impact.metric_unit}

    recommendation_count = (
        await session.scalar(
            select(func.count()).select_from(AnalystRecommendations).where(AnalystRecommendations.investigation_id == investigation.id)
        )
    ) or 0

    fields = dict(
        opportunity_score=opportunity_score, priority=investigation.priority, forecast_gain=forecast_gain,
        business_impact=business_impact, business_impact_currency=business_impact_currency,
        confidence=confidence, recommendation_count=recommendation_count,
        status=_opportunity_status(investigation.status),
    )

    existing = (
        await session.execute(select(Opportunity).where(Opportunity.investigation_id == investigation.id))
    ).scalar_one_or_none()

    if existing is not None:
        for key, value in fields.items():
            setattr(existing, key, value)
        return

    session.add(Opportunity(client_id=client_id, investigation_id=investigation.id, **fields))
