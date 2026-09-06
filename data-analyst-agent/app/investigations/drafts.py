"""Automatic Draft Triggering (Phase 3 Step 7) — for each Investigation
that just reached 'recommendation_generated', calls the existing,
unmodified generate_draft MCP tool (see app/mcp_client/tools.py) instead
of waiting for a staff click on the manual "Generate Content Draft"
button. Never publishes anything itself — generate_draft only ever
produces a draft row; approving/publishing still goes through the
existing Action Center human-review flow untouched.

Eligibility mirrors server/agents/lib/analyst-seo-mapping.js::
seoDraftEligibility exactly (metric_key starting with 'gsc_', dimension_
type 'page', a real decline), with one narrowing: that function falls
back to prefixing the site's own domain onto a bare path, which needs the
Node app's sites table this service has no access to. Here, only a
dimension_value that's ALREADY an absolute URL (GSC's documented normal
behavior, per that module's own comment) is eligible — anything else is
simply left un-triggered rather than guessed at.

PRIORITY GATE (added after the code-grounded architecture audit found
this trigger fired on raw eligibility alone, never consulting the
Analyst's own opportunity/priority/effort/impact intelligence — see
app/intelligence/opportunity_scoring.py, effort_estimation.py,
impact_prediction.py, prioritizer.py). Rather than re-deriving a second
scoring formula here, this reuses RecommendationRanking.priority_score
as-is: it is ALREADY the engine's single cross-recommendation-comparable
"is this worth doing now" number — (opportunity_score / 100) * confidence
/ effort_level (see app/intelligence/prioritizer.py's own docstring) — so
gating on it, rather than inventing a new combination of the four
factors, is the smallest change that actually wires the existing
intelligence into the decision.

No priority_score threshold constant exists anywhere else in this
codebase to reuse, so MIN_PRIORITY_SCORE_TO_TRIGGER below is a new,
deliberately conservative constant, documented at its definition. A
missing/insufficient-data/malformed RecommendationRanking row is treated
exactly like a below-threshold score — i.e. FAIL CLOSED, no draft — never
as "no opinion, fire anyway": a fully-connected decision layer is only
meaningful if the absence of evidence can't be laundered into an
autonomous action.

ImpactPrediction IS STILL NOT A GATE (revised after product review — a
first version of this trigger briefly added an independent
expected_impact_magnitude >= 'medium' go/no-go check alongside the
priority gate; removed). Priority is the ONE action-selection mechanism:
RecommendationRanking.priority_score already blends opportunity,
confidence, and effort into a single ranking number, and adding a second,
independent gate on top of it — rather than as an input INTO it — would
have meant two separate committees each with veto power over the same
decision, which is not how this system's priority architecture works
anywhere else. ImpactPrediction (see app/intelligence/impact_prediction.py
— a per-fix-category EXPECTATION of how long a fix takes to show effect
and how large that effect is likely to be, NOT the dollar/business-impact
figure computed by app/scoring/impact_projection.py, which is already
folded into OpportunityScore's own 'impact' factor and therefore already
inside priority_score) is still computed and persisted on demand here
(_ensure_impact_prediction, kept from that revision) purely because
app/api/routes/intelligence.py already serves it per-recommendation for
staff reporting — populating it early is a genuine, if secondary, benefit
of the same on-demand mechanism the priority gate needs anyway. Its value
never blocks, delays, or reorders a draft decision.

DEPENDENCY RESOLUTION (audit issue 2): opportunity scoring, effort
estimation, impact prediction, and the prioritizer only run in
scripts/run_nightly_pipeline.py, never in the in-process-scheduled
run_analysis_pass() this trigger lives in (see app/analysis/run_pass.py's
own docstring) — and because app/insights/recommendations.py creates a
fresh Recommendation per fresh Insight, the freshest Recommendation behind
a still-recurring decline is, structurally, always the one the nightly
pipeline hasn't scored yet: a purely passive "retry tomorrow night" never
actually catches up. Rather than build a second scheduler, the priority
gate below calls the EXISTING per-recommendation engine functions
(effort_estimation._estimate, opportunity_scoring._score,
impact_prediction._predict — already extracted, one-recommendation-at-a-
time functions, not new code) directly, on demand, the first time a
specific recommendation needs a decision — but only if no persisted row
already exists (never recomputing/duplicating one the nightly pipeline, or
an earlier on-demand call, already wrote). This makes today's eligible
opportunity decidable the same run it's detected, while leaving the
nightly pipeline as the system of record for every client's full batch
(rollup, cross-recommendation ranking, briefings, alerts — still
unaffected and unduplicated by this).

Requires the client's MCP token to hold at least 'ai_actions' permission,
same as app/alerts/deliver.py — a 'read_only'-tier client is skipped, not
an error, since that's a provisioning fact this code can't fix."""
import logging
import re
from dataclasses import dataclass

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import (
    AnalystRecommendations, Client, EffortEstimation, ImpactPrediction, Insight, Investigation,
    InvestigationEvent, OpportunityScore, RecommendationRanking,
)
from app.db.session import SessionLocal
from app.intelligence import effort_estimation as effort_estimation_engine
from app.intelligence import impact_prediction as impact_prediction_engine
from app.intelligence import opportunity_scoring as opportunity_scoring_engine
from app.intelligence import prioritizer as prioritizer_engine
from app.mcp_client.client import McpAuthError, McpClient, McpToolError
from app.mcp_client.tools import generate_draft

