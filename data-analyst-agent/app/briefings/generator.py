"""Executive Briefings (Phase 3 Step 10) — morning/weekly/monthly rollups
of already-computed nightly data into one persisted row per cadence run.
No new computation: wins/risks come from Investigation status/severity,
forecast summary from existing forecast_risk insights, recommendations
summary from RecommendationRanking, opportunity_score from Opportunity,
website health from the ingested 'health_score' metric (see
app/collectors/health_score.py), trend summary from trend_shift insights.

narrative is an optional, best-effort LLM synthesis of the above — reuses
the same call_llm plumbing as app/investigations/reasoning.py, and the
same discipline: never blocks the structured fields on failure, null is a
legitimate outcome, not an error."""
import json
from datetime import date, datetime, timedelta, timezone

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.agent.narrator import call_llm
from app.db.models import (
    Client, ExecutiveBriefing, Insight, Investigation, MetricObservation, Opportunity, RecommendationRanking,
)
from app.db.session import SessionLocal

CADENCE_WINDOW_DAYS = {"morning": 1, "weekly": 7, "monthly": 30}
TOP_N = 5

NARRATIVE_SYSTEM_PROMPT = (
    "You are writing a one-paragraph narrative for an executive briefing, given already-computed structured "
    "data: biggest wins, biggest risks, forecast summary, top recommendations, opportunity score, website "
    "health score, and trend summary. Call submit_narrative with 2-4 plain-English sentences synthesizing "
    "these into a briefing an executive can read in 10 seconds. Never invent a fact or number beyond what's "
    "given; if a section is empty, say plainly that there's nothing notable there rather than inventing one."
)

NARRATIVE_TOOL = {
    "name": "submit_narrative",
    "description": "Submit the executive briefing narrative.",
    "input_schema": {
        "type": "object",
        "properties": {"narrative": {"type": "string", "description": "2-4 plain-English sentences."}},
        "required": ["narrative"],
    },
}


async def _generate(client_id: int, cadence: str) -> None:
    window_days = CADENCE_WINDOW_DAYS[cadence]
    period_end = date.today()
    period_start = period_end - timedelta(days=window_days - 1)
    period_start_dt = datetime.combine(period_start, datetime.min.time(), tzinfo=timezone.utc)

    async with SessionLocal() as session:
        wins = (
            await session.execute(
                select(Investigation).where(
                    Investigation.client_id == client_id, Investigation.status == "completed",
                    Investigation.updated_at >= period_start_dt,
                ).order_by(Investigation.updated_at.desc()).limit(TOP_N)
            )
        ).scalars().all()

        risks = (
            await session.execute(
                select(Investigation).where(
                    Investigation.client_id == client_id, Investigation.severity == "high",
                    Investigation.status.notin_(("completed", "archived")),
                ).order_by(Investigation.updated_at.desc()).limit(TOP_N)
            )
        ).scalars().all()

        forecast_risks = (
            await session.execute(
                select(Insight).where(Insight.client_id == client_id, Insight.insight_type == "forecast_risk")
                .order_by(Insight.generated_at.desc()).limit(TOP_N)
            )
        ).scalars().all()

        trend_shifts = (
            await session.execute(
                select(Insight).where(
                    Insight.client_id == client_id, Insight.insight_type == "trend_shift",
                    Insight.period_start >= period_start,
                ).order_by(Insight.generated_at.desc()).limit(TOP_N)
            )
        ).scalars().all()

        rankings = (
            await session.execute(
                select(RecommendationRanking).where(
                    RecommendationRanking.client_id == client_id, RecommendationRanking.status == "ok",
                ).order_by(RecommendationRanking.rank).limit(TOP_N)
            )
        ).scalars().all()

        opportunities = (
            await session.execute(
                select(Opportunity).where(Opportunity.client_id == client_id, Opportunity.status == "open")
            )
        ).scalars().all()
        opp_scores = [float(o.opportunity_score) for o in opportunities if o.opportunity_score is not None]
        opportunity_score = max(opp_scores) if opp_scores else None

        health_value = await session.scalar(
            select(MetricObservation.value).where(
                MetricObservation.client_id == client_id, MetricObservation.metric_key == "health_score",
                MetricObservation.dimension_type == "site", MetricObservation.dimension_value == "__site__",
            ).order_by(MetricObservation.period_start.desc()).limit(1)
        )

        biggest_wins = [
            {"investigation_id": i.id, "metric_key": i.metric_key, "summary": i.summary} for i in wins
        ]
        biggest_risks = [
            {
                "investigation_id": i.id, "metric_key": i.metric_key, "summary": i.summary,
                "confidence": float(i.confidence) if i.confidence is not None else None,
            }
            for i in risks
        ]
        forecast_summary = [{"metric_key": i.metric_key, "evidence": i.evidence} for i in forecast_risks]
        recommendations_summary = [
            {
                "recommendation_id": r.recommendation_id, "rank": r.rank,
                "priority_score": float(r.priority_score) if r.priority_score is not None else None,
            }
            for r in rankings
        ]
        trend_summary = [{"metric_key": i.metric_key, "evidence": i.evidence} for i in trend_shifts]
        website_health_score = float(health_value) if health_value is not None else None

        narrative = None
        try:
            payload = {
                "biggest_wins": biggest_wins, "biggest_risks": biggest_risks, "forecast_summary": forecast_summary,
                "recommendations_summary": recommendations_summary, "opportunity_score": opportunity_score,
                "website_health_score": website_health_score, "trend_summary": trend_summary,
            }
            response = await call_llm(
                messages=[{"role": "user", "content": json.dumps(payload, default=str)}],
                tools=[NARRATIVE_TOOL], tool_choice={"type": "tool", "name": "submit_narrative"},
                system=NARRATIVE_SYSTEM_PROMPT,
            )
            for block in response.content:
                if block.type == "tool_use" and block.name == "submit_narrative":
                    narrative = block.input.get("narrative")
                    break
        except Exception:
            pass  # structured fields below still persist — see module docstring

        session.add(ExecutiveBriefing(
            client_id=client_id, cadence=cadence, period_start=period_start, period_end=period_end,
            biggest_wins=biggest_wins, biggest_risks=biggest_risks, forecast_summary=forecast_summary,
            recommendations_summary=recommendations_summary, opportunity_score=opportunity_score,
            website_health_score=website_health_score, trend_summary=trend_summary, narrative=narrative,
        ))
        await session.commit()


async def _generate_for_all_clients(cadence: str) -> None:
    async with SessionLocal() as session:
        clients = (await session.execute(select(Client).where(Client.status == "active"))).scalars().all()
    for client in clients:
        await _generate(client.id, cadence)


async def generate_morning_briefing() -> None:
    await _generate_for_all_clients("morning")


async def generate_weekly_briefing() -> None:
    await _generate_for_all_clients("weekly")


async def generate_monthly_briefing() -> None:
    await _generate_for_all_clients("monthly")
