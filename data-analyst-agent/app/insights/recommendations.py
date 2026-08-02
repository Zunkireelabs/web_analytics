"""Recommendation Engine — a static template (recommendation_text) always
computed first, mirroring the sibling Node app's own
server/agents/lib/recommendations.js discipline: a recommendation always
points back to real evidence, never a free-floating suggestion. Layered on
top, a nightly LLM enrichment pass asks the LLM to tailor that into a
root_cause_text + a sharper recommendation_text, grounded strictly in the
same evidence — never in the request path, so GET /dashboard/{client_id}
stays cache-only. Any LLM failure (rate limit, malformed response) falls
back to the static template alone; one client's one bad call never blocks
the nightly run for anyone else."""
import json

from sqlalchemy import select

from app.agent.narrator import call_llm
from app.db.models import Client, Insight, MetricCatalog, Recommendation
from app.db.session import SessionLocal

SEVERITY_TO_PRIORITY = {"high": "high", "medium": "medium", "low": "low"}

EXPLANATION_SYSTEM_PROMPT = (
    "You are a data analyst writing a short explanation of a flagged SEO/growth metric change for internal "
    "agency staff. You are given one structured insight — the metric, the type of change, and whatever "
    "evidence was computed for it (which may include which dimension, e.g. device or query, drove the "
    "change). Call submit_explanation with exactly two one-sentence fields. Ground every claim strictly in "
    "the evidence given — never invent a cause, a number, or a dimension that isn't present in the input. If "
    "the evidence doesn't point to a clear cause, say so plainly (e.g. 'no clear driver in the available "
    "data yet') rather than guessing."
)

EXPLANATION_TOOL = {
    "name": "submit_explanation",
    "description": "Submit the root cause and recommended fix for this insight.",
    "input_schema": {
        "type": "object",
        "properties": {
            "root_cause": {
                "type": "string",
                "description": "One sentence: why this likely happened, grounded only in the given evidence.",
            },
            "recommendation": {
                "type": "string",
                "description": "One sentence: the concrete next action staff should take.",
            },
        },
        "required": ["root_cause", "recommendation"],
    },
}


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
                root_cause, tailored_recommendation = await _generate_llm(insight, metric)
                session.add(Recommendation(
                    client_id=client.id, insight_id=insight.id,
                    priority=SEVERITY_TO_PRIORITY.get(insight.severity, "low"),
                    recommendation_text=tailored_recommendation or text,
                    root_cause_text=root_cause,
                ))
            await session.commit()


async def _generate_llm(insight: Insight, metric: MetricCatalog | None) -> tuple[str | None, str | None]:
    payload = {
        "metric": metric.display_name if metric else insight.metric_key,
        "insight_type": insight.insight_type, "severity": insight.severity,
        "period_start": insight.period_start.isoformat(), "evidence": insight.evidence,
    }
    try:
        response = await call_llm(
            messages=[{"role": "user", "content": json.dumps(payload)}],
            tools=[EXPLANATION_TOOL], tool_choice={"type": "tool", "name": "submit_explanation"},
            system=EXPLANATION_SYSTEM_PROMPT,
        )
    except Exception:  # noqa: BLE001 — deliberately broad: must never block the nightly run
        return None, None

    for block in response.content:
        if block.type == "tool_use" and block.name == "submit_explanation":
            return block.input.get("root_cause"), block.input.get("recommendation")
    return None, None


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