logger = logging.getLogger(__name__)

_ABSOLUTE_URL_RE = re.compile(r"^https?://", re.IGNORECASE)

# See the PRIORITY GATE note above. priority_score = (opportunity_score /
# 100) * confidence / effort_level — for a 'content'-category fix (base
# effort_level 3, see app/intelligence/category_rules.py), this requires
# roughly at least a medium opportunity_score (~50-60/100) AND at least
# moderate confidence (~0.6-0.7), e.g. 0.6 * 0.65 / 3 ≈ 0.13. A lower-effort
# fix (e.g. 'metadata', effort_level 1 — see _generator_for_declining_page
# below) clears this same bar at a proportionally lower opportunity/
# confidence, by the formula's own design (see prioritizer.py's docstring:
# lower effort is meant to inflate priority). Deliberately conservative —
# raise or lower only with real data on how often the gate is
# firing/blocking, not by intuition alone.
MIN_PRIORITY_SCORE_TO_TRIGGER = 0.12


@dataclass
class PriorityDecision:
    should_act: bool
    reason: str
    detail: dict


def _is_decline(insight: Insight) -> bool:
    e = insight.evidence or {}
    if insight.insight_type == "trend_shift":
        return isinstance(e.get("pct_change"), (int, float)) and e["pct_change"] < 0
    if insight.insight_type == "anomaly":
        return e.get("direction") == "low"
    if insight.insight_type == "forecast_risk":
        return True
    if insight.insight_type == "milestone":
        return e.get("direction") == "down"
    return False


def _generator_for_declining_page(insight: Insight) -> tuple[str, dict]:
    """MUST mirror server/agents/lib/analyst-seo-mapping.js::
    generatorForDecliningPage exactly — both subsystems read the same
    Insight rows and build the identical finding_id (see _eligibility
    below) for the same finding, but getDraftByFindingId's idempotency
    check (server/store/drafts.js) matches on finding_id ALONE, not
    generator_id. If the two subsystems picked different generators for the
    same finding, whichever one drafts first would silently and
    permanently suppress the other, correct one — a real defect an
    end-to-end audit found (this trigger previously hardcoded
    'expand-content' for every gsc_* metric). Reasoning, verbatim from that
    Node function: clicks/CTR falling while impressions hold means people
    see the result and don't click — a presentation problem the title/
    description control. Position worsening is a competitiveness signal —
    answer the query more directly. Impressions falling is a coverage/
    relevance problem — give the page more substance."""
    page = insight.dimension_value
    if insight.metric_key in ("gsc_ctr", "gsc_clicks"):
        # meta-title.js requires `query`; Node's own mapping passes the
        # page-dimension insight's dimension_value (the page URL, not a
        # real search query) for this same param — mirrored as-is for
        # parity, not a Python-side decision to relitigate here.
        return "meta-title", {"page": page, "query": page}
    if insight.metric_key == "gsc_position":
        return "qa-content", {"page": page}
    return "expand-content", {"page": page}


def _eligibility(insight: Insight) -> dict | None:
    if not insight.metric_key.startswith("gsc_"):
        return None
    if insight.dimension_type != "page" or not insight.dimension_value:
        return None
    if not _is_decline(insight):
        return None
    if not _ABSOLUTE_URL_RE.match(insight.dimension_value):
        return None  # would need Node's site-domain fallback — not replicated here, see module docstring

    generator_id, params = _generator_for_declining_page(insight)
    return {
        "generator_id": generator_id,
        "params": params,
        "finding_id": (
            f"analyst:{insight.metric_key}:{insight.insight_type}:"
            f"{insight.period_start.isoformat()}:{insight.dimension_value}"
        ),
    }


