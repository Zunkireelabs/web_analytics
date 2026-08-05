"""Recommendation Engine — a static template (recommendation_text) always
computed first, mirroring the sibling Node app's own
server/agents/lib/recommendations.js discipline: a recommendation always
points back to real evidence, never a free-floating suggestion. Layered on
top, a nightly LLM enrichment pass asks the LLM to tailor that into a
root_cause_text + a sharper recommendation_text, grounded strictly in the
same evidence — never in the request path, so GET /dashboard/{client_id}
stays cache-only. Any LLM failure (rate limit, malformed response) falls
back to the static template alone; one client's one bad call never blocks
the nightly run for anyone else. Every attempt is logged and recorded via
Recommendation.narration_status so a failure is visible and retried on a
later nightly run, instead of a Recommendation row's mere existence being
treated as "already tried, forever"."""
import json
import logging
from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.agent.narrator import call_llm
from app.api.routes.dashboard import get_latest_forecast
from app.db.models import Client, Insight, MetricCatalog, AnalystRecommendations, RootCauseAnalysisNode, RootCauseAnalysisRun
from app.db.session import SessionLocal
from app.scoring.impact_projection import project_impact

logger = logging.getLogger(__name__)

SEVERITY_TO_PRIORITY = {"high": "high", "medium": "medium", "low": "low"}
SEVERITY_RANK = {"high": 0, "medium": 1, "low": 2}
# Metrics where a NUMERICALLY LOWER value is the better outcome (rank 1 beats
# rank 10) — direction-of-change heuristics elsewhere in this file assume
# "value went down" == "declined"; this is the one metric family where
# that's backwards.
LOWER_IS_BETTER_METRICS = {"gsc_position"}

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
            existing_by_insight = {
                r.insight_id: r for r in
                (await session.execute(select(AnalystRecommendations).where(AnalystRecommendations.client_id == client.id))).scalars().all()
            }

            for insight in insights:
                existing = existing_by_insight.get(insight.id)
                if existing is not None:
                    # Only retry rows where LLM tailoring hasn't succeeded
                    # yet, and never touch one staff already acted on — a
                    # retry that improves root_cause_text/recommendation_text
                    # after the fact would be surprising on a closed-out item.
                    if existing.narration_status == "ok" or existing.status in ("resolved", "dismissed"):
                        continue
                    metric = catalog_by_key.get(insight.metric_key)
                    root_cause, tailored_recommendation, error = await _generate_llm(insight, metric)
                    if tailored_recommendation:
                        existing.recommendation_text = tailored_recommendation
                    if root_cause:
                        existing.root_cause_text = root_cause
                    existing.narration_status = "ok" if root_cause else "failed"
                    existing.narration_error = error
                    existing.narration_attempted_at = datetime.now(timezone.utc)
                    continue

                metric = catalog_by_key.get(insight.metric_key)
                text = _render(insight, metric)
                if text is None:
                    continue
                root_cause, tailored_recommendation, error = await _generate_llm(insight, metric)
                session.add(AnalystRecommendations(
                    client_id=client.id, insight_id=insight.id,
                    priority=SEVERITY_TO_PRIORITY.get(insight.severity, "low"),
                    recommendation_text=tailored_recommendation or text,
                    root_cause_text=root_cause,
                    narration_status="ok" if root_cause else "failed",
                    narration_error=error,
                    narration_attempted_at=datetime.now(timezone.utc),
                ))
            await session.commit()


async def _generate_llm(insight: Insight, metric: MetricCatalog | None) -> tuple[str | None, str | None, str | None]:
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
    except Exception as e:  # noqa: BLE001 — deliberately broad: must never block the nightly run
        logger.warning("recommendations: LLM enrichment failed for insight %s: %s", insight.id, e)
        return None, None, f"{type(e).__name__}: {e}"

    for block in response.content:
        if block.type == "tool_use" and block.name == "submit_explanation":
            return block.input.get("root_cause"), block.input.get("recommendation"), None

    logger.warning("recommendations: LLM did not call submit_explanation for insight %s", insight.id)
    return None, None, "model did not call submit_explanation"


EXECUTIVE_SUMMARY_SYSTEM_PROMPT = (
    "You are writing a short executive summary of one already-diagnosed finding for internal agency staff to "
    "paste directly into a Slack message or email to a non-technical stakeholder who hasn't seen the "
    "dashboard. You are given the metric, the type of change, its evidence, and the already-computed root "
    "cause and recommendation — synthesize those into 2-4 plain-English sentences of prose (no bullet points, "
    "no headers, no markdown). Never invent a fact, cause, or number beyond what's given; if the root cause or "
    "recommendation is missing, say plainly that the investigation is still in progress rather than guessing."
)

EXECUTIVE_SUMMARY_TOOL = {
    "name": "submit_summary",
    "description": "Submit the executive summary paragraph for this finding.",
    "input_schema": {
        "type": "object",
        "properties": {
            "summary": {
                "type": "string",
                "description": "2-4 plain-English sentences synthesizing the finding for a non-technical stakeholder.",
            },
        },
        "required": ["summary"],
    },
}


