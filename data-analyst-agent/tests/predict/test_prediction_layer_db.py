"""The prediction layer against a REAL Postgres: does it write predictions, score them against what happened, and say honest things?

This is the proof the audit asked for. Production's prediction tables (prediction_log, predicted_issues, ...) held 0 rows, and the
unit tests could not say whether the layer works or was merely never reached. Here a client with realistic history is predicted,
a week passes, the actuals land, and the next run scores the earlier predictions: percent error in the SAME unit as forecast
accuracy, the page-decline outcome recorded, the insight carrying the model's real decline threshold (not the old hardcoded -25%)
and an honestly labelled confidence, and the scorecard reading it all back.

Opt-in and local-only (see tests/analysis/test_ledger_db.py): needs DATABASE_URL on the local scratch analyst database; otherwise it
is skipped and can never touch production. It creates one client and deletes it (cascade) afterwards."""
from datetime import date, timedelta

import numpy as np
import pytest
import pytest_asyncio
from sqlalchemy import delete, select

from app.config import settings

LOCAL_SCRATCH = "127.0.0.1:55432/analyst_stage1_test"
pytestmark = [
    pytest.mark.skipif(LOCAL_SCRATCH not in settings.database_url, reason="opt-in: needs the local scratch analyst database"),
    pytest.mark.asyncio(loop_scope="module"),
]

from app.api.routes.scorecard import get_prediction_scorecard  # noqa: E402
from app.db.models import (  # noqa: E402
    Client, ForecastPoint, ForecastRun, Insight, MetricCatalog, MetricObservation, PageQueryObservation, PredictedIssue, PredictionLog,
)
from app.db.session import SessionLocal  # noqa: E402
from app.forecast.run import _forecast_one  # noqa: E402
from app.forecast.registry import FORECASTERS  # noqa: E402
from app.predict.features import DECLINE_FRACTION  # noqa: E402
from app.predict.run import run_predictions  # noqa: E402
from app.security.secrets import encrypt_token  # noqa: E402

CID = 990001
AS_OF = date(2026, 11, 23)          # a Monday: the week now starting is the one predicted
FALLING, STEADY, TINY = "https://example.test/falling", "https://example.test/steady", "https://example.test/tiny"


async def _seed(through: date):
    """22 weeks of daily history ending on `through`. Site clicks/impressions drift down a little; one page collapses in its latest
    weeks, one is steady, one is below the noise floor."""
    rng = np.random.default_rng(7)
    start = date(2026, 6, 22)
    days = [start + timedelta(days=i) for i in range((through - start).days + 1)]
    async with SessionLocal() as s:
        if await s.get(Client, CID) is None:
            s.add(Client(id=CID, name="stage2-itest", status="active", timezone="UTC", mcp_token_ciphertext=encrypt_token(""),
                         mcp_token_prefix="(none)", mcp_permission_level="read_only"))
            await s.flush()
        for i, d in enumerate(days):
            week = (d - start).days // 7
            clicks = 300 - 2.0 * week + 20 * np.sin(i * 2 * np.pi / 7) + rng.normal(0, 4)
            for key, val in (("gsc_clicks", clicks), ("gsc_impressions", clicks * 30)):
                await s.merge(MetricObservation(client_id=CID, metric_key=key, dimension_type="site", dimension_value="__site__", period_start=d, value=float(val)))
            collapse = d >= date(2026, 11, 2)                           # the last weeks before AS_OF
            falls_again = d >= AS_OF                                    # and in the week being predicted it falls again
            falling_base = 90.0 if not collapse else 22.0 if not falls_again else 8.0
            for page, base in ((FALLING, falling_base), (STEADY, 60.0), (TINY, 1.0)):
                c = max(0.0, base + rng.normal(0, base * 0.05))
                await s.merge(PageQueryObservation(client_id=CID, dimension_type="page", dimension_value=page, period_start=d,
                                                   clicks=c, impressions=c * 25, ctr=0.04, position=6.0 + (4.0 if collapse and page == FALLING else 0.0)))
        await s.commit()


@pytest_asyncio.fixture(autouse=True, loop_scope="module")
async def _clean():
    async def wipe():
        async with SessionLocal() as s:
            await s.execute(delete(Client).where(Client.id == CID))
            await s.commit()
    await wipe()
    yield
    await wipe()


