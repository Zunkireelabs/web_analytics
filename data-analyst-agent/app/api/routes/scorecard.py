"""How good are this client's predictions, measured, in one place.

Three kinds of prediction are scored against what actually happened, in one unit (percent, app/forecast/error.py), and each says
how much evidence stands behind its own number:

  * forecasts: forecast_accuracy, per metric and dimension, and again per forecast horizon (days 1-3, 4-7, 8-14);
  * the weekly outlook (site clicks and impressions): prediction_log, per metric and horizon;
  * page-decline warnings: predicted_issues, as a reliability table (did "70% likely" happen about 70% of the time?).

Read-only. A kind with too little resolved evidence reports `enough_to_judge: false` and its counts; this route never turns a handful
of points into a headline accuracy figure."""
from datetime import date

from fastapi import APIRouter, Depends
from sqlalchemy import and_, case, func, literal_column, select
from sqlalchemy.orm import aliased
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_active_client
from app.db.models import Client, ForecastAccuracy, ForecastPoint, ForecastRun, MetricObservation, PredictedIssue, PredictionLog
from app.db.session import get_session
from app.predict.calibration import MIN_PER_BAND, reliability

router = APIRouter()

ENOUGH_POINTS = 20           # scored points before an accuracy figure for a metric is worth reading
FORECAST_WITHIN_PCT = 25.0
OUTLOOK_WITHIN_PCT = 10.0


def _num(v):
    return None if v is None else round(float(v), 2)


