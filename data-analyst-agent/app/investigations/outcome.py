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
documented as a candidate signal for human judgment, not a proven result."""
from datetime import date

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import Client, Investigation, InvestigationEvent, InvestigationOutcome, MetricObservation
from app.db.session import SessionLocal


async def run_investigation_outcome_evaluation() -> None:
    async with SessionLocal() as session:
        clients = (await session.execute(select(Client).where(Client.status == "active"))).scalars().all()

    for client in clients:
        async with SessionLocal() as session:
            await _evaluate_client(session, client.id)
            await session.commit()


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
        await _evaluate_one(session, client_id, inv)


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
