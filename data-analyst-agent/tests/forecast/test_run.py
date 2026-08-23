"""Prompt 8 Option A: proves `page` runs through the exact SAME
_forecast_one code path as site/channel/device — no special-casing by
dimension_type anywhere in app/forecast/run.py, same forecaster registry,
same ForecastRun/ForecastPoint persistence, same confidence gate (now
unconditional on status=='ok', not gated on dimension_type=='site' — see
tests/forecast/test_confidence.py for the confidence-scoping proof itself).
compute_forecast_confidence is monkeypatched here — this file is a
boundary test of run.py's own control flow, not a re-test of confidence.py."""
import asyncio
from datetime import date

import pandas as pd

import app.forecast.run as run_mod
from app.db.models import ForecastPoint, ForecastRun, MetricCatalog
from app.forecast.base import ForecastPointResult, ForecastResult


class _RowsAll:
    def __init__(self, rows):
        self._rows = rows

    def all(self):
        return self._rows


class _FakeSession:
    """Serves the one MetricObservation history query _forecast_one issues,
    and stands in for add()/flush()/commit() well enough to inspect what
    was persisted — no real DB, matching this repo's no-fixtures convention."""

    def __init__(self, obs_rows):
        self._obs_rows = obs_rows
        self.added = []
        self.executed_stmts = []

    async def execute(self, stmt, *_a, **_kw):
        self.executed_stmts.append(stmt)
        return _RowsAll(self._obs_rows)

    def add(self, obj):
        self.added.append(obj)
        if isinstance(obj, ForecastRun) and obj.id is None:
            obj.id = 1  # simulates the real autoincrement PK a flush() would assign

    async def flush(self):
        pass


class _FakeForecaster:
    """Records the series/horizon it was called with — proves run.py hands
    a page's series through the identical call shape as any other
    dimension, with no page-specific branching."""

    def __init__(self, result):
        self.result = result
        self.calls = []

    def fit_predict(self, series, horizon):
        self.calls.append((series, horizon))
        return self.result


def _metric(cadence="daily"):
    return MetricCatalog(metric_key="gsc_clicks", cadence=cadence, is_forecastable=True)


def _install_fake_confidence(monkeypatch):
    calls = []

    async def fake_compute_forecast_confidence(_session, *, client_id, forecast_run, series):
        calls.append({"client_id": client_id, "dimension_type": forecast_run.dimension_type, "dimension_value": forecast_run.dimension_value})
        return 42, type("R", (), {"score": 0.9})()

    monkeypatch.setattr(run_mod, "compute_forecast_confidence", fake_compute_forecast_confidence)
    return calls


def test_page_dimension_uses_the_same_forecaster_call_shape_as_site(monkeypatch):
    confidence_calls = _install_fake_confidence(monkeypatch)
    rows = [(date(2026, 8, d), float(d)) for d in range(1, 15)]
    session = _FakeSession(rows)
    forecaster = _FakeForecaster(ForecastResult(status="ok", model="sarimax", points=[
        ForecastPointResult(target_period=date(2026, 8, 20), point_estimate=15.0, lower_bound=10.0, upper_bound=20.0),
    ]))

    asyncio.run(run_mod._forecast_one(session, client_id=1, metric=_metric(), dimension_type="page",
                                       dimension_value="https://x.com/p", forecaster=forecaster, horizon=7))

    # Same forecaster, same call shape (series, horizon) — no page-specific
    # branch anywhere in run.py.
    assert len(forecaster.calls) == 1
    series_arg, horizon_arg = forecaster.calls[0]
    assert horizon_arg == 7
    assert len(series_arg) == 14

    persisted_runs = [o for o in session.added if isinstance(o, ForecastRun)]
    assert len(persisted_runs) == 1
    assert persisted_runs[0].dimension_type == "page"
    assert persisted_runs[0].dimension_value == "https://x.com/p"
    assert persisted_runs[0].model == "sarimax"

    persisted_points = [o for o in session.added if isinstance(o, ForecastPoint)]
    assert len(persisted_points) == 1
    assert persisted_points[0].forecast_run_id == 1

    # Confidence is now computed for page too (previously gated to site only).
    assert len(confidence_calls) == 1
    assert confidence_calls[0]["dimension_type"] == "page"
    assert confidence_calls[0]["dimension_value"] == "https://x.com/p"