async def generate_executive_summary(
    insight: Insight, metric: MetricCatalog | None, recommendation: AnalystRecommendations,
) -> str:
    """On-demand (not part of the nightly run) — unlike _generate_llm above,
    a failure here must surface to the caller rather than being swallowed,
    since there's no static fallback text for "the stakeholder summary"."""
    payload = {
        "metric": metric.display_name if metric else insight.metric_key,
        "insight_type": insight.insight_type, "severity": insight.severity,
        "period_start": insight.period_start.isoformat(), "evidence": insight.evidence,
        "root_cause": recommendation.root_cause_text, "recommendation": recommendation.recommendation_text,
    }
    response = await call_llm(
        messages=[{"role": "user", "content": json.dumps(payload)}],
        tools=[EXECUTIVE_SUMMARY_TOOL], tool_choice={"type": "tool", "name": "submit_summary"},
        system=EXECUTIVE_SUMMARY_SYSTEM_PROMPT,
    )
    for block in response.content:
        if block.type == "tool_use" and block.name == "submit_summary":
            summary = block.input.get("summary")
            if summary:
                return summary
    raise ValueError("Model did not return a summary.")


HERO_SUMMARY_SYSTEM_PROMPT = (
    "You are writing the single hero narrative for an AI analytics dashboard's executive summary panel, read by "
    "internal agency staff at a glance. You are given the single highest-priority active finding for this client: "
    "its metric, evidence, forecast (if any), root_cause_text and root_cause_analysis (if computed), confidence "
    "score (if computed), projected business impact (in dollars if the client has configured business values, "
    "otherwise as a raw metric-unit delta like sessions — check the 'mode' field to tell which), and "
    "recommendation. Call submit_hero_summary with the fields described. Ground every sentence strictly in the "
    "given fields — if a field is null or absent from the input, say plainly that it isn't available yet (e.g. "
    "'root cause analysis hasn't run for this yet') rather than omitting the caveat or inventing a plausible-"
    "sounding value. Never invent a number, cause, or forecast that isn't present in the input.\n\n"
    "IMPORTANT — do not conflate 'inconclusive' with 'not computed': if root_cause_text or root_cause_analysis "
    "IS present (non-null) in the input, the analysis DID run — report what it actually found, even when that "
    "finding is itself a hedge like 'no clear driver in the available data yet'. That is a real, honest result "
    "to relay verbatim or near-verbatim, not the same thing as the analysis never having run. Only say 'hasn't "
    "run yet' when the corresponding field is genuinely null/missing from the input you were given."
)

HERO_SUMMARY_TOOL = {
    "name": "submit_hero_summary",
    "description": "Submit the executive summary hero fields for the dashboard.",
    "input_schema": {
        "type": "object",
        "properties": {
            "overall_status": {
                "type": "string",
                "description": (
                    "One short phrase (2-4 words) capturing this client's overall state right now, worded "
                    "specifically to what's actually happening in the given evidence — don't default to a "
                    "stock phrase like 'Needs attention' unless nothing more specific fits."
                ),
            },
            "biggest_issue": {"type": "string", "description": "One sentence naming the single biggest issue, grounded in the given metric/evidence."},
            "forecast_summary": {"type": "string", "description": "One sentence on the forecast, or state plainly if none is available."},
            "root_cause_summary": {
                "type": "string",
                "description": (
                    "One sentence relaying what root_cause_text/root_cause_analysis actually found — including "
                    "an inconclusive finding like 'no clear driver identified', which is a real result, not the "
                    "same as unavailable. State plainly only if those fields are genuinely null/absent."
                ),
            },
            "business_impact_summary": {"type": "string", "description": "One sentence on projected business impact, or state plainly if not computable."},
            "recommended_action": {"type": "string", "description": "One sentence: the concrete next action, or state plainly if none exists yet."},
        },
        "required": [
            "overall_status", "biggest_issue", "forecast_summary",
            "root_cause_summary", "business_impact_summary", "recommended_action",
        ],
    },
}


