"""Time-to-Impact Prediction Engine (Phase 2 plan Stage 4) — a static,
hand-curated per-fix-category lookup (duration to see effect + expected
impact magnitude), explicitly SEO-best-practice-rules-based, not
statistically fit from this client's own data (there's no historical
"time from fix deployed to metric recovery" signal anywhere in this
service to fit against). Distinct from app/scoring/impact_projection.py,
which projects a *dollar* delta from an already-observed change — this
predicts *when* a not-yet-applied fix would start showing effect and how
big that effect is likely to be, for a fix that hasn't happened yet.

One row per Recommendation (same structural choice as Effort Estimation,
app/intelligence/effort_estimation.py): time-to-impact is a property of
the recommended fix, not the underlying insight."""
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import Client, ImpactPrediction, Insight, Recommendation
from app.db.session import SessionLocal
from app.intelligence.category_rules import category_for_metric
from app.scoring.confidence import compute_confidence

# (duration_min_weeks, duration_max_weeks, expected_impact_magnitude) per
# fix category. Reasoning: metadata fixes re-crawl/re-index fast but rarely
# move the needle much alone; content needs to be written, published, and
# evaluated for relevance/freshness; technical fixes are quick to deploy but
# Core Web Vitals/crawl signals take a few cycles to register; restructuring
# (link-building, funnel rework) compounds slowly but has the largest
# ceiling when it lands.
TIME_TO_IMPACT_BY_CATEGORY: dict[str, tuple[int, int, str]] = {
    "metadata": (1, 2, "low"),
    "content": (4, 8, "medium"),
    "technical": (2, 6, "medium"),
    "restructuring": (8, 16, "high"),
}


async def run_impact_prediction() -> None:
    async with SessionLocal() as session:
        clients = (await session.execute(select(Client).where(Client.status == "active"))).scalars().all()

    for client in clients:
        async with SessionLocal() as session:
            recommendations = (
                await session.execute(select(Recommendation).where(Recommendation.client_id == client.id))
            ).scalars().all()
            already_predicted = {
                r[0] for r in (
                    await session.execute(
                        select(ImpactPrediction.recommendation_id).where(ImpactPrediction.client_id == client.id)
                    )
                ).all()
            }
            for rec in recommendations:
                if rec.id in already_predicted:
                    continue
                await _predict(session, client.id, rec)
            await session.commit()


async def _predict(session: AsyncSession, client_id: int, rec: Recommendation) -> None:
    insight = await session.get(Insight, rec.insight_id)
    if insight is None:
        session.add(ImpactPrediction(
            client_id=client_id, recommendation_id=rec.id, status="insufficient-data",
            error="recommendation's insight no longer exists", method_detail={},
        ))
        return

    category = category_for_metric(insight.metric_key)
    if category is None:
        session.add(ImpactPrediction(
            client_id=client_id, recommendation_id=rec.id, status="insufficient-data",
            error=f"no category rule for metric_key '{insight.metric_key}'", method_detail={"metric_key": insight.metric_key},
        ))
        return

    duration_min, duration_max, magnitude = TIME_TO_IMPACT_BY_CATEGORY[category]

    confidence_id, confidence = await compute_confidence(
        session, client_id=client_id, subject_type="impact_prediction", subject_id=rec.id,
        components={"data_completeness": 1.0},
    )

    session.add(ImpactPrediction(
        client_id=client_id, recommendation_id=rec.id, status="ok", category=category,
        duration_min_weeks=duration_min, duration_max_weeks=duration_max, expected_impact_magnitude=magnitude,
        method_detail={"metric_key": insight.metric_key},
        confidence_score_id=confidence_id, confidence=confidence.score,
    ))
