"""Phase 2 Stage 3 — read routes for the intelligence engines that were
previously DB-only (Root Cause, Feature Importance) plus the new on-demand
engines (diagnostics, correlations, impact projection). Root Cause and
Feature Importance are nightly-only: a GET here reads the latest persisted
run and reports 'not-yet-computed' if none exists rather than triggering a
synchronous sklearn fit or RCA pass on the request path — same cost-class
boundary run_nightly_pipeline.py already draws for these two engines."""
from dataclasses import asdict

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_active_client
from app.db.models import (
    Client, EffortEstimation, FeatureImportanceRun, FeatureImportanceScore, ImpactPrediction, Insight, MetricCatalog,
    OpportunityScore, AnalystRecommendations, RecommendationRanking, RootCauseAnalysisNode, RootCauseAnalysisRun,
)
from app.db.session import get_session
from app.ml.correlation import compute_correlation_matrix
from app.scoring.impact_projection import project_impact
from app.stats.diagnostics import compute_all_diagnostics

router = APIRouter()


@router.get("/clients/{client_id}/root-cause/{insight_id}")
async def get_root_cause(
    insight_id: int, client: Client = Depends(get_active_client), session: AsyncSession = Depends(get_session),
) -> dict:
    insight = await session.get(Insight, insight_id)
    if insight is None or insight.client_id != client.id:
        raise HTTPException(status_code=404, detail="Insight not found.")

    run = (
        await session.execute(
            select(RootCauseAnalysisRun).where(
                RootCauseAnalysisRun.client_id == client.id, RootCauseAnalysisRun.insight_id == insight_id,
            ).order_by(RootCauseAnalysisRun.generated_at.desc()).limit(1)
        )
    ).scalar_one_or_none()
    if run is None:
        return {"status": "not-yet-computed"}
    if run.status != "ok":
        return {"status": run.status, "error": run.error, "generated_at": run.generated_at.isoformat()}

    nodes = (
        await session.execute(
            select(RootCauseAnalysisNode).where(RootCauseAnalysisNode.run_id == run.id).order_by(RootCauseAnalysisNode.depth, RootCauseAnalysisNode.id)
        )
    ).scalars().all()
    root = next((n for n in nodes if n.parent_node_id is None), None)

    return {
        "status": "ok", "method": run.method, "max_depth_reached": run.max_depth_reached,
        "confidence": float(run.confidence) if run.confidence is not None else None,
        "generated_at": run.generated_at.isoformat(),
        "root": _node_dict(root) if root else None,
        # Every non-root node under a synthetic site-level root, as PARALLEL
        # siblings (depth=1 dimension movers and depth=2 GSC page/query
        # leaves alike) — real property of this engine's v1 method, not a
        # true nested drill-down. See root_cause.py's own docstring.
        "children": [_node_dict(n) for n in nodes if n.parent_node_id is not None],
    }


def _node_dict(node: RootCauseAnalysisNode) -> dict:
    return {
        "depth": node.depth, "dimension_type": node.dimension_type, "dimension_value": node.dimension_value,
        "current_value": _f(node.current_value), "prior_value": _f(node.prior_value),
        "abs_change": _f(node.abs_change), "pct_change": _f(node.pct_change),
        "share_of_baseline_change_pct": _f(node.share_of_baseline_change_pct),
    }


@router.get("/clients/{client_id}/feature-importance/{target_metric_key}")
async def get_feature_importance(
    target_metric_key: str, client: Client = Depends(get_active_client), session: AsyncSession = Depends(get_session),
) -> dict:
    metric = await session.get(MetricCatalog, target_metric_key)
    if metric is None:
        raise HTTPException(status_code=404, detail="Unknown metric.")

    run = (
        await session.execute(
            select(FeatureImportanceRun).where(
                FeatureImportanceRun.client_id == client.id, FeatureImportanceRun.target_metric_key == target_metric_key,
            ).order_by(FeatureImportanceRun.generated_at.desc()).limit(1)
        )
    ).scalar_one_or_none()
    if run is None:
        return {"status": "not-yet-computed"}
    if run.status != "ok":
        return {"status": run.status, "error": run.error, "generated_at": run.generated_at.isoformat()}

    scores = (
        await session.execute(
            select(FeatureImportanceScore).where(FeatureImportanceScore.run_id == run.id).order_by(FeatureImportanceScore.rank)
        )
    ).scalars().all()

    return {
        "status": "ok", "model_type": run.model_type, "n_observations": run.n_observations,
        "model_score": _f(run.model_score), "confidence": _f(run.confidence),
        "generated_at": run.generated_at.isoformat(),
        "features": [
            {"feature_metric_key": s.feature_metric_key, "importance_pct": float(s.importance_pct), "rank": s.rank}
            for s in scores
        ],
    }


@router.get("/clients/{client_id}/diagnostics/{metric_key}")
async def get_diagnostics(
    metric_key: str, client: Client = Depends(get_active_client), session: AsyncSession = Depends(get_session),
) -> dict:
    metric = await session.get(MetricCatalog, metric_key)
    if metric is None:
        raise HTTPException(status_code=404, detail="Unknown metric.")
    results = await compute_all_diagnostics(session, client_id=client.id, metric_key=metric_key)
    return {name: asdict(result) for name, result in results.items()}


@router.get("/clients/{client_id}/correlations")
async def get_correlations(client: Client = Depends(get_active_client), session: AsyncSession = Depends(get_session)) -> dict:
    result = await compute_correlation_matrix(session, client_id=client.id)
    return asdict(result)


