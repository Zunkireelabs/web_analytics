"""Insight Engine — pure logic over Statistics/Forecast/Anomaly Engine
output. Never calls an LLM, never invents a number: every insight's
`evidence` is copied straight from the anomaly/stats/forecast row that
triggered it. Re-running for the same (client, metric, dimension, period,
insight_type) replaces that insight (delete-then-insert, mirroring the
sibling Node app's own breakdown-table convention) rather than piling up
duplicates — recommendations cascade-delete with their insight and get
regenerated fresh."""
from datetime import date

from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import Anomaly, Client, Insight, MetricCatalog, MetricObservation, MetricPeriodStats
from app.db.session import SessionLocal

TREND_SHIFT_THRESHOLD_PCT = {"wow": 15.0, "mom": 20.0}
FORECAST_RISK_DECLINE_PCT = 10.0


async def run_insight_engine() -> None:
    async with SessionLocal() as session:
        clients = (await session.execute(select(Client).where(Client.status == "active"))).scalars().all()

    for client in clients:
        async with SessionLocal() as session:
            await _anomaly_insights(session, client.id)
            await _trend_shift_insights(session, client.id)
            await _forecast_risk_insights(session, client.id)
            await _milestone_insights(session, client.id)
            await session.commit()


async def _replace_insight(session: AsyncSession, *, client_id, metric_key, dimension_type, dimension_value,
                            period_start, insight_type, severity, evidence) -> None:
    await session.execute(
        delete(Insight).where(
            Insight.client_id == client_id, Insight.metric_key == metric_key,
            Insight.dimension_type == dimension_type, Insight.dimension_value == dimension_value,
            Insight.period_start == period_start, Insight.insight_type == insight_type,
        )
    )
    session.add(Insight(
        client_id=client_id, metric_key=metric_key, dimension_type=dimension_type, dimension_value=dimension_value,
        period_start=period_start, insight_type=insight_type, severity=severity, evidence=evidence,
    ))


async def _anomaly_insights(session: AsyncSession, client_id: int) -> None:
    today_anomalies = await _latest_anomalies(session, client_id)

    for a in today_anomalies:
        magnitude = abs(a.score) if a.score is not None else 0
        threshold = a.threshold_used or 1
        severity = "high" if magnitude > 2 * threshold else ("medium" if magnitude > threshold else "low")
        await _replace_insight(
            session, client_id=client_id, metric_key=a.metric_key, dimension_type=a.dimension_type,
            dimension_value=a.dimension_value, period_start=a.period_start, insight_type="anomaly",
            severity=severity,
            evidence={"method": a.method, "score": float(a.score) if a.score is not None else None,
                      "direction": a.direction, "value": float(a.value) if a.value is not None else None,
                      "threshold_used": float(a.threshold_used) if a.threshold_used is not None else None},
        )


async def _latest_anomalies(session: AsyncSession, client_id: int) -> list[Anomaly]:
    rows = (await session.execute(select(Anomaly).where(Anomaly.client_id == client_id))).scalars().all()
    if not rows:
        return []
    by_metric: dict[str, date] = {}
    for r in rows:
        if r.metric_key not in by_metric or r.period_start > by_metric[r.metric_key]:
            by_metric[r.metric_key] = r.period_start
    return [r for r in rows if r.period_start == by_metric[r.metric_key]]


async def _trend_shift_insights(session: AsyncSession, client_id: int) -> None:
    rows = (
        await session.execute(select(MetricPeriodStats).where(MetricPeriodStats.client_id == client_id))
    ).scalars().all()
    for r in rows:
        if r.pct_change is None:
            continue
        threshold = TREND_SHIFT_THRESHOLD_PCT.get(r.period_type)
        if threshold is None or abs(float(r.pct_change)) < threshold:
            continue
        magnitude = abs(float(r.pct_change))
        severity = "high" if magnitude > 2 * threshold else "medium"
        await _replace_insight(
            session, client_id=client_id, metric_key=r.metric_key, dimension_type=r.dimension_type,
            dimension_value=r.dimension_value, period_start=r.period_end, insight_type="trend_shift",
            severity=severity,
            evidence={"period_type": r.period_type,
                      "current_value": float(r.current_value) if r.current_value is not None else None,
                      "prior_value": float(r.prior_value) if r.prior_value is not None else None,
                      "pct_change": float(r.pct_change)},
        )


async def _forecast_risk_insights(session: AsyncSession, client_id: int) -> None:
    from app.db.models import ForecastPoint, ForecastRun

    runs = (
        await session.execute(
            select(ForecastRun).where(ForecastRun.client_id == client_id, ForecastRun.status == "ok")
        )
    ).scalars().all()
    latest_per_metric: dict[str, ForecastRun] = {}
    for run in runs:
        if run.metric_key not in latest_per_metric or run.generated_at > latest_per_metric[run.metric_key].generated_at:
            latest_per_metric[run.metric_key] = run

    for run in latest_per_metric.values():
        points = (
            await session.execute(
                select(ForecastPoint).where(ForecastPoint.forecast_run_id == run.id).order_by(ForecastPoint.target_period)
            )
        ).scalars().all()
        if not points:
            continue
        last_actual = await session.scalar(
            select(MetricObservation.value).where(
                MetricObservation.client_id == client_id, MetricObservation.metric_key == run.metric_key,
                MetricObservation.dimension_type == "site", MetricObservation.dimension_value == "__site__",
            ).order_by(MetricObservation.period_start.desc()).limit(1)
        )
        if last_actual is None or float(last_actual) == 0:
            continue
        last_point = float(points[-1].point_estimate)
        pct_projected_change = (last_point - float(last_actual)) / float(last_actual) * 100
        if pct_projected_change > -FORECAST_RISK_DECLINE_PCT:
            continue  # only flag projected DECLINES beyond the threshold
        severity = "high" if pct_projected_change < -2 * FORECAST_RISK_DECLINE_PCT else "medium"
        await _replace_insight(
            session, client_id=client_id, metric_key=run.metric_key, dimension_type="site", dimension_value="__site__",
            period_start=points[0].target_period, insight_type="forecast_risk", severity=severity,
            evidence={"model": run.model, "horizon_periods": run.horizon_periods,
                      "last_actual": float(last_actual), "projected_last_point": last_point,
                      "pct_projected_change": pct_projected_change},
        )


MILESTONE_BANDS = (25.0, 50.0, 75.0)


async def _milestone_insights(session: AsyncSession, client_id: int) -> None:
    score_metrics = (
        await session.execute(select(MetricCatalog).where(MetricCatalog.enabled.is_(True), MetricCatalog.unit == "score_0_100"))
    ).scalars().all()

    for metric in score_metrics:
        stats = (
            await session.execute(
                select(MetricPeriodStats).where(
                    MetricPeriodStats.client_id == client_id, MetricPeriodStats.metric_key == metric.metric_key,
                    MetricPeriodStats.period_type == "wow",
                )
            )
        ).scalar_one_or_none()
        if stats is None or stats.current_value is None or stats.prior_value is None:
            continue
        current, prior = float(stats.current_value), float(stats.prior_value)
        crossed = next((b for b in MILESTONE_BANDS if min(prior, current) < b <= max(prior, current)), None)
        if crossed is None:
            continue
        severity = "high" if crossed in (25.0, 75.0) else "medium"
        await _replace_insight(
            session, client_id=client_id, metric_key=metric.metric_key, dimension_type="site", dimension_value="__site__",
            period_start=stats.period_end, insight_type="milestone", severity=severity,
            evidence={"crossed_band": crossed, "current_value": current, "prior_value": prior,
                      "direction": "up" if current > prior else "down"},
        )
