"""Investigation Outcome Evaluation (Phase 4 — prediction -> outcome ->
learning loop). Closes the Investigation lifecycle's last, previously-unused
transition: 'approved' -> 'completed' (the status CHECK constraint already
allowed both, but nothing in this codebase ever wrote them before this).

Scope: only forecast_risk investigations a human actually approved
(status == 'approved' — see app/api/routes/investigations.py's approve
endpoint), once the investigation's own captured forecast_outlook's
predicted_date has passed and a real actual value has landed for it. Every
input is a row an earlier stage already wrote (Investigation.forecast_outlook
is literally the triggering Insight's own evidence — see
app/investigations/engine.py) compared against a real MetricObservation,
never a sampled or estimated actual — same discipline as
app/forecast/accuracy.py, which this module deliberately does not
duplicate: that one tracks raw forecast-point accuracy for every forecast
regardless of whether anyone acted on it; this one only evaluates
investigations a human approved, so it answers "did the fix help", not
"was the forecast accurate" (already covered).

Explicitly NOT a causality claim: outcome_status is a comparison between
what was predicted and what actually happened, never "the fix caused this"
— there is no real counterfactual (no way to know what would have happened
without the approved fix), so 'decline_smaller_than_predicted' is worded and
documented as a candidate signal for human judgment, not a proven result.

get_investigation_outcome_reliability below closes this table's other loose
end: how often THIS client's approved forecast_risk investigations turn out
to be right, reused as one forecast-confidence factor (see
app/forecast/confidence.py) via the SAME pattern app/forecast/accuracy.py's
get_rolling_accuracy already established for raw forecast points — not
forced into the generator/priority system, which this table has no natural
relationship to: outcome_status is explicitly not a causality claim, and
approving an investigation is a separate human workflow from the
draft-trigger's own priority-gated action selection (see
app/investigations/drafts.py)."""
import logging
from datetime import date

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import Client, Investigation, InvestigationEvent, InvestigationOutcome, MetricObservation
from app.db.session import SessionLocal

logger = logging.getLogger(__name__)

# Below this many evaluated outcomes for a client, there's no real signal to
# ground a reliability figure on yet — approved forecast_risk investigations
# are inherently rare, so this threshold is deliberately lower than
# app/forecast/accuracy.py's MIN_EVALUATED_POINTS_FOR_SIGNAL (5), which draws
# from every forecast point regardless of approval.
MIN_EVALUATED_OUTCOMES_FOR_SIGNAL = 3


async def run_investigation_outcome_evaluation() -> None:
    """Per-investigation AND per-client isolation (same fix, same reasoning,
    as app/investigations/drafts.py::run_draft_trigger — one malformed
    forecast_outlook must only ever cost that one investigation's outcome
    evaluation, never abort every remaining investigation for its client or
    every subsequent client's evaluation for the whole night)."""
    async with SessionLocal() as session:
        clients = (await session.execute(select(Client).where(Client.status == "active"))).scalars().all()

    for client in clients:
        try:
            async with SessionLocal() as session:
                await _evaluate_client(session, client.id)
                await session.commit()
        except Exception:
            logger.exception(
                "run_investigation_outcome_evaluation: client %s raised outside the per-investigation loop — skipping this client only",
                client.id,
            )


async def _evaluate_client(session: AsyncSession, client_id: int) -> None:
    already_evaluated = {
        r[0] for r in (
            await session.execute(
                select(InvestigationOutcome.investigation_id).where(InvestigationOutcome.client_id == client_id)
            )
        ).all()
    }

    candidates = (
        await session.execute(
            select(Investigation).where(
                Investigation.client_id == client_id,
                Investigation.status == "approved",
                Investigation.insight_type == "forecast_risk",
            )
        )
    ).scalars().all()

    for inv in candidates:
        if inv.id in already_evaluated:
            continue
        try:
            await _evaluate_one(session, client_id, inv)
            # Commit per-investigation: this session is shared across the
            # whole client's candidate list, so a later investigation's
            # rollback() would otherwise also discard an earlier
            # investigation's already-computed InvestigationOutcome row.
            await session.commit()
        except Exception:
            logger.exception(
                "run_investigation_outcome_evaluation: client %s investigation %s raised — skipping this investigation only",
                client_id, inv.id,
            )
            await session.rollback()


