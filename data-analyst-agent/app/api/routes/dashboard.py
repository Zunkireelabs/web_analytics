from collections import defaultdict

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_active_client
from app.db.models import (
    Anomaly, Client, ForecastPoint, ForecastRun, IngestionRun, Insight,
    MetricCatalog, MetricObservation, MetricPeriodStats, Recommendation,
)
from app.db.session import get_session

router = APIRouter()


@router.get("/dashboard/{client_id}")
async def get_dashboard(client: Client = Depends(get_active_client), session: AsyncSession = Depends(get_session)) -> dict:
    """Cache-only — no LLM call. Driven entirely by metrics_catalog metadata
    (dashboard_group/visualization_type/icon): adding a metric to the
    dashboard later is a catalog row change, not a frontend code change."""
    metrics = (
        await session.execute(select(MetricCatalog).where(MetricCatalog.enabled.is_(True)))
    ).scalars().all()

    groups: dict[str, list] = defaultdict(list)
    for metric in metrics:
        groups[metric.dashboard_group or "Other"].append(await _metric_card(session, client.id, metric))

    last_ingested_at = await session.scalar(
        select(func.max(IngestionRun.created_at)).where(IngestionRun.client_id == client.id, IngestionRun.status == "ok")
    )

    insights_rows = (
        await session.execute(select(Insight).where(Insight.client_id == client.id).order_by(Insight.generated_at.desc()).limit(20))
    ).scalars().all()
    insights = []
    for i in insights_rows:
        rec = (await session.execute(select(Recommendation).where(Recommendation.insight_id == i.id))).scalar_one_or_none()
        if rec is not None and rec.status in ("resolved", "dismissed"):
            continue  # staff already marked this occurrence solved or not worth acting on
        insights.append({
            # id — added for the AI Analyst Workspace's Root Cause /
            # Reasoning Panel (GET /clients/{client_id}/root-cause/{insight_id}),
            # which needs the Insight row's own id, not just its natural key.
            "id": i.id,
            "metric_key": i.metric_key, "insight_type": i.insight_type, "severity": i.severity,
            "period_start": i.period_start.isoformat(), "evidence": i.evidence,
            "dimension_type": i.dimension_type, "dimension_value": i.dimension_value,
            "recommendation_id": rec.id if rec else None,
            "root_cause": rec.root_cause_text if rec else None,
            "recommendation": rec.recommendation_text if rec else None,
            "narration_status": rec.narration_status if rec else None,
        })

    return {
        "client": {"id": client.id, "name": client.name, "timezone": client.timezone},
        "last_ingested_at": last_ingested_at.isoformat() if last_ingested_at else None,
        "groups": groups,
        "insights": insights,
    }


@router.get("/dashboard/{client_id}/series/{metric_key}")
async def get_metric_series(
    metric_key: str, client: Client = Depends(get_active_client), session: AsyncSession = Depends(get_session),
) -> dict:
    """Cache-only, like GET /dashboard/{client_id} — the raw site-level
    observation history _metric_card's latest_value/period_stats summarize
    away. Exists for the Analyst trend chart, which needs the full series
    (client-side bucketed into week/month) to draw alongside the same
    forecast band _metric_card already exposes."""
    metric = await session.get(MetricCatalog, metric_key)
    if metric is None or not metric.enabled:
        raise HTTPException(status_code=404, detail="Unknown or disabled metric")

    rows = (
        await session.execute(
            select(MetricObservation.period_start, MetricObservation.value).where(
                MetricObservation.client_id == client.id, MetricObservation.metric_key == metric_key,
                MetricObservation.dimension_type == "site", MetricObservation.dimension_value == "__site__",
            ).order_by(MetricObservation.period_start)
        )
    ).all()

    return {
        "client": {"id": client.id, "name": client.name},
        "metric_key": metric.metric_key, "display_name": metric.display_name, "unit": metric.unit,
        "series": [
            {"date": period_start.isoformat(), "value": float(value) if value is not None else None}
            for period_start, value in rows
        ],
        "forecast": await get_latest_forecast(session, client.id, metric_key),
    }


