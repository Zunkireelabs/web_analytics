"""Prompt 8 Option A, test requirement #10 ('page forecast risk works'):
_forecast_risk_insights (app/insights/engine.py) was already made
dimension-aware in an earlier Phase 3 rewrite (see its own docstring), but
had no test locking that in. This proves a page-dimension ForecastRun's
projected decline produces a forecast_risk Insight keyed to that page —
not silently mislabeled/dropped as a site-level one, and not touched by
this round's changes (this file/function was not modified this session)."""
import asyncio
from datetime import date

from app.db.models import ForecastPoint, ForecastRun
import app.insights.engine as engine_mod


class _ScalarsAll:
    def __init__(self, rows):
        self._rows = rows

    def scalars(self):
        return self

    def all(self):
        return self._rows


class _QueueSession:
    """Serves session.execute(...) and session.scalar(...) calls in the
    exact order _forecast_risk_insights issues them."""

    def __init__(self, results):
        self._results = list(results)

    async def execute(self, *_a, **_kw):
        return self._results.pop(0)

    async def scalar(self, *_a, **_kw):
        return self._results.pop(0)


def _run(dimension_value="https://x.com/p"):
    return ForecastRun(
        id=1, client_id=1, metric_key="gsc_clicks", dimension_type="page", dimension_value=dimension_value,
        cadence="daily", status="ok", model="sarimax", generated_at=None,
    )


def test_page_dimension_forecast_run_produces_a_page_keyed_forecast_risk_insight(monkeypatch):
    captured = []

    async def fake_replace_insight(_session, **kw):
        captured.append(kw)

    monkeypatch.setattr(engine_mod, "_replace_insight", fake_replace_insight)

    run = _run()
    point = ForecastPoint(id=1, forecast_run_id=1, target_period=date(2026, 8, 25), point_estimate=7.0, lower_bound=5.0, upper_bound=9.0)

    session = _QueueSession([
        _ScalarsAll([run]),    # ForecastRun.where(status='ok') scan
        _ScalarsAll([point]),  # ForecastPoint.where(forecast_run_id in [...]) scan
        10.0,                  # last_actual MetricObservation.value scalar for this exact (metric, page)
    ])

    asyncio.run(engine_mod._forecast_risk_insights(session, client_id=1))

    assert len(captured) == 1
    kw = captured[0]
    assert kw["insight_type"] == "forecast_risk"
    assert kw["dimension_type"] == "page"
    assert kw["dimension_value"] == "https://x.com/p"
    # (10 -> 7) is a 30% projected decline, comfortably past FORECAST_RISK_DECLINE_PCT (10%).
    assert kw["evidence"]["pct_projected_change"] < -10.0