async def generate_dashboard_executive_summary(session: AsyncSession, *, client_id: int) -> dict:
    """The dashboard-level hero summary (distinct from generate_executive_
    summary above, which is per-recommendation) — on-demand, stateless,
    never persisted, kept out of the cache-only GET /dashboard/{client_id}
    path (see that route's own docstring: it must stay LLM-free)."""
    insights = (
        await session.execute(select(Insight).where(Insight.client_id == client_id).order_by(Insight.generated_at.desc()))
    ).scalars().all()
    catalog_by_key = {m.metric_key: m for m in (await session.execute(select(MetricCatalog))).scalars().all()}

    chosen, chosen_rec = None, None
    for insight in sorted(insights, key=lambda i: SEVERITY_RANK.get(i.severity, 3)):
        rec = (await session.execute(select(AnalystRecommendations).where(AnalystRecommendations.insight_id == insight.id))).scalar_one_or_none()
        if rec is not None and rec.status in ("resolved", "dismissed"):
            continue  # staff already marked this occurrence solved or not worth acting on — same filter as get_dashboard
        chosen, chosen_rec = insight, rec
        break

    if chosen is None:
        return {"status": "no-active-insights", "summary": None}

    metric = catalog_by_key.get(chosen.metric_key)
    forecast = await get_latest_forecast(session, client_id, chosen.metric_key)

    root_cause_payload = None
    rca_run = (
        await session.execute(
            select(RootCauseAnalysisRun).where(
                RootCauseAnalysisRun.client_id == client_id, RootCauseAnalysisRun.insight_id == chosen.id,
            ).order_by(RootCauseAnalysisRun.generated_at.desc()).limit(1)
        )
    ).scalar_one_or_none()
    if rca_run is not None and rca_run.status == "ok":
        nodes = (
            await session.execute(
                select(RootCauseAnalysisNode).where(
                    RootCauseAnalysisNode.run_id == rca_run.id, RootCauseAnalysisNode.parent_node_id.is_not(None),
                )
            )
        ).scalars().all()
        root_cause_payload = {
            "confidence": float(rca_run.confidence) if rca_run.confidence is not None else None,
            "top_movers": [
                {
                    "dimension_type": n.dimension_type, "dimension_value": n.dimension_value,
                    "share_of_baseline_change_pct": float(n.share_of_baseline_change_pct) if n.share_of_baseline_change_pct is not None else None,
                }
                for n in sorted(nodes, key=lambda n: abs(n.share_of_baseline_change_pct or 0), reverse=True)[:3]
            ],
        }

    impact_payload = None
    delta = impact_inputs_from_insight(chosen)
    if delta is not None:
        run = await project_impact(
            session, client_id=client_id, metric_key=chosen.metric_key,
            dimension_type=chosen.dimension_type, dimension_value=chosen.dimension_value,
            delta_value=delta["delta_value"], delta_direction=delta["delta_direction"],
            current_value=delta.get("current_value"), prior_value=delta.get("prior_value"),
        )
        await session.commit()
        if run.status == "ok" and run.mode == "currency":
            impact_payload = {
                "mode": "currency", "projected_dollar_delta": float(run.projected_dollar_delta), "currency": run.currency,
                "confidence": float(run.confidence) if run.confidence is not None else None,
            }
        elif run.status == "ok" and run.mode == "metric_unit":
            impact_payload = {
                "mode": "metric_unit", "projected_metric_unit_delta": float(run.projected_metric_unit_delta), "metric_unit": run.metric_unit,
                "confidence": float(run.confidence) if run.confidence is not None else None,
            }
        else:
            impact_payload = {"status": run.status}

    payload = {
        "metric": metric.display_name if metric else chosen.metric_key,
        "insight_type": chosen.insight_type, "severity": chosen.severity,
        "period_start": chosen.period_start.isoformat(), "evidence": chosen.evidence,
        "root_cause_text": chosen_rec.root_cause_text if chosen_rec else None,
        "recommendation_text": chosen_rec.recommendation_text if chosen_rec else None,
        "forecast": forecast, "root_cause_analysis": root_cause_payload, "business_impact": impact_payload,
    }

    response = await call_llm(
        messages=[{"role": "user", "content": json.dumps(payload, default=str)}],
        tools=[HERO_SUMMARY_TOOL], tool_choice={"type": "tool", "name": "submit_hero_summary"},
        system=HERO_SUMMARY_SYSTEM_PROMPT,
    )
    for block in response.content:
        if block.type == "tool_use" and block.name == "submit_hero_summary":
            return {"status": "ok", "metric": payload["metric"], "severity": chosen.severity, **block.input}
    raise ValueError("Model did not return a hero summary.")


def impact_inputs_from_insight(insight: Insight) -> dict | None:
    """Best-effort delta extraction per insight_type's own evidence shape —
    returns None (impact simply omitted from the hero payload) rather than
    guessing when the evidence doesn't carry a clear before/after pair.
    Anomaly insights have no baseline of their own (a single-day flag, not a
    period comparison) so they're always skipped here. Public (no leading
    underscore) — also reused by app/intelligence/opportunity_scoring.py to
    compute an 'impact' factor for every recommendation nightly, not just
    the single highest-priority insight this module's own hero summary
    looks at on demand."""
    e = insight.evidence
    if insight.insight_type == "trend_shift":
        current, prior = e.get("current_value"), e.get("prior_value")
        if current is None or prior is None:
            return None
        worsened = (current - prior) > 0 if insight.metric_key in LOWER_IS_BETTER_METRICS else (current - prior) < 0
        return {"delta_value": current - prior, "delta_direction": "decline" if worsened else "increase", "current_value": current, "prior_value": prior}
    if insight.insight_type == "forecast_risk":
        last_actual, projected = e.get("last_actual"), e.get("projected_last_point")
        if last_actual is None or projected is None:
            return None
        return {"delta_value": projected - last_actual, "delta_direction": "decline", "current_value": projected, "prior_value": last_actual}
    if insight.insight_type == "milestone":
        current, prior = e.get("current_value"), e.get("prior_value")
        if current is None or prior is None:
            return None
        return {"delta_value": current - prior, "delta_direction": "decline" if e.get("direction") == "down" else "increase", "current_value": current, "prior_value": prior}
    return None


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
