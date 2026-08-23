"""Prompt 8 Option A, test requirement #9 ('page forecasts participate in
forecast accuracy'): app/forecast/accuracy.py::_evaluate_client already
joins ForecastPoint+ForecastRun for the client with no dimension_type
filter at all — proving a page-dimension forecast point is evaluated
exactly like a site one, with no separate accuracy path. This locks that
in with a test; the function itself is unmodified this session."""
import asyncio
from datetime import date

from app.db.models import ForecastPoint, ForecastRun
import app.forecast.accuracy as accuracy_mod


class _ScalarsAll:
    def __init__(self, rows):
        self._rows = rows

    def scalars(self):
        return self

    def all(self):
        return self._rows


class _PlainAll:
    def __init__(self, rows):
        self._rows = rows

    def all(self):
        return self._rows


class _QueueSession:
    def __init__(self, results):
        self._results = list(results)

    async def execute(self, *_a, **_kw):
        return self._results.pop(0)

    async def scalar(self, *_a, **_kw):
        return self._results.pop(0)


def test_a_page_dimension_forecast_point_is_evaluated_into_forecast_accuracy(monkeypatch):
    added = []

    class _FakeSession(_QueueSession):
        def add(self, obj):
            added.append(obj)

    run = ForecastRun(id=1, client_id=1, metric_key="gsc_clicks", dimension_type="page",
                       dimension_value="https://x.com/p", cadence="daily", status="ok")
    point = ForecastPoint(id=1, forecast_run_id=1, target_period=date(2026, 8, 1), point_estimate=8.0, lower_bound=6.0, upper_bound=10.0)

    session = _FakeSession([
        _PlainAll([]),                 # already_evaluated forecast_point_ids
        _PlainAll([(point, run)]),     # ForecastPoint JOIN ForecastRun for this client
        9.0,                           # the realized MetricObservation.value for that (page) target_period
    ])

    asyncio.run(accuracy_mod._evaluate_client(session, client_id=1))

    assert len(added) == 1
    accuracy_row = added[0]
    assert accuracy_row.metric_key == "gsc_clicks"
    assert accuracy_row.forecast_point_id == 1
    assert accuracy_row.predicted_value == 8.0
    assert accuracy_row.actual_value == 9.0
    # Migration 0038 added dimension_type/dimension_value to ForecastAccuracy
    # so get_rolling_accuracy can be scoped per dimension (see
    # app/forecast/confidence.py) instead of blending a page's accuracy
    # history into the site-wide average — _evaluate_client stamps both from
    # the ForecastRun the point belongs to.
    assert accuracy_row.dimension_type == "page"
    assert accuracy_row.dimension_value == "https://x.com/p"
