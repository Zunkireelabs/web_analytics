"""Recommendation Prioritizer (Phase 2 plan Stage 7) — ranks every client's
active recommendations by a single priority_score, one row per
Recommendation, then assigns a 1-based rank within that client.

DEVIATION FROM THE PLAN TEXT, documented here rather than silently: the
plan's formula is (potential_business_value x probability_of_success x
confidence) / estimated_effort. Two of those four terms have no honest
independent source in this codebase:
- potential_business_value, if read literally as an always-dollar figure,
  would make every recommendation for a client without client_business_values
  configured permanently insufficient-data — defeating the point of the
  Mode 1 fallback added to app/scoring/impact_projection.py (Stage 5).
- probability_of_success has no source at all (see
  app/intelligence/opportunity_scoring.py's own docstring — no outcome-
  tracking loop exists to ground it), and Opportunity Scoring itself
  already excludes it as a factor for the same reason.

Since OpportunityScore's own composite (app/intelligence/
opportunity_scoring.py) already blends impact + trend + existing
performance into one 0-100, cross-recommendation-comparable number, this
engine uses it as a single combined stand-in for
(potential_business_value x probability_of_success) — closer to a
RICE/ICE-style prioritization score than the plan's literal 4-term
formula, but the only version that (a) never fabricates a signal and
(b) still produces a real ranking for clients without business values
configured:

    priority_score = (opportunity_score / 100) * confidence / effort_level

confidence is OpportunityScore's own confidence (already reflects how many
of its 6 live factors were actually available for this recommendation) —
reused rather than inventing a fifth independent confidence source.
effort_level is Stage 3's EffortEstimation.effort_level (1-5).

Any recommendation missing EITHER upstream row (or either upstream row's
own status != 'ok') is excluded from ranking with status='insufficient-
data' — never defaulted to a 0 or 1 stand-in value."""
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import Client, EffortEstimation, OpportunityScore, Recommendation, RecommendationRanking
from app.db.session import SessionLocal
from app.scoring.confidence import compute_confidence


async def run_recommendation_prioritizer() -> None:
    async with SessionLocal() as session:
        clients = (await session.execute(select(Client).where(Client.status == "active"))).scalars().all()

    for client in clients:
        async with SessionLocal() as session:
            # resolved/dismissed recommendations are excluded from ranking
            # entirely (not just skipped-if-already-ranked) — this output
            # feeds an "what to work on next" queue, and staff already
            # closed these out. Effort/Opportunity Scoring intentionally
            # don't apply this filter (they're factual annotations of the
            # recommendation itself, valid even after resolution); only the
            # Prioritizer's ranking is status-sensitive.
            recommendations = (
                await session.execute(
                    select(Recommendation).where(
                        Recommendation.client_id == client.id, Recommendation.status.notin_(["resolved", "dismissed"]),
                    )
                )
            ).scalars().all()
            already_ranked = {
                r[0] for r in (
                    await session.execute(
                        select(RecommendationRanking.recommendation_id).where(RecommendationRanking.client_id == client.id)
                    )
                ).all()
            }
            to_score = [r for r in recommendations if r.id not in already_ranked]

            scored: list[tuple[Recommendation, float, float, int]] = []
            for rec in to_score:
                result = await _priority_inputs(session, rec)
                if result is None:
                    session.add(RecommendationRanking(
                        client_id=client.id, recommendation_id=rec.id, status="insufficient-data",
                        error="missing or non-ok OpportunityScore/EffortEstimation for this recommendation", method_detail={},
                    ))
                    continue
                opportunity_score, confidence, effort_level = result
                priority_score = (opportunity_score / 100) * confidence / effort_level
                scored.append((rec, priority_score, confidence, effort_level))

            # Rank only THIS batch's newly-scored rows among themselves —
            # existing ranked rows from prior nights are left untouched
            # (already_ranked skips them above), same idempotency contract
            # as every other Stage 3-7 engine. A full client-wide re-rank
            # would need to re-touch every row every night, which none of
            # the sibling engines do either.
            scored.sort(key=lambda t: t[1], reverse=True)
            for rank, (rec, priority_score, confidence, effort_level) in enumerate(scored, start=1):
                confidence_id, confidence_result = await compute_confidence(
                    session, client_id=client.id, subject_type="recommendation_ranking", subject_id=rec.id,
                    components={"data_completeness": 1.0},
                )
                session.add(RecommendationRanking(
                    client_id=client.id, recommendation_id=rec.id, status="ok",
                    priority_score=round(priority_score, 4), rank=rank,
                    method_detail={"opportunity_score_confidence": confidence, "effort_level": effort_level},
                    confidence_score_id=confidence_id, confidence=confidence_result.score,
                ))
            await session.commit()


async def _priority_inputs(session: AsyncSession, rec: Recommendation) -> tuple[float, float, int] | None:
    opportunity = (
        await session.execute(select(OpportunityScore).where(OpportunityScore.recommendation_id == rec.id))
    ).scalar_one_or_none()
    if opportunity is None or opportunity.status != "ok" or opportunity.opportunity_score is None or opportunity.confidence is None:
        return None

    effort = (
        await session.execute(select(EffortEstimation).where(EffortEstimation.recommendation_id == rec.id))
    ).scalar_one_or_none()
    if effort is None or effort.status != "ok" or effort.effort_level is None:
        return None

    return float(opportunity.opportunity_score), float(opportunity.confidence), effort.effort_level
