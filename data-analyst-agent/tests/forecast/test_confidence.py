"""Focused tests proving app/forecast/confidence.py's compute_forecast_confidence
actually consults get_investigation_outcome_reliability (Part 6's 'prediction
-> actual outcome -> accuracy -> confidence adjustment' wiring) and passes it
through to compute_confidence's components, using the SAME
historical_forecast_accuracy pattern already established for
app/forecast/accuracy.py. All collaborators (which do real DB/stats work)
are monkeypatched — this is a boundary test of the wiring, not a re-test of
compute_prediction_error/get_rolling_accuracy/compute_confidence
themselves."""
import asyncio
from dataclasses import dataclass
from unittest.mock import AsyncMock

import pandas as pd

import app.forecast.confidence as confidence_mod
from app.db.models import ForecastRun


@dataclass
class _Error:
    status: str
    value: float | None


def _series():
    idx = pd.date_range("2026-01-01", periods=10, freq="D")
    return pd.Series(range(10), index=idx)


def _forecast_run(dimension_type="site", dimension_value="__site__"):
    return ForecastRun(id=1, client_id=1, metric_key="gsc_clicks", dimension_type=dimension_type, dimension_value=dimension_value, cadence="daily", status="ok")


def _wire(monkeypatch, *, outcome_reliability, captured_components):
    monkeypatch.setattr(confidence_mod, "compute_prediction_error", AsyncMock(return_value=_Error(status="insufficient-data", value=None)))
    monkeypatch.setattr(confidence_mod, "get_rolling_accuracy", AsyncMock(return_value={"status": "insufficient-data", "avg_abs_pct_error": None}))
    monkeypatch.setattr(confidence_mod, "get_investigation_outcome_reliability", AsyncMock(return_value=outcome_reliability))

    async def fake_compute_confidence(_session, *, client_id, subject_type, subject_id, components):
        captured_components.update(components)
        return 99, object()

    monkeypatch.setattr(confidence_mod, "compute_confidence", fake_compute_confidence)


def test_ok_investigation_outcome_reliability_flows_into_confidence_components(monkeypatch):
    captured = {}
    _wire(monkeypatch, outcome_reliability={"status": "ok", "evaluated_outcomes": 5, "reliability": 0.8}, captured_components=captured)

    asyncio.run(confidence_mod.compute_forecast_confidence(
        object(), client_id=1, forecast_run=_forecast_run(), series=_series(),
    ))

    assert captured["investigation_outcome_reliability"] == 0.8


def test_insufficient_data_investigation_outcome_reliability_is_none_not_zero(monkeypatch):
    captured = {}
    _wire(monkeypatch, outcome_reliability={"status": "insufficient-data", "evaluated_outcomes": 1, "reliability": None}, captured_components=captured)

    asyncio.run(confidence_mod.compute_forecast_confidence(
        object(), client_id=1, forecast_run=_forecast_run(), series=_series(),
    ))

    assert captured["investigation_outcome_reliability"] is None, "no evaluated outcomes must never read as a fabricated 0.0"


# Prompt 8 Option A: compute_forecast_confidence must backtest a page (or
# channel/device) forecast_run against ITS OWN dimension, never silently
# borrowing the site series — previously this whole function was only ever
# invoked for dimension_type == 'site' runs; now it's invoked for every
# dimension and relies on compute_prediction_error actually being scoped.
def test_page_dimension_forecast_run_backtests_against_its_own_dimension_not_site(monkeypatch):
    captured = {}
    _wire(monkeypatch, outcome_reliability={"status": "insufficient-data", "evaluated_outcomes": 0, "reliability": None}, captured_components=captured)

    asyncio.run(confidence_mod.compute_forecast_confidence(
        object(), client_id=1,
        forecast_run=_forecast_run(dimension_type="page", dimension_value="https://x.com/p"),
        series=_series(),
    ))

    call = confidence_mod.compute_prediction_error.call_args
    assert call.kwargs["dimension_type"] == "page"
    assert call.kwargs["dimension_value"] == "https://x.com/p"


def test_site_dimension_forecast_run_still_backtests_site(monkeypatch):
    captured = {}
    _wire(monkeypatch, outcome_reliability={"status": "insufficient-data", "evaluated_outcomes": 0, "reliability": None}, captured_components=captured)

    asyncio.run(confidence_mod.compute_forecast_confidence(
        object(), client_id=1, forecast_run=_forecast_run(), series=_series(),
    ))

    call = confidence_mod.compute_prediction_error.call_args
    assert call.kwargs["dimension_type"] == "site"
    assert call.kwargs["dimension_value"] == "__site__"
