"""Tool implementations. Every function is closed over a validated
client_id and an AsyncSession — client_id is never accepted as an argument
from the tool call itself. Reads ONLY the nightly cache tables (never MCP,
never live recomputation), per the locked decision that Q&A tolerates
~1-day staleness in exchange for zero on-demand load."""
from datetime import date, datetime

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.db.models import Anomaly, ForecastPoint, ForecastRun, Insight, MetricObservation, MetricPeriodStats, AnalystRecommendations


def _parse(d: str) -> date:
    return datetime.strptime(d, "%Y-%m-%d").date()


async def get_cached_metrics(session: AsyncSession, client_id: int, metric_key: str, start_date: str, end_date: str) -> dict:
    rows = (
        await session.execute(
            select(MetricObservation.period_start, MetricObservation.value).where(
                MetricObservation.client_id == client_id, MetricObservation.metric_key == metric_key,
                MetricObservation.dimension_type == "site", MetricObservation.dimension_value == "__site__",
                MetricObservation.period_start.between(_parse(start_date), _parse(end_date)),
            ).order_by(MetricObservation.period_start)
        )
    ).all()
    if not rows:
        return {"status": "insufficient-data", "points": []}
    return {
        "status": "ok",
        "points": [{"date": r.period_start.isoformat(), "value": float(r.value) if r.value is not None else None} for r in rows],
    }


async def compare_cached_periods(session: AsyncSession, client_id: int, metric_key: str, period_type: str,
                                  period_end: str | None = None) -> dict:
    query = select(MetricPeriodStats).where(
        MetricPeriodStats.client_id == client_id, MetricPeriodStats.metric_key == metric_key,
        MetricPeriodStats.dimension_type == "site", MetricPeriodStats.dimension_value == "__site__",
        MetricPeriodStats.period_type == period_type,
    )
    if period_end:
        query = query.where(MetricPeriodStats.period_end == _parse(period_end))
    else:
        query = query.order_by(MetricPeriodStats.period_end.desc())
    row = (await session.execute(query.limit(1))).scalar_one_or_none()
    if row is None:
        return {"status": "insufficient-data"}
    return {
        "status": "ok", "period_end": row.period_end.isoformat(),
        "current_value": float(row.current_value) if row.current_value is not None else None,
        "prior_value": float(row.prior_value) if row.prior_value is not None else None,
        "abs_change": float(row.abs_change) if row.abs_change is not None else None,
        "pct_change": float(row.pct_change) if row.pct_change is not None else None,
    }


async def get_cached_anomalies(session: AsyncSession, client_id: int, start_date: str, end_date: str,
                                metric_key: str | None = None, method: str | None = None) -> dict:
    query = select(Anomaly).where(
        Anomaly.client_id == client_id,
        Anomaly.period_start.between(_parse(start_date), _parse(end_date)),
    )
    if metric_key:
        query = query.where(Anomaly.metric_key == metric_key)
    if method:
        query = query.where(Anomaly.method == method)
    rows = (await session.execute(query.order_by(Anomaly.period_start.desc()))).scalars().all()
    return {
        "status": "ok" if rows else "insufficient-data",
        "anomalies": [
            {"metric_key": r.metric_key, "date": r.period_start.isoformat(),
             "value": float(r.value) if r.value is not None else None, "method": r.method,
             "score": float(r.score) if r.score is not None else None, "direction": r.direction}
            for r in rows
        ],
    }


async def get_cached_forecast(session: AsyncSession, client_id: int, metric_key: str, horizon_days: int | None = None) -> dict:
    run = (
        await session.execute(
            select(ForecastRun).where(
                ForecastRun.client_id == client_id, ForecastRun.metric_key == metric_key,
                ForecastRun.dimension_type == "site", ForecastRun.dimension_value == "__site__",
            ).order_by(ForecastRun.generated_at.desc()).limit(1)
        )
    ).scalar_one_or_none()
    if run is None:
        return {"status": "insufficient-data", "points": []}
    if run.status != "ok":
        return {"status": run.status, "model": run.model, "points": []}

    points = (
        await session.execute(
            select(ForecastPoint).where(ForecastPoint.forecast_run_id == run.id).order_by(ForecastPoint.target_period)
        )
    ).scalars().all()
    if horizon_days:
        points = points[:horizon_days]
    return {
        "status": "ok", "model": run.model, "generated_at": run.generated_at.isoformat(),
        "points": [
            {"target_date": p.target_period.isoformat(), "point_estimate": float(p.point_estimate),
             "lower_bound": float(p.lower_bound), "upper_bound": float(p.upper_bound)}
            for p in points
        ],
    }


async def get_cached_insights(session: AsyncSession, client_id: int, metric_key: str | None = None,
                               severity: str | None = None) -> dict:
    query = select(Insight).where(Insight.client_id == client_id)
    if metric_key:
        query = query.where(Insight.metric_key == metric_key)
    if severity:
        query = query.where(Insight.severity == severity)
    insights = (await session.execute(query.order_by(Insight.generated_at.desc()))).scalars().all()

    results = []
    for insight in insights:
        rec = (
            await session.execute(select(AnalystRecommendations).where(AnalystRecommendations.insight_id == insight.id))
        ).scalar_one_or_none()
        results.append({
            "metric_key": insight.metric_key, "insight_type": insight.insight_type, "severity": insight.severity,
            "period_start": insight.period_start.isoformat(), "evidence": insight.evidence,
            "recommendation": rec.recommendation_text if rec else None,
        })
    return {"status": "ok" if results else "insufficient-data", "insights": results}


HANDLERS = {
    "get_cached_metrics": get_cached_metrics,
    "compare_cached_periods": compare_cached_periods,
    "get_cached_anomalies": get_cached_anomalies,
    "get_cached_forecast": get_cached_forecast,
    "get_cached_insights": get_cached_insights,
}
