"""Effort Estimation Engine (Phase 2 plan Stage 3) — rule-based (never
statistically fit), one effort_estimations row per Recommendation. Effort
is base-by-fix-category (app/intelligence/category_rules.py) scaled up by
how many pages the fix touches (app/intelligence/affected_pages.py) — a
site-wide metadata rewrite across 40 pages is more effort than the same
rewrite on 2, even though both are the same "category" of fix. Idempotent
via effort_estimations.recommendation_id being unique: a Recommendation row
is created once and updated in place (see app/insights/recommendations.py),
so one estimate per recommendation never goes stale in a way that matters
here — category and page count are properties of the recommendation's
target metric/dimension, not its narration text."""
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import Client, EffortEstimation, Insight, AnalystRecommendations
from app.db.session import SessionLocal
from app.intelligence.affected_pages import resolve_affected_page_count
from app.intelligence.category_rules import BASE_EFFORT_BY_CATEGORY, EFFORT_LABELS, category_for_metric
from app.scoring.confidence import compute_confidence

# (min_page_count, level_bump) — first matching lower bound wins, applied
# only when affected_page_count_status == 'ok'. Never applied on top of an
# unresolved/inapplicable count, which would fabricate a scale signal the
# engine doesn't actually have.
PAGE_COUNT_BUMP_THRESHOLDS = ((21, 2), (6, 1), (0, 0))


async def run_effort_estimation() -> None:
    async with SessionLocal() as session:
        clients = (await session.execute(select(Client).where(Client.status == "active"))).scalars().all()

    for client in clients:
        async with SessionLocal() as session:
            recommendations = (
                await session.execute(select(AnalystRecommendations).where(AnalystRecommendations.client_id == client.id))
            ).scalars().all()
            already_estimated = {
                r[0] for r in (
                    await session.execute(
                        select(EffortEstimation.recommendation_id).where(EffortEstimation.client_id == client.id)
                    )
                ).all()
            }
            for rec in recommendations:
                if rec.id in already_estimated:
                    continue
                await _estimate(session, client.id, rec)
            await session.commit()


async def _estimate(session: AsyncSession, client_id: int, rec: AnalystRecommendations) -> None:
    insight = await session.get(Insight, rec.insight_id)
    if insight is None:
        session.add(EffortEstimation(
            client_id=client_id, recommendation_id=rec.id, status="insufficient-data",
            error="recommendation's insight no longer exists", method_detail={},
        ))
        return

    category = category_for_metric(insight.metric_key)
    if category is None:
        session.add(EffortEstimation(
            client_id=client_id, recommendation_id=rec.id, status="insufficient-data",
            error=f"no category rule for metric_key '{insight.metric_key}'", method_detail={"metric_key": insight.metric_key},
        ))
        return

    page_count, page_count_status = await resolve_affected_page_count(
        session, client_id, insight.metric_key, insight.dimension_type, insight.dimension_value,
    )

    base_level = BASE_EFFORT_BY_CATEGORY[category]
    bump = _bump_for_page_count(page_count) if page_count_status == "ok" else 0
    effort_level = min(base_level + bump, 5)

    confidence_id, confidence = await compute_confidence(
        session, client_id=client_id, subject_type="effort_estimation", subject_id=rec.id,
        components={"data_completeness": _data_completeness(page_count_status)},
    )

    session.add(EffortEstimation(
        client_id=client_id, recommendation_id=rec.id, status="ok",
        category=category, effort_level=effort_level, effort_label=EFFORT_LABELS[effort_level],
        affected_page_count=page_count, affected_page_count_status=page_count_status,
        method_detail={
            "metric_key": insight.metric_key, "base_level": base_level, "page_count_bump": bump,
        },
        confidence_score_id=confidence_id, confidence=confidence.score,
    ))


def _bump_for_page_count(page_count: int) -> int:
    for threshold, bump in PAGE_COUNT_BUMP_THRESHOLDS:
        if page_count >= threshold:
            return bump
    return 0


def _data_completeness(page_count_status: str) -> float | None:
    """'not-applicable' (the metric has no page dimension concept at all)
    is not a data gap — no signal either way, so None rather than a
    fabricated penalty. 'insufficient-data' (the metric IS page-
    attributable but no rows exist yet) is a real, deserved 0.0."""
    if page_count_status == "ok":
        return 1.0
    if page_count_status == "insufficient-data":
        return 0.0
    return None