def test_site_dimension_still_computes_confidence_unchanged(monkeypatch):
    confidence_calls = _install_fake_confidence(monkeypatch)
    rows = [(date(2026, 8, d), float(d)) for d in range(1, 15)]
    session = _FakeSession(rows)
    forecaster = _FakeForecaster(ForecastResult(status="ok", model="sarimax", points=[]))

    asyncio.run(run_mod._forecast_one(session, client_id=1, metric=_metric(), dimension_type="site",
                                       dimension_value="__site__", forecaster=forecaster, horizon=7))

    assert len(confidence_calls) == 1
    assert confidence_calls[0]["dimension_type"] == "site"


def test_channel_and_device_dimensions_still_forecast_through_the_same_path(monkeypatch):
    # Regression proof (test requirements #2/#3): run.py has no
    # dimension_type branching, so channel/device already went through this
    # exact same _forecast_one path before page support was added, and
    # still do — this locks that in explicitly rather than by inference.
    for dim_type, dim_value in (("channel", "organic"), ("device", "MOBILE")):
        confidence_calls = _install_fake_confidence(monkeypatch)
        rows = [(date(2026, 8, d), float(d)) for d in range(1, 15)]
        session = _FakeSession(rows)
        forecaster = _FakeForecaster(ForecastResult(status="ok", model="sarimax", points=[]))

        asyncio.run(run_mod._forecast_one(session, client_id=1, metric=_metric(), dimension_type=dim_type,
                                           dimension_value=dim_value, forecaster=forecaster, horizon=7))

        persisted_runs = [o for o in session.added if isinstance(o, ForecastRun)]
        assert persisted_runs[0].dimension_type == dim_type
        assert persisted_runs[0].dimension_value == dim_value
        assert confidence_calls[0]["dimension_type"] == dim_type


def test_insufficient_status_persists_no_meaningless_forecast_and_skips_confidence(monkeypatch):
    confidence_calls = _install_fake_confidence(monkeypatch)
    session = _FakeSession([])  # no observations at all for this sparse/new page
    forecaster = _FakeForecaster(ForecastResult(status="insufficient-data", model=None, points=None))

    asyncio.run(run_mod._forecast_one(session, client_id=1, metric=_metric(), dimension_type="page",
                                       dimension_value="https://x.com/sparse", forecaster=forecaster, horizon=7))

    persisted_runs = [o for o in session.added if isinstance(o, ForecastRun)]
    assert persisted_runs[0].status == "insufficient-data"
    persisted_points = [o for o in session.added if isinstance(o, ForecastPoint)]
    assert persisted_points == []  # no fabricated points for a run with no real fit
    assert confidence_calls == []  # never scored — nothing to score confidence on


def test_metric_observation_query_is_scoped_to_the_given_client_and_dimension(monkeypatch):
    """Multi-tenant safety: the one query _forecast_one issues must filter
    by this exact client_id/dimension_type/dimension_value — never a
    cross-client or cross-dimension read."""
    _install_fake_confidence(monkeypatch)
    session = _FakeSession([(date(2026, 8, 1), 5.0)])
    forecaster = _FakeForecaster(ForecastResult(status="insufficient-data"))

    asyncio.run(run_mod._forecast_one(session, client_id=99, metric=_metric(), dimension_type="page",
                                       dimension_value="https://x.com/p", forecaster=forecaster, horizon=7))

    compiled = str(session.executed_stmts[0].compile(compile_kwargs={"literal_binds": True}))
    assert "client_id = 99" in compiled
    assert "dimension_type = 'page'" in compiled
    assert "dimension_value = 'https://x.com/p'" in compiled
