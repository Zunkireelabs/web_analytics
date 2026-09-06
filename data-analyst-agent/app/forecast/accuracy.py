"""Forecast Accuracy Evaluation (Phase 3 AI memory, Step 11) — nightly
comparison of past ForecastPoints against the MetricObservation that has
since actually landed, once its target_period is no longer in the future.
One row per ForecastPoint, evaluated exactly once (unique forecast_point_id
— see app/db/models.py::ForecastAccuracy), matching every other Phase 2
engine's "never re-run for the same subject" idempotent contract.

No new forecasting: every input is a row an earlier ForecastRun already
wrote, compared against a real MetricObservation, never a sampled or
estimated actual. A point whose target_period's actual hasn't landed yet
(or a forecast with no point_estimate) is simply skipped and picked up on
a later night once the real value exists — never fabricated or backfilled
with an approximation."""
from datetime import date

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import Client, ForecastAccuracy, ForecastPoint, ForecastRun, MetricObservation
from app.db.session import SessionLocal

# Below this many evaluated points for a client, there's no real signal to
# ground a rolling accuracy figure on yet — callers should treat fewer than
# this as "insufficient history", not a legitimate (if noisy) average.
MIN_EVALUATED_POINTS_FOR_SIGNAL = 5


async def run_forecast_accuracy_evaluation() -> None:
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
                select(ForecastAccuracy.forecast_point_id).where(ForecastAccuracy.client_id == client_id)
            )
        ).all()
    }

    rows = (
        await session.execute(
            select(ForecastPoint, ForecastRun)
            .join(ForecastRun, ForecastPoint.forecast_run_id == ForecastRun.id)
            .where(
                ForecastRun.client_id == client_id, ForecastRun.status == "ok",
                ForecastPoint.target_period <= date.today(),
            )
        )
    ).all()

    for point, run in rows:
        if point.id in already_evaluated or point.point_estimate is None:
            continue

        actual = await session.scalar(
            select(MetricObservation.value).where(
                MetricObservation.client_id == client_id, MetricObservation.metric_key == run.metric_key,
                MetricObservation.dimension_type == run.dimension_type,
                MetricObservation.dimension_value == run.dimension_value,
                MetricObservation.period_start == point.target_period,
            )
        )
        if actual is None:
            continue  # the real value for this date hasn't landed yet — retry a later night

        predicted, actual_f = float(point.point_estimate), float(actual)
        abs_pct_error = abs(predicted - actual_f) / abs(actual_f) * 100 if actual_f != 0 else None

        session.add(ForecastAccuracy(
            client_id=client_id, metric_key=run.metric_key, forecast_point_id=point.id,
            dimension_type=run.dimension_type, dimension_value=run.dimension_value,
            predicted_value=predicted, actual_value=actual_f, abs_pct_error=abs_pct_error,
        ))


async def get_rolling_accuracy(
    session: AsyncSession, client_id: int, metric_key: str | None = None,
    dimension_type: str | None = None, dimension_value: str | None = None,
) -> dict:
    """Read-only accessor other engines/routes can use once they're ready
    to fold this into their own formulas (not yet wired into
    prioritizer.py/opportunity_scoring.py in this milestone — see the
    Phase 3 rollout notes). status='insufficient-data' below
    MIN_EVALUATED_POINTS_FOR_SIGNAL, same convention as every other engine
    in this codebase, never a noisy average presented as reliable.

    dimension_type/dimension_value are optional so existing callers that
    want a metric-wide figure across every dimension keep working
    unchanged; app/forecast/confidence.py passes both so a page/channel/
    device forecast's historical accuracy never blends in another
    dimension's error."""
    query = select(ForecastAccuracy.abs_pct_error).where(ForecastAccuracy.client_id == client_id)
    if metric_key:
        query = query.where(ForecastAccuracy.metric_key == metric_key)
    if dimension_type:
        query = query.where(ForecastAccuracy.dimension_type == dimension_type)
    if dimension_value:
        query = query.where(ForecastAccuracy.dimension_value == dimension_value)
    errors = [float(e) for e in (await session.execute(query)).scalars().all() if e is not None]

    if len(errors) < MIN_EVALUATED_POINTS_FOR_SIGNAL:
        return {"status": "insufficient-data", "evaluated_points": len(errors), "avg_abs_pct_error": None}

    return {
        "status": "ok", "evaluated_points": len(errors),
        "avg_abs_pct_error": sum(errors) / len(errors),
    }