@router.get("/clients/{client_id}/prediction-scorecard")
async def get_prediction_scorecard(client: Client = Depends(get_active_client), session: AsyncSession = Depends(get_session)) -> dict:
    fa = ForecastAccuracy
    forecast_rows = (await session.execute(
        select(
            fa.metric_key, fa.dimension_type, func.count().label("total"), func.count(fa.abs_pct_error).label("scored"),
            func.percentile_cont(0.5).within_group(fa.abs_pct_error).label("median"), func.avg(fa.abs_pct_error).label("mean"),
            func.sum(case((fa.abs_pct_error <= FORECAST_WITHIN_PCT, 1), else_=0)).label("within"),
        ).where(fa.client_id == client.id).group_by(fa.metric_key, fa.dimension_type).order_by(fa.metric_key, fa.dimension_type)
    )).all()
    forecasts = [{
        "metric_key": r.metric_key, "dimension_type": r.dimension_type, "evaluated": r.total, "scored": r.scored,
        "actual_was_zero": r.total - r.scored, "median_abs_pct_error": _num(r.median), "mean_abs_pct_error": _num(r.mean),
        f"share_within_{int(FORECAST_WITHIN_PCT)}pct": round((r.within or 0) / r.scored, 3) if r.scored else None,
        "enough_to_judge": r.scored >= ENOUGH_POINTS,
    } for r in forecast_rows]

    # Does the model beat the cheapest possible alternative? For DAILY forecasts the naive guess is "the same weekday two weeks
    # earlier": already observed when any forecast up to 14 days ahead is made, so it is a fair, zero-skill baseline. A forecast whose
    # error is not below it is adding nothing, however plausible its curve looks.
    naive = aliased(MetricObservation)
    naive_error = func.abs(naive.value - fa.actual_value) / func.abs(fa.actual_value) * 100
    naive_rows = (await session.execute(
        select(
            fa.metric_key, fa.dimension_type, func.count().label("compared"),
            func.percentile_cont(0.5).within_group(fa.abs_pct_error).label("model_median"),
            func.percentile_cont(0.5).within_group(naive_error).label("naive_median"),
            func.sum(case((fa.abs_pct_error < naive_error, 1), else_=0)).label("model_wins"),
        )
        .join(ForecastPoint, ForecastPoint.id == fa.forecast_point_id)
        .join(ForecastRun, ForecastRun.id == ForecastPoint.forecast_run_id)
        .join(naive, and_(
            naive.client_id == fa.client_id, naive.metric_key == fa.metric_key, naive.dimension_type == fa.dimension_type,
            naive.dimension_value == fa.dimension_value, naive.value.is_not(None),
            naive.period_start == literal_column("forecast_points.target_period - 14"),
        ))
        .where(fa.client_id == client.id, ForecastRun.cadence == "daily", fa.actual_value != 0, fa.abs_pct_error.is_not(None))
        .group_by(fa.metric_key, fa.dimension_type)
    )).all()
    vs_naive = {(r.metric_key, r.dimension_type): {
        "compared": r.compared, "model_median_abs_pct_error": _num(r.model_median), "naive_median_abs_pct_error": _num(r.naive_median),
        "model_beats_naive_share": round((r.model_wins or 0) / r.compared, 3) if r.compared else None,
    } for r in naive_rows}
    for row in forecasts:
        row["vs_same_weekday_two_weeks_earlier"] = vs_naive.get((row["metric_key"], row["dimension_type"]))

    # The same comparison split by how far ahead the point was. "Horizon" is the point's position within its own forecast run
    # (day 1 = the first forecast day), which does not depend on guessing when the run happened.
    step = literal_column(
        "(forecast_points.target_period - min(forecast_points.target_period) over (partition by forecast_points.forecast_run_id) + 1)"
    ).label("step")
    steps = select(ForecastPoint.id.label("pid"), step).subquery()
    bucket = case((steps.c.step <= 3, "1-3"), (steps.c.step <= 7, "4-7"), else_="8-14").label("horizon_days")
    horizon_rows = (await session.execute(
        select(
            fa.metric_key, fa.dimension_type, bucket, func.count(fa.abs_pct_error).label("scored"),
            func.percentile_cont(0.5).within_group(fa.abs_pct_error).label("model_median"),
            func.count(naive_error).label("naive_compared"),
            func.percentile_cont(0.5).within_group(naive_error).label("naive_median"),
            func.sum(case((fa.abs_pct_error < naive_error, 1), else_=0)).label("model_wins"),
        )
        .join(steps, steps.c.pid == fa.forecast_point_id)
        .join(ForecastPoint, ForecastPoint.id == fa.forecast_point_id)
        .join(ForecastRun, ForecastRun.id == ForecastPoint.forecast_run_id)
        .outerjoin(naive, and_(
            naive.client_id == fa.client_id, naive.metric_key == fa.metric_key, naive.dimension_type == fa.dimension_type,
            naive.dimension_value == fa.dimension_value, naive.value.is_not(None),
            naive.period_start == literal_column("forecast_points.target_period - 14"),
        ))
        .where(fa.client_id == client.id, ForecastRun.cadence == "daily", fa.actual_value != 0, fa.abs_pct_error.is_not(None))
        .group_by(fa.metric_key, fa.dimension_type, bucket).order_by(fa.metric_key, fa.dimension_type, bucket)
    )).all()
    by_horizon = [{
        "metric_key": r.metric_key, "dimension_type": r.dimension_type, "horizon_days": r.horizon_days, "scored": r.scored,
        "model_median_abs_pct_error": _num(r.model_median), "naive_compared": r.naive_compared,
        "naive_median_abs_pct_error": _num(r.naive_median),
        "model_beats_naive_share": round((r.model_wins or 0) / r.naive_compared, 3) if r.naive_compared else None,
        "enough_to_judge": r.scored >= ENOUGH_POINTS,
    } for r in horizon_rows]

    pl = PredictionLog
    outlook_rows = (await session.execute(
        select(
            pl.metric_key, pl.horizon, func.count().label("made"), func.count(pl.actual).label("resolved"),
            func.count(pl.abs_pct_error).label("scored"), func.percentile_cont(0.5).within_group(pl.abs_pct_error).label("median"),
            func.sum(case((pl.abs_pct_error <= OUTLOOK_WITHIN_PCT, 1), else_=0)).label("within"),
        ).where(pl.client_id == client.id).group_by(pl.metric_key, pl.horizon).order_by(pl.metric_key, pl.horizon)
    )).all()
    outlook = [{
        "metric_key": r.metric_key, "horizon_weeks": r.horizon, "made": r.made, "resolved": r.resolved,
        "pending": r.made - r.resolved, "median_abs_pct_error": _num(r.median),
        f"share_within_{int(OUTLOOK_WITHIN_PCT)}pct": round((r.within or 0) / r.scored, 3) if r.scored else None,
        "enough_to_judge": r.scored >= ENOUGH_POINTS,
    } for r in outlook_rows]

    issue_rows = (await session.execute(
        select(PredictedIssue.likelihood, PredictedIssue.outcome).where(PredictedIssue.client_id == client.id, PredictedIssue.kind == "page_decline")
    )).all()
    resolved = [(float(l), o == "happened") for l, o in issue_rows if o is not None]
    page_decline = {
        "predicted": len(issue_rows), "pending": sum(1 for _, o in issue_rows if o is None),
        **reliability(resolved), "min_resolved_per_band_to_trust": MIN_PER_BAND,
    }

    return {
        "client_id": client.id, "as_of": date.today().isoformat(), "unit": "percent",
        "forecasts": forecasts, "forecasts_by_horizon": by_horizon, "weekly_outlook": outlook, "page_decline_warnings": page_decline,
        "notes": [
            "Errors are |predicted - actual| / |actual| * 100; rows whose actual was exactly 0 are counted in actual_was_zero, not scored.",
            f"A figure with enough_to_judge=false rests on fewer than {ENOUGH_POINTS} scored points: read it as 'too early', not as accuracy.",
            "vs_same_weekday_two_weeks_earlier compares daily forecasts with the cheapest baseline; model_beats_naive_share below 0.5 means the "
            "forecast does worse than repeating history.",
            "A page-decline band is trusted only once it has resolved outcomes of this client's own; until then the stated likelihood is an "
            "uncalibrated model score.",
        ],
    }