async def test_predictions_are_written_scored_and_honest_end_to_end():
    await _seed(through=date(2026, 11, 22))
    await run_predictions(as_of=AS_OF)

    async with SessionLocal() as s:
        logged = (await s.execute(select(PredictionLog).where(PredictionLog.client_id == CID).order_by(PredictionLog.metric_key, PredictionLog.horizon))).scalars().all()
    # The audit's "0 rows": here the layer writes 2 metrics x 3 horizons, each with an interval that contains the estimate.
    assert [(p.metric_key, p.horizon) for p in logged] == [(m, h) for m in ("gsc_clicks", "gsc_impressions") for h in (1, 2, 3)]
    assert all(p.low <= p.predicted <= p.high and p.low >= 0 and p.model for p in logged)
    assert [p.target_week for p in logged if p.metric_key == "gsc_clicks"] == [date(2026, 11, 23), date(2026, 11, 30), date(2026, 12, 7)]

    async with SessionLocal() as s:
        issues = (await s.execute(select(PredictedIssue).where(PredictedIssue.client_id == CID))).scalars().all()
        insights = (await s.execute(select(Insight).where(Insight.client_id == CID, Insight.insight_type == "forecast_risk"))).scalars().all()
    assert FALLING in {i.page for i in issues}, "the page that collapsed must be warned about"
    assert TINY not in {i.page for i in issues}                          # below the noise floor: never a "decline"
    assert insights, "a likely-enough decline must become a forecast_risk insight"
    for ins in insights:
        e = ins.evidence
        assert e["pct_projected_change"] == -round((1 - DECLINE_FRACTION) * 100, 1) == -20.0    # the model's own threshold, not -25
        assert e["projection_basis"] == "decline_threshold_of_the_model_label"
        assert e["confidence_basis"] == "uncalibrated_model_likelihood"                          # nothing resolved yet: not a measured probability
        assert e["confidence"] == e["likelihood"]

    # A week passes; its real numbers land (the falling page keeps falling), then the next run scores the earlier predictions.
    await _seed(through=date(2026, 11, 29))
    await run_predictions(as_of=date(2026, 11, 30))

    async with SessionLocal() as s:
        scored = (await s.execute(select(PredictionLog).where(PredictionLog.client_id == CID, PredictionLog.target_week == date(2026, 11, 23), PredictionLog.horizon == 1))).scalars().all()
        resolved_issues = (await s.execute(select(PredictedIssue).where(PredictedIssue.client_id == CID, PredictedIssue.target_week == date(2026, 11, 23)))).scalars().all()
    assert scored and all(p.actual is not None and p.resolved_at is not None for p in scored)
    for p in scored:                                                     # percent, same unit and definition as forecast_accuracy
        assert round(float(p.abs_pct_error), 6) == round(abs(float(p.predicted) - float(p.actual)) / abs(float(p.actual)) * 100, 6)
    assert next(i for i in resolved_issues if i.page == FALLING).outcome == "happened"

    async with SessionLocal() as s:
        card = await get_prediction_scorecard(client=await s.get(Client, CID), session=s)
    assert card["unit"] == "percent"
    outlook = {(r["metric_key"], r["horizon_weeks"]): r for r in card["weekly_outlook"]}
    assert outlook[("gsc_clicks", 1)]["resolved"] == 1 and outlook[("gsc_clicks", 1)]["enough_to_judge"] is False   # 1 point is "too early"
    page = card["page_decline_warnings"]
    assert page["n"] >= 1 and all(b["trusted"] is False for b in page["bands"])        # far too few outcomes to trust any band


async def test_a_daily_series_with_a_gap_now_forecasts_and_never_predicts_an_impossible_value():
    """The 13.8k "No supported index" errors and the negative engagement time, through the real forecast runner."""
    rng = np.random.default_rng(3)
    start = date(2026, 8, 1)
    async with SessionLocal() as s:
        s.add(Client(id=CID, name="stage2-itest", status="active", timezone="UTC", mcp_token_ciphertext=encrypt_token(""),
                     mcp_token_prefix="(none)", mcp_permission_level="read_only"))
        await s.flush()
        for i in range(100):
            if i == 30:
                continue                                                  # ONE missing day: left unfilled on purpose
            s.add(MetricObservation(client_id=CID, metric_key="ga4_avg_engagement_time", dimension_type="site", dimension_value="__site__",
                                    period_start=start + timedelta(days=i), value=float(max(0.0, 5.0 - 0.05 * i + rng.normal(0, 0.4)))))
        await s.commit()
    async with SessionLocal() as s:
        metric = await s.get(MetricCatalog, "ga4_avg_engagement_time")
        await _forecast_one(s, CID, metric, "site", "__site__", FORECASTERS["daily"], 14)
        await s.commit()
    async with SessionLocal() as s:
        run = (await s.execute(select(ForecastRun).where(ForecastRun.client_id == CID))).scalars().one()
        points = (await s.execute(select(ForecastPoint).where(ForecastPoint.forecast_run_id == run.id))).scalars().all()
    assert run.status == "ok", run.error                                  # was: error, "No supported index is available."
    assert run.params["observations_set_aside_before_gap"] == 31 and len(points) == 14
    assert all(float(p.point_estimate) >= 0 and float(p.lower_bound) >= 0 for p in points)