async def run_draft_trigger() -> None:
    """Per-investigation AND per-client isolation (see the audit that found
    this loop, unlike every one of its Node siblings — auto-remediation.js's
    ship loop, fix-verification.js/fix-impact.js's due-sweeps — had none: an
    uncaught exception from ONE investigation used to abort every remaining
    investigation for that client, and propagate out to abort every
    SUBSEQUENT client in the same run too, with only "nightly analysis run
    failed" logged for the whole night. One bad/malformed row must only ever
    cost that one row's decision, never anyone else's."""
    async with SessionLocal() as session:
        clients = (await session.execute(select(Client).where(Client.status == "active"))).scalars().all()

    for client in clients:
        try:
            async with SessionLocal() as session:
                investigations = (
                    await session.execute(
                        select(Investigation).where(
                            Investigation.client_id == client.id, Investigation.status == "recommendation_generated",
                        )
                    )
                ).scalars().all()
                for investigation in investigations:
                    try:
                        await _try_trigger(session, client, investigation)
                        # Commit per-investigation, not once after the whole
                        # loop: this session is shared across every
                        # investigation in the client's batch, so a later
                        # investigation's rollback() below would otherwise
                        # also discard an earlier investigation's already-
                        # successful status/audit update — and its real,
                        # external generate_draft MCP call already fired.
                        await session.commit()
                    except Exception:
                        logger.exception(
                            "run_draft_trigger: client %s investigation %s raised — skipping this investigation only",
                            client.id, investigation.id,
                        )
                        await session.rollback()
        except Exception:
            logger.exception(
                "run_draft_trigger: client %s raised outside the per-investigation loop — skipping this client only",
                client.id,
            )


def _priority_decision(ranking: RecommendationRanking | None) -> PriorityDecision:
    """Pure decision predicate over an already-fetched RecommendationRanking
    row — no DB/session access, so it's directly unit-testable. Anything
    other than a real 'ok' row at or above MIN_PRIORITY_SCORE_TO_TRIGGER
    fails closed (see the PRIORITY GATE module docstring)."""
    if ranking is None:
        return PriorityDecision(False, "no recommendation-ranking row exists yet for this investigation", {})
    if ranking.status != "ok" or ranking.priority_score is None:
        return PriorityDecision(
            False, f"recommendation-ranking status='{ranking.status}' (no usable priority_score)",
            {"recommendation_ranking_status": ranking.status},
        )

    priority_score = float(ranking.priority_score)
    detail = {
        "priority_score": priority_score, "rank": ranking.rank,
        "min_priority_score_to_trigger": MIN_PRIORITY_SCORE_TO_TRIGGER,
    }
    if priority_score < MIN_PRIORITY_SCORE_TO_TRIGGER:
        return PriorityDecision(
            False, f"priority_score {priority_score} below MIN_PRIORITY_SCORE_TO_TRIGGER {MIN_PRIORITY_SCORE_TO_TRIGGER}",
            detail,
        )
    return PriorityDecision(True, f"priority_score {priority_score} meets the trigger bar", detail)


async def _latest_recommendation(session: AsyncSession, investigation: Investigation) -> AnalystRecommendations | None:
    """Same disambiguation app/opportunities/rollup.py already uses:
    Investigation has no direct FK to Recommendation (it's the other way
    around), so the current one is whichever Recommendation row still
    points back at this investigation_id, most-recent first."""
    return (
        await session.execute(
            select(AnalystRecommendations)
            .where(AnalystRecommendations.investigation_id == investigation.id)
            .order_by(AnalystRecommendations.generated_at.desc())
        )
    ).scalars().first()


async def _ensure_effort_estimation(session: AsyncSession, client: Client, rec: AnalystRecommendations) -> EffortEstimation | None:
    existing = (
        await session.execute(select(EffortEstimation).where(EffortEstimation.recommendation_id == rec.id))
    ).scalar_one_or_none()
    if existing is not None:
        return existing
    await effort_estimation_engine._estimate(session, client.id, rec)
    await session.flush()
    return (
        await session.execute(select(EffortEstimation).where(EffortEstimation.recommendation_id == rec.id))
    ).scalar_one_or_none()