async def _evaluate_one(session: AsyncSession, client_id: int, inv: Investigation) -> None:
    outlook = inv.forecast_outlook or {}
    predicted_date_raw, last_actual, pct_projected = outlook.get("predicted_date"), outlook.get("last_actual"), outlook.get("pct_projected_change")
    if predicted_date_raw is None or last_actual is None or pct_projected is None:
        return  # this investigation's own captured evidence is incomplete — never guess the missing piece

    predicted_date = date.fromisoformat(predicted_date_raw)
    if predicted_date > date.today():
        return  # too early — the real actual for this date can't exist yet, retry a later night

    baseline_value = float(last_actual)
    if baseline_value == 0:
        return  # a 0 baseline makes pct_change undefined, not a real signal to evaluate

    actual = await session.scalar(
        select(MetricObservation.value).where(
            MetricObservation.client_id == client_id, MetricObservation.metric_key == inv.metric_key,
            MetricObservation.dimension_type == inv.dimension_type, MetricObservation.dimension_value == inv.dimension_value,
            MetricObservation.period_start == predicted_date,
        )
    )
    if actual is None:
        return  # the real value for this date hasn't landed yet — retry a later night

    actual_value = float(actual)
    pct_actual_change = (actual_value - baseline_value) / baseline_value * 100
    pct_projected_change = float(pct_projected)

    if pct_actual_change >= 0:
        outcome_status = "no_decline_occurred"
    elif pct_actual_change > pct_projected_change:
        # Declined, but less than the forecast predicted — a real, honest
        # observation. Framed as a candidate signal for human judgment, not
        # proof the approved fix caused it (see module docstring).
        outcome_status = "decline_smaller_than_predicted"
    else:
        outcome_status = "decline_as_predicted_or_worse"

    session.add(InvestigationOutcome(
        client_id=client_id, investigation_id=inv.id,
        baseline_value=baseline_value, predicted_value=baseline_value * (1 + pct_projected_change / 100),
        actual_value=actual_value, pct_projected_change=pct_projected_change, pct_actual_change=pct_actual_change,
        outcome_status=outcome_status,
    ))
    session.add(InvestigationEvent(
        investigation_id=inv.id, from_status=inv.status, to_status="completed",
        actor="system", detail={"outcome_status": outcome_status, "pct_actual_change": pct_actual_change, "pct_projected_change": pct_projected_change},
    ))
    inv.status = "completed"


# A materialized outcome means the forecast_risk investigation's predicted
# decline was real, whether or not it was as severe as projected —
# 'decline_smaller_than_predicted' still means the decline HAPPENED, just
# not to the predicted magnitude. Only 'no_decline_occurred' means the
# forecast risk didn't pan out at all.
_MATERIALIZED_STATUSES = ("decline_as_predicted_or_worse", "decline_smaller_than_predicted")


async def get_investigation_outcome_reliability(session: AsyncSession, client_id: int) -> dict:
    """Read-only accessor, same pattern as app/forecast/accuracy.py's
    get_rolling_accuracy: how often an approved forecast_risk investigation's
    predicted decline actually materialized — a signal about how much to
    trust THIS client's forecast-risk investigations generally, reused as
    one forecast-confidence factor (see app/forecast/confidence.py).
    status='insufficient-data' below MIN_EVALUATED_OUTCOMES_FOR_SIGNAL, same
    convention as every other engine in this codebase — never a noisy
    fraction from one or two outcomes presented as reliable."""
    statuses = (
        await session.execute(
            select(InvestigationOutcome.outcome_status).where(InvestigationOutcome.client_id == client_id)
        )
    ).scalars().all()

    if len(statuses) < MIN_EVALUATED_OUTCOMES_FOR_SIGNAL:
        return {"status": "insufficient-data", "evaluated_outcomes": len(statuses), "reliability": None}

    materialized = sum(1 for s in statuses if s in _MATERIALIZED_STATUSES)
    return {"status": "ok", "evaluated_outcomes": len(statuses), "reliability": materialized / len(statuses)}