async def test_the_scorecard_says_whether_a_forecast_beats_repeating_history():
    """Forecast, let the real numbers land, score them, and compare with the same weekday two weeks earlier."""
    from app.forecast.accuracy import _evaluate_client
    rng = np.random.default_rng(11)
    start = date(2026, 6, 1)

    def value(i):                                   # a clean weekly pattern with a mild upward trend and a little noise
        return float(200 + 0.5 * i + 40 * np.sin(i * 2 * np.pi / 7) + rng.normal(0, 3))
    async with SessionLocal() as s:
        s.add(Client(id=CID, name="stage2-itest", status="active", timezone="UTC", mcp_token_ciphertext=encrypt_token(""),
                     mcp_token_prefix="(none)", mcp_permission_level="read_only"))
        await s.flush()
        for i in range(100):
            s.add(MetricObservation(client_id=CID, metric_key="ga4_sessions", dimension_type="site", dimension_value="__site__",
                                    period_start=start + timedelta(days=i), value=value(i)))
        await s.commit()
    async with SessionLocal() as s:
        metric = await s.get(MetricCatalog, "ga4_sessions")
        await _forecast_one(s, CID, metric, "site", "__site__", FORECASTERS["daily"], 14)
        await s.commit()
    async with SessionLocal() as s:                  # the next 14 days actually happen
        for i in range(100, 114):
            s.add(MetricObservation(client_id=CID, metric_key="ga4_sessions", dimension_type="site", dimension_value="__site__",
                                    period_start=start + timedelta(days=i), value=value(i)))
        await s.commit()
    async with SessionLocal() as s:
        # the runner scores points whose date is not in the future; pin "today" past the horizon
        import app.forecast.accuracy as acc
        real_today = acc.date
        class _Date(date):
            @classmethod
            def today(cls):
                return start + timedelta(days=120)
        acc.date = _Date
        try:
            await _evaluate_client(s, CID)
        finally:
            acc.date = real_today
        await s.commit()
    async with SessionLocal() as s:
        card = await get_prediction_scorecard(client=await s.get(Client, CID), session=s)
    row = next(r for r in card["forecasts"] if r["metric_key"] == "ga4_sessions")
    assert row["evaluated"] == 14 and row["scored"] == 14 and row["enough_to_judge"] is False       # 14 < 20: "too early"
    cmp = row["vs_same_weekday_two_weeks_earlier"]
    assert cmp["compared"] == 14
    assert cmp["model_median_abs_pct_error"] is not None and cmp["naive_median_abs_pct_error"] is not None
    assert 0.0 <= cmp["model_beats_naive_share"] <= 1.0
    # ... and by how far ahead: 14 daily points split 3 / 4 / 7 across the horizon buckets, each with its own baseline comparison
    buckets = {r["horizon_days"]: r for r in card["forecasts_by_horizon"] if r["metric_key"] == "ga4_sessions"}
    assert {k: v["scored"] for k, v in buckets.items()} == {"1-3": 3, "4-7": 4, "8-14": 7}
    assert all(v["naive_compared"] == v["scored"] and v["enough_to_judge"] is False for v in buckets.values())


async def test_a_client_with_no_predictions_gets_an_empty_honest_scorecard():
    """Three of the six real clients have too little history to forecast: the scorecard must say so, not fail or invent a figure."""
    async with SessionLocal() as s:
        s.add(Client(id=CID, name="stage2-itest", status="active", timezone="UTC", mcp_token_ciphertext=encrypt_token(""),
                     mcp_token_prefix="(none)", mcp_permission_level="read_only"))
        await s.commit()
    async with SessionLocal() as s:
        card = await get_prediction_scorecard(client=await s.get(Client, CID), session=s)
    assert card["forecasts"] == [] and card["forecasts_by_horizon"] == [] and card["weekly_outlook"] == []
    page = card["page_decline_warnings"]
    assert page["predicted"] == 0 and page["n"] == 0 and page["hit_rate"] is None and all(b["n"] == 0 for b in page["bands"])
    assert card["unit"] == "percent" and card["notes"]