@router.get("/clients/{client_id}/effort-estimation/{recommendation_id}")
async def get_effort_estimation(
    recommendation_id: int, client: Client = Depends(get_active_client), session: AsyncSession = Depends(get_session),
) -> dict:
    rec = await session.get(AnalystRecommendations, recommendation_id)
    if rec is None or rec.client_id != client.id:
        raise HTTPException(status_code=404, detail="Recommendation not found.")

    estimate = (
        await session.execute(
            select(EffortEstimation).where(EffortEstimation.recommendation_id == recommendation_id)
        )
    ).scalar_one_or_none()
    if estimate is None:
        return {"status": "not-yet-computed"}
    if estimate.status != "ok":
        return {"status": estimate.status, "error": estimate.error, "generated_at": estimate.generated_at.isoformat()}

    return {
        "status": "ok", "category": estimate.category, "effort_level": estimate.effort_level,
        "effort_label": estimate.effort_label, "affected_page_count": estimate.affected_page_count,
        "affected_page_count_status": estimate.affected_page_count_status,
        "confidence": _f(estimate.confidence), "method_detail": estimate.method_detail,
        "generated_at": estimate.generated_at.isoformat(),
    }


@router.get("/clients/{client_id}/time-to-impact/{recommendation_id}")
async def get_time_to_impact(
    recommendation_id: int, client: Client = Depends(get_active_client), session: AsyncSession = Depends(get_session),
) -> dict:
    rec = await session.get(AnalystRecommendations, recommendation_id)
    if rec is None or rec.client_id != client.id:
        raise HTTPException(status_code=404, detail="Recommendation not found.")

    prediction = (
        await session.execute(
            select(ImpactPrediction).where(ImpactPrediction.recommendation_id == recommendation_id)
        )
    ).scalar_one_or_none()
    if prediction is None:
        return {"status": "not-yet-computed"}
    if prediction.status != "ok":
        return {"status": prediction.status, "error": prediction.error, "generated_at": prediction.generated_at.isoformat()}

    return {
        "status": "ok", "category": prediction.category,
        "duration_min_weeks": prediction.duration_min_weeks, "duration_max_weeks": prediction.duration_max_weeks,
        "expected_impact_magnitude": prediction.expected_impact_magnitude,
        "confidence": _f(prediction.confidence), "method_detail": prediction.method_detail,
        "generated_at": prediction.generated_at.isoformat(),
    }


@router.get("/clients/{client_id}/opportunity-score/{recommendation_id}")
async def get_opportunity_score(
    recommendation_id: int, client: Client = Depends(get_active_client), session: AsyncSession = Depends(get_session),
) -> dict:
    rec = await session.get(AnalystRecommendations, recommendation_id)
    if rec is None or rec.client_id != client.id:
        raise HTTPException(status_code=404, detail="Recommendation not found.")

    score = (
        await session.execute(
            select(OpportunityScore).where(OpportunityScore.recommendation_id == recommendation_id)
        )
    ).scalar_one_or_none()
    if score is None:
        return {"status": "not-yet-computed"}
    if score.status != "ok":
        return {"status": score.status, "error": score.error, "generated_at": score.generated_at.isoformat()}

    return {
        "status": "ok", "opportunity_score": _f(score.opportunity_score), "factors": score.factors,
        "confidence": _f(score.confidence), "method_detail": score.method_detail,
        "generated_at": score.generated_at.isoformat(),
    }


@router.get("/clients/{client_id}/recommendation-rankings")
async def get_recommendation_rankings(
    client: Client = Depends(get_active_client), session: AsyncSession = Depends(get_session),
) -> dict:
    """Every ranked ('ok') recommendation for this client, sorted by rank
    ascending, plus a count of how many were excluded as insufficient-data
    (missing upstream Opportunity Score/Effort Estimation) — visible, never
    silently dropped from the response."""
    rows = (
        await session.execute(select(RecommendationRanking).where(RecommendationRanking.client_id == client.id))
    ).scalars().all()
    ranked = sorted((r for r in rows if r.status == "ok"), key=lambda r: r.rank)
    excluded_count = sum(1 for r in rows if r.status != "ok")

    return {
        "excluded_count": excluded_count,
        "rankings": [
            {
                "recommendation_id": r.recommendation_id, "rank": r.rank, "priority_score": _f(r.priority_score),
                "confidence": _f(r.confidence), "method_detail": r.method_detail, "generated_at": r.generated_at.isoformat(),
            }
            for r in ranked
        ],
    }


class ImpactProjectionRequest(BaseModel):
    metric_key: str
    dimension_type: str = "site"
    dimension_value: str = "__site__"
    delta_value: float
    delta_direction: str
    current_value: float | None = None
    prior_value: float | None = None


@router.post("/clients/{client_id}/impact-projection")
async def post_impact_projection(
    body: ImpactProjectionRequest, client: Client = Depends(get_active_client), session: AsyncSession = Depends(get_session),
) -> dict:
    run = await project_impact(
        session, client_id=client.id, metric_key=body.metric_key,
        dimension_type=body.dimension_type, dimension_value=body.dimension_value,
        delta_value=body.delta_value, delta_direction=body.delta_direction,
        current_value=body.current_value, prior_value=body.prior_value,
    )
    await session.commit()
    return {
        "status": run.status, "mode": run.mode,
        "projected_dollar_delta": _f(run.projected_dollar_delta), "currency": run.currency,
        "projected_metric_unit_delta": _f(run.projected_metric_unit_delta), "metric_unit": run.metric_unit,
        "confidence": _f(run.confidence), "method_detail": run.method_detail, "generated_at": run.generated_at.isoformat(),
    }


def _f(value) -> float | None:
    return float(value) if value is not None else None