async def _ensure_opportunity_score(session: AsyncSession, client: Client, rec: AnalystRecommendations) -> OpportunityScore | None:
    existing = (
        await session.execute(select(OpportunityScore).where(OpportunityScore.recommendation_id == rec.id))
    ).scalar_one_or_none()
    if existing is not None:
        return existing
    # Opportunity Scoring reads EffortEstimation itself for two of its
    # factors (affected_page_count, difficulty) — must exist first.
    await opportunity_scoring_engine._score(session, client, rec)
    await session.flush()
    return (
        await session.execute(select(OpportunityScore).where(OpportunityScore.recommendation_id == rec.id))
    ).scalar_one_or_none()


async def _ensure_impact_prediction(session: AsyncSession, client: Client, rec: AnalystRecommendations) -> ImpactPrediction | None:
    existing = (
        await session.execute(select(ImpactPrediction).where(ImpactPrediction.recommendation_id == rec.id))
    ).scalar_one_or_none()
    if existing is not None:
        return existing
    await impact_prediction_engine._predict(session, client.id, rec)
    await session.flush()
    return (
        await session.execute(select(ImpactPrediction).where(ImpactPrediction.recommendation_id == rec.id))
    ).scalar_one_or_none()


async def _ensure_priority_ranking(session: AsyncSession, client: Client, rec: AnalystRecommendations) -> RecommendationRanking | None:
    """Prefer an already-persisted RecommendationRanking (written by
    scripts/run_nightly_pipeline.py's prioritizer stage — authoritative,
    batch-ranked). Only when none exists yet does this compute one
    on-demand for THIS single recommendation (see DEPENDENCY RESOLUTION in
    the module docstring), reusing the existing per-recommendation effort/
    opportunity engines and the existing priority formula verbatim
    (prioritizer_engine.compute_priority_score) — never duplicated here.
    The on-demand result is intentionally NOT persisted as a
    RecommendationRanking row: 'rank' is a batch-relative concept this
    single-recommendation path has no meaningful value for, and leaving the
    row absent lets the nightly pipeline's prioritizer still write the real,
    batch-ranked row later without a unique-constraint conflict."""
    existing = (
        await session.execute(select(RecommendationRanking).where(RecommendationRanking.recommendation_id == rec.id))
    ).scalar_one_or_none()
    if existing is not None:
        return existing

    await _ensure_effort_estimation(session, client, rec)
    await _ensure_opportunity_score(session, client, rec)

    inputs = await prioritizer_engine._priority_inputs(session, rec)
    if inputs is None:
        return None
    opportunity_score, confidence, effort_level = inputs
    priority_score = prioritizer_engine.compute_priority_score(opportunity_score, confidence, effort_level)
    return RecommendationRanking(
        client_id=client.id, recommendation_id=rec.id, status="ok", priority_score=priority_score, rank=None,
        method_detail={"computed_on_demand_by": "run_draft_trigger"},
    )


async def _try_trigger(session: AsyncSession, client: Client, investigation: Investigation) -> None:
    if investigation.source_insight_id is None:
        return
    insight = await session.get(Insight, investigation.source_insight_id)
    if insight is None:
        return

    action = _eligibility(insight)
    if action is None:
        return  # not eligible — expected for the vast majority of investigations, not an error

    rec = await _latest_recommendation(session, investigation)
    if rec is None:
        return  # shouldn't happen (see _upsert_investigation) — no recommendation to score

    ranking = await _ensure_priority_ranking(session, client, rec)
    priority_decision = _priority_decision(ranking)
    if not priority_decision.should_act:
        logger.info(
            "run_draft_trigger: investigation %s eligible but declined by priority gate — %s",
            investigation.id, priority_decision.reason,
        )
        return

    # Not a second gate (see the module docstring's revision note): computed
    # and persisted purely because app/api/routes/intelligence.py already
    # serves ImpactPrediction per-recommendation for staff reporting, and
    # this is the same on-demand mechanism the priority gate above needs
    # anyway. Its result is never consulted for the action decision.
    prediction = await _ensure_impact_prediction(session, client, rec)

    mcp = McpClient(client.mcp_token_ciphertext)
    try:
        await generate_draft(mcp, **action)
    except McpAuthError as e:
        logger.warning("run_draft_trigger: client %s auth failed, skipping: %s", client.id, e)
        return
    except McpToolError as e:
        logger.warning("run_draft_trigger: client %s draft generation failed, skipping: %s", client.id, e)
        return

    session.add(InvestigationEvent(
        investigation_id=investigation.id, from_status=investigation.status, to_status="draft_prepared",
        detail={
            "priority_gate": priority_decision.detail,
            "impact_prediction": {
                "status": prediction.status, "expected_impact_magnitude": prediction.expected_impact_magnitude,
            } if prediction is not None else None,
        },
    ))
    investigation.status = "draft_prepared"
