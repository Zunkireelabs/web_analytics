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

from app.db.models import Client, ImpactPrediction, Insight, AnalystRecommendations
from app.db.session import SessionLocal
from app.intelligence.category_rules import category_for_metric
from app.intelligence.fix_outcomes import measured_evidence
from app.analysis.scope import active_clients

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
        clients = await active_clients(session)

    for client in clients:
        async with SessionLocal() as session:
            recommendations = (
                await session.execute(select(AnalystRecommendations).where(AnalystRecommendations.client_id == client.id))
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


async def _predict(session: AsyncSession, client_id: int, rec: AnalystRecommendations) -> None:
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

    # The duration and magnitude stay a hand-curated lookup by fix category (not fitted to this client). CONFIDENCE is different: it
    # is not stored at all until this client's own MEASURED fixes in this category are numerous enough to say something
    # (fix_outcomes.py, fed by the Node app's post-merge measurement), and then it is the lower bound of how often such a fix has
    # really improved clicks here, not a self-assessed number. It was stored as exactly 1.00 on every one of the 364 production rows
    # before this, which read as certainty. Existing predictions are never rewritten; new ones pick up what has been measured since.
    evidence = await measured_evidence(session, client_id, category)

    session.add(ImpactPrediction(
        client_id=client_id, recommendation_id=rec.id, status="ok", category=category,
        duration_min_weeks=duration_min, duration_max_weeks=duration_max, expected_impact_magnitude=magnitude,
        method_detail={
            "metric_key": insight.metric_key, "basis": "static_category_rule", "fitted_to_client_data": False,
            "measured_outcomes": evidence,
            "confidence_meaning": "lower bound (95%) of how often this client's own measured fixes in this category improved clicks",
        },
        confidence_score_id=None, confidence=evidence["confidence"],
    ))
