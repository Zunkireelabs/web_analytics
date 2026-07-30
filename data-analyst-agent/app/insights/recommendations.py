"""Recommendation Engine — templated text keyed to a specific insight_id,
never LLM-generated. Mirrors the sibling Node app's own
server/agents/lib/recommendations.js discipline: a recommendation always
points back to real evidence, never a free-floating suggestion."""
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import Client, Insight, MetricCatalog, Recommendation
from app.db.session import SessionLocal

SEVERITY_TO_PRIORITY = {"high": "high", "medium": "medium", "low": "low"}


async def run_recommendation_engine() -> None:
    async with SessionLocal() as session:
        clients = (await session.execute(select(Client).where(Client.status == "active"))).scalars().all()

    for client in clients:
        async with SessionLocal() as session:
            insights = (
                await session.execute(select(Insight).where(Insight.client_id == client.id))
            ).scalars().all()
            catalog_by_key = {
                m.metric_key: m for m in
                (await session.execute(select(MetricCatalog))).scalars().all()
            }
            existing_insight_ids = {
                r[0] for r in (await session.execute(select(Recommendation.insight_id).where(Recommendation.client_id == client.id))).all()
            }

            for insight in insights:
                if insight.id in existing_insight_ids:
                    continue  # already has a recommendation from a prior run — insight rows are replaced, not this
                metric = catalog_by_key.get(insight.metric_key)
                text = _render(insight, metric)
                if text is None:
                    continue
                session.add(Recommendation(
                    client_id=client.id, insight_id=insight.id,
                    priority=SEVERITY_TO_PRIORITY.get(insight.severity, "low"),
                    recommendation_text=text,
                ))
            await session.commit()


def _render(insight: Insight, metric: MetricCatalog | None) -> str | None:
    name = metric.display_name if metric else insight.metric_key
    e = insight.evidence

    if insight.insight_type == "anomaly":
        return (
            f"{name} showed an unusual {e.get('direction')} value on {insight.period_start} "
            f"({e.get('method')} score {e.get('score'):.2f} vs threshold {e.get('threshold_used')}). "
            f"Check for a data issue or a real event around that date."
        )
    if insight.insight_type == "trend_shift":
        direction = "up" if (e.get("pct_change") or 0) > 0 else "down"
        return (
            f"{name} moved {direction} {abs(e.get('pct_change', 0)):.1f}% "
            f"{'week-over-week' if e.get('period_type') == 'wow' else 'month-over-month'} "
            f"(from {e.get('prior_value')} to {e.get('current_value')}). Review what changed around this metric."
        )
    if insight.insight_type == "forecast_risk":
        return (
            f"{name} is forecast to decline {abs(e.get('pct_projected_change', 0)):.1f}% over the next "
            f"{e.get('horizon_periods')} days if the current trend continues. Consider proactive action."
        )
    if insight.insight_type == "milestone":
        return (
            f"{name} crossed the {e.get('crossed_band')} threshold, moving {e.get('direction')} "
            f"(from {e.get('prior_value')} to {e.get('current_value')})."
        )
    return None
