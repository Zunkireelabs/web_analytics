"""Opportunity Scoring Engine (Phase 2 plan Stage 6) — one composite
opportunity_score (0-100) per Recommendation, blending 6 of the plan's 8
named factors. Two factors, search_volume and probability_of_success, have
no honest signal anywhere in this codebase and are ALWAYS excluded rather
than fabricated:
- search_volume: no search-volume data source is integrated yet (budget-
  blocked DataForSEO work) — same gap the plan itself already flags.
- probability_of_success: this service has no outcome-tracking loop that
  measures whether a past recommendation actually worked once resolved, so
  there's no real signal to ground a success-probability estimate on.

Every factor is stored individually as {value, weight, included, reason} —
a missing/excluded factor is always visible, never silently treated as 0.
Weight is redistributed across whichever factors ARE included (same
principle as app/scoring/confidence.py::compute_confidence), so a client
missing e.g. an industry tag still gets a real score from what IS
available, never a fabricated placeholder for what isn't.

All factor values are oriented so higher = more opportunity, EXCEPT
'difficulty' (stored as its literal, un-inverted meaning — higher =
harder) — inverted only at composite-score time, so the stored value
still means what its name says."""
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.routes.benchmarks import get_industry_percentiles
from app.db.models import (
    Client, EffortEstimation, Insight, MetricObservation, OpportunityScore,
    AnalystRecommendations, RootCauseAnalysisRun,
)
from app.db.session import SessionLocal
from app.insights.recommendations import LOWER_IS_BETTER_METRICS, impact_inputs_from_insight
from app.scoring.confidence import compute_confidence
from app.scoring.impact_projection import project_impact

# Hand-picked normalization constants — not derived from data, since there's
# no distribution of "all possible impacts/page-counts" this service could
# fit them from. Flagged for adjustment once real usage patterns emerge.
IMPACT_DOLLAR_SATURATION = 5000  # a $5,000/period absolute swing reads as "maximal" opportunity
AFFECTED_PAGE_COUNT_SATURATION = 50  # 50+ affected pages reads as "maximal" footprint

FACTOR_WEIGHTS = {
    "impact": 0.25,
    "statistical_confidence": 0.15,
    "affected_page_count": 0.10,
    "search_volume": 0.15,
    "trend_direction": 0.10,
    "existing_performance": 0.10,
    "difficulty": 0.10,
    "probability_of_success": 0.05,
}


async def run_opportunity_scoring() -> None:
    async with SessionLocal() as session:
        clients = (await session.execute(select(Client).where(Client.status == "active"))).scalars().all()

    for client in clients:
        async with SessionLocal() as session:
            recommendations = (
                await session.execute(select(AnalystRecommendations).where(AnalystRecommendations.client_id == client.id))
            ).scalars().all()
            already_scored = {
                r[0] for r in (
                    await session.execute(
                        select(OpportunityScore.recommendation_id).where(OpportunityScore.client_id == client.id)
                    )
                ).all()
            }
            for rec in recommendations:
                if rec.id in already_scored:
                    continue
                await _score(session, client, rec)
            await session.commit()


async def _score(session: AsyncSession, client: Client, rec: AnalystRecommendations) -> None:
    insight = await session.get(Insight, rec.insight_id)
    if insight is None:
        session.add(OpportunityScore(
            client_id=client.id, recommendation_id=rec.id, status="insufficient-data",
            error="recommendation's insight no longer exists", factors={}, method_detail={},
        ))
        return

    effort = (
        await session.execute(select(EffortEstimation).where(EffortEstimation.recommendation_id == rec.id))
    ).scalar_one_or_none()

    factors = {
        "impact": await _impact_factor(session, client.id, insight),
        "statistical_confidence": await _statistical_confidence_factor(session, client.id, insight),
        "affected_page_count": _affected_page_count_factor(effort),
        "search_volume": _excluded("search volume data source not yet integrated (DataForSEO integration pending budget approval)"),
        "trend_direction": _trend_direction_factor(insight),
        "existing_performance": await _existing_performance_factor(session, client, insight),
        "difficulty": _difficulty_factor(effort),
        "probability_of_success": _excluded("no historical outcome-tracking data exists yet to estimate success probability"),
    }

    score_0_1, total_weight = _composite(factors)
    if total_weight == 0:
        session.add(OpportunityScore(
            client_id=client.id, recommendation_id=rec.id, status="insufficient-data",
            error="no opportunity factors were computable for this recommendation", factors=factors, method_detail={},
        ))
        return

    opportunity_score = round(score_0_1 * 100, 1)
    n_included = sum(1 for f in factors.values() if f["included"])

    confidence_id, confidence = await compute_confidence(
        session, client_id=client.id, subject_type="opportunity_score", subject_id=rec.id,
        components={"data_completeness": n_included / len(factors)},
    )

    session.add(OpportunityScore(
        client_id=client.id, recommendation_id=rec.id, status="ok", opportunity_score=opportunity_score,
        factors=factors, method_detail={"weights": FACTOR_WEIGHTS, "total_weight_used": total_weight},
        confidence_score_id=confidence_id, confidence=confidence.score,
    ))