async def _metric_card(session: AsyncSession, client_id: int, metric: MetricCatalog) -> dict:
    latest = (
        await session.execute(
            select(MetricObservation).where(
                MetricObservation.client_id == client_id, MetricObservation.metric_key == metric.metric_key,
                MetricObservation.dimension_type == "site", MetricObservation.dimension_value == "__site__",
            ).order_by(MetricObservation.period_start.desc()).limit(1)
        )
    ).scalar_one_or_none()

    period_stats = {}
    for period_type in ("wow", "mom"):
        row = (
            await session.execute(
                select(MetricPeriodStats).where(
                    MetricPeriodStats.client_id == client_id, MetricPeriodStats.metric_key == metric.metric_key,
                    MetricPeriodStats.dimension_type == "site", MetricPeriodStats.dimension_value == "__site__",
                    MetricPeriodStats.period_type == period_type,
                ).order_by(MetricPeriodStats.period_end.desc()).limit(1)
            )
        ).scalar_one_or_none()
        if row:
            period_stats[period_type] = {
                "current_value": float(row.current_value) if row.current_value is not None else None,
                "prior_value": float(row.prior_value) if row.prior_value is not None else None,
                "pct_change": float(row.pct_change) if row.pct_change is not None else None,
            }

    recent_anomalies = (
        await session.execute(
            select(Anomaly).where(Anomaly.client_id == client_id, Anomaly.metric_key == metric.metric_key)
            .order_by(Anomaly.period_start.desc()).limit(5)
        )
    ).scalars().all()

    return {
        "metric_key": metric.metric_key, "display_name": metric.display_name, "unit": metric.unit,
        "visualization_type": metric.visualization_type, "icon": metric.icon,
        "latest_value": float(latest.value) if latest and latest.value is not None else None,
        "latest_date": latest.period_start.isoformat() if latest else None,
        "period_stats": period_stats,
        "anomalies": [
            {"date": a.period_start.isoformat(), "method": a.method, "direction": a.direction,
             "score": float(a.score) if a.score is not None else None}
            for a in recent_anomalies
        ],
        "forecast": await get_latest_forecast(session, client_id, metric.metric_key),
    }


async def get_latest_forecast(session: AsyncSession, client_id: int, metric_key: str) -> dict | None:
    forecast_run = (
        await session.execute(
            select(ForecastRun).where(
                ForecastRun.client_id == client_id, ForecastRun.metric_key == metric_key,
                ForecastRun.dimension_type == "site", ForecastRun.dimension_value == "__site__",
            ).order_by(ForecastRun.generated_at.desc()).limit(1)
        )
    ).scalar_one_or_none()
    if forecast_run is None:
        return None

    points = []
    if forecast_run.status == "ok":
        points = (
            await session.execute(
                select(ForecastPoint).where(ForecastPoint.forecast_run_id == forecast_run.id).order_by(ForecastPoint.target_period)
            )
        ).scalars().all()
    return {
        "status": forecast_run.status, "model": forecast_run.model,
        # horizon_periods/params/generated_at/confidence — added for the AI
        # Analyst Workspace's Statistical Analysis panel (Model Used/
        # Training Window/Forecast Horizon/Forecast Confidence), which reads
        # straight off this run rather than a separate call.
        "horizon_periods": forecast_run.horizon_periods, "params": forecast_run.params,
        "generated_at": forecast_run.generated_at.isoformat(),
        "confidence": float(forecast_run.confidence) if forecast_run.confidence is not None else None,
        "points": [
            {"target_date": p.target_period.isoformat(), "point_estimate": float(p.point_estimate),
             "lower_bound": float(p.lower_bound), "upper_bound": float(p.upper_bound)}
            for p in points
        ],
    }