def _composite(factors: dict) -> tuple[float, float]:
    total_weighted, total_weight = 0.0, 0.0
    for name, factor in factors.items():
        if not factor["included"]:
            continue
        value = factor["value"]
        contribution = (1 - value) if name == "difficulty" else value
        total_weighted += contribution * factor["weight"]
        total_weight += factor["weight"]
    return (total_weighted / total_weight if total_weight else 0.0), total_weight


def _excluded(reason: str) -> dict:
    return {"value": None, "weight": 0.0, "included": False, "reason": reason}


def _factor(value: float, weight: float) -> dict:
    return {"value": round(value, 4), "weight": weight, "included": True, "reason": None}


async def _impact_factor(session: AsyncSession, client_id: int, insight: Insight) -> dict:
    weight = FACTOR_WEIGHTS["impact"]
    delta = impact_inputs_from_insight(insight)
    if delta is None:
        return {**_excluded("insight evidence has no clear before/after pair to project impact from"), "weight": weight}

    run = await project_impact(
        session, client_id=client_id, metric_key=insight.metric_key,
        dimension_type=insight.dimension_type, dimension_value=insight.dimension_value,
        delta_value=delta["delta_value"], delta_direction=delta["delta_direction"],
        current_value=delta.get("current_value"), prior_value=delta.get("prior_value"),
    )
    await session.flush()
    if run.status != "ok":
        return {**_excluded(f"impact projection status='{run.status}'"), "weight": weight}
    if run.mode != "currency":
        return {**_excluded("no dollar figure available (business values not configured) — not comparable across recommendations in raw metric units"), "weight": weight}

    value = min(abs(float(run.projected_dollar_delta)) / IMPACT_DOLLAR_SATURATION, 1.0)
    return _factor(value, weight)


async def _statistical_confidence_factor(session: AsyncSession, client_id: int, insight: Insight) -> dict:
    weight = FACTOR_WEIGHTS["statistical_confidence"]
    rca = (
        await session.execute(
            select(RootCauseAnalysisRun).where(
                RootCauseAnalysisRun.client_id == client_id, RootCauseAnalysisRun.insight_id == insight.id,
            ).order_by(RootCauseAnalysisRun.generated_at.desc()).limit(1)
        )
    ).scalar_one_or_none()
    if rca is None or rca.status != "ok" or rca.confidence is None:
        return {**_excluded("root cause analysis has not produced a confidence score for this insight"), "weight": weight}
    return _factor(float(rca.confidence), weight)


def _affected_page_count_factor(effort: EffortEstimation | None) -> dict:
    weight = FACTOR_WEIGHTS["affected_page_count"]
    if effort is None or effort.status != "ok" or effort.affected_page_count_status != "ok":
        return {**_excluded("effort estimation has no resolved affected-page count for this recommendation"), "weight": weight}
    value = min(effort.affected_page_count / AFFECTED_PAGE_COUNT_SATURATION, 1.0)
    return _factor(value, weight)


def _trend_direction_factor(insight: Insight) -> dict:
    weight = FACTOR_WEIGHTS["trend_direction"]
    delta = impact_inputs_from_insight(insight)
    if delta is None:
        return {**_excluded("insight evidence has no clear before/after pair to determine trend direction"), "weight": weight}
    value = 1.0 if delta["delta_direction"] == "decline" else 0.0
    return _factor(value, weight)


async def _existing_performance_factor(session: AsyncSession, client: Client, insight: Insight) -> dict:
    weight = FACTOR_WEIGHTS["existing_performance"]
    if client.industry is None:
        return {**_excluded("client has no industry set"), "weight": weight}

    # exclude_client_id is mandatory here, not an optimization. Without it this
    # client is inside the distribution it is being scored against — it partly
    # measures itself — and with a small group the other members' raw values
    # become recoverable from the factors this function stores against THIS
    # client. See the disclosure-control note in app/api/routes/benchmarks.py.
    percentiles = await get_industry_percentiles(session, insight.metric_key, exclude_client_id=client.id)
    group = percentiles.get(client.industry)
    if group is None:
        return {**_excluded(f"fewer than the minimum peer clients in industry '{client.industry}' with data for this metric"), "weight": weight}

    current_value = await session.scalar(
        select(MetricObservation.value).where(
            MetricObservation.client_id == client.id, MetricObservation.metric_key == insight.metric_key,
            MetricObservation.dimension_type == "site", MetricObservation.dimension_value == "__site__",
        ).order_by(MetricObservation.period_start.desc()).limit(1)
    )
    if current_value is None:
        return {**_excluded("no current value for this client/metric"), "weight": weight}

    spread = group["p75"] - group["p25"]
    if spread == 0:
        value = 0.5  # every peer clustered at the same value — can't distinguish under/over-performing
    else:
        frac = max(0.0, min((float(current_value) - group["p25"]) / spread, 1.0))
        lower_is_better = insight.metric_key in LOWER_IS_BETTER_METRICS
        value = frac if lower_is_better else (1 - frac)
    return _factor(value, weight)


def _difficulty_factor(effort: EffortEstimation | None) -> dict:
    weight = FACTOR_WEIGHTS["difficulty"]
    if effort is None or effort.status != "ok":
        return {**_excluded("effort estimation has not run for this recommendation"), "weight": weight}
    value = (effort.effort_level - 1) / 4  # 0 (Very Low) .. 1 (Very High) — literal difficulty, not inverted
    return _factor(value, weight)
