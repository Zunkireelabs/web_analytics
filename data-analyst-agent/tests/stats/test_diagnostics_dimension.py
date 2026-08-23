"""Prompt 8 Option A: proves _forecast_backtest_pairs (and the two
diagnostics built on it, compute_prediction_error/compute_r_squared) are
scoped to the CALLER'S given (dimension_type, dimension_value) rather than
hardcoded to site — the one genuine gap found in the shared forecasting
architecture's confidence path. Default params must reproduce the exact
prior site-only behavior (compute_all_diagnostics' dashboard panel calls
with no dimension args at all)."""
import asyncio
from datetime import date

from app.stats.diagnostics import _forecast_backtest_pairs, compute_prediction_error


class _ScalarsAll:
    def __init__(self, rows):
        self._rows = rows

    def scalars(self):
        return self

    def all(self):
        return self._rows


class _RowsAll:
    def __init__(self, rows):
        self._rows = rows

    def all(self):
        return self._rows


class _CapturingSession:
    """Records every statement passed to execute() so tests can assert on
    its compiled WHERE clause, and serves canned results in call order."""

    def __init__(self, results):
        self.captured = []
        self._results = list(results)

    async def execute(self, stmt, *_a, **_kw):
        self.captured.append(stmt)
        return self._results.pop(0)


def _compiled(stmt) -> str:
    return str(stmt.compile(compile_kwargs={"literal_binds": True}))


def test_default_params_backtest_the_site_dimension_exactly_as_before():
    session = _CapturingSession([
        _ScalarsAll([1]),
        _RowsAll([(date(2026, 8, 1), 10.0), (date(2026, 8, 2), 11.0), (date(2026, 8, 3), 12.0)]),
        _RowsAll([(date(2026, 8, 1), 10.5), (date(2026, 8, 2), 10.5), (date(2026, 8, 3), 12.5)]),
    ])

    actuals, predicted, reason = asyncio.run(
        _forecast_backtest_pairs(session, client_id=1, metric_key="gsc_clicks")
    )

    assert reason is None
    assert len(actuals) == 3
    run_query_sql = _compiled(session.captured[0])
    assert "dimension_type = 'site'" in run_query_sql
    assert "dimension_value = '__site__'" in run_query_sql
    observation_query_sql = _compiled(session.captured[2])
    assert "dimension_type = 'site'" in observation_query_sql
    assert "dimension_value = '__site__'" in observation_query_sql


def test_page_dimension_backtests_against_its_own_series_not_site():
    session = _CapturingSession([
        _ScalarsAll([7]),
        _RowsAll([(date(2026, 8, 1), 5.0), (date(2026, 8, 2), 6.0), (date(2026, 8, 3), 7.0)]),
        _RowsAll([(date(2026, 8, 1), 5.5), (date(2026, 8, 2), 5.5), (date(2026, 8, 3), 7.5)]),
    ])

    actuals, predicted, reason = asyncio.run(
        _forecast_backtest_pairs(
            session, client_id=1, metric_key="gsc_clicks",
            dimension_type="page", dimension_value="https://x.com/p",
        )
    )

    assert reason is None
    run_query_sql = _compiled(session.captured[0])
    assert "dimension_type = 'page'" in run_query_sql
    assert "dimension_value = 'https://x.com/p'" in run_query_sql
    observation_query_sql = _compiled(session.captured[2])
    assert "dimension_type = 'page'" in observation_query_sql
    assert "dimension_value = 'https://x.com/p'" in observation_query_sql
    # Never a literal 'site'/'__site__' leaking into a page-scoped query.
    assert "dimension_type = 'site'" not in run_query_sql
    assert "dimension_value = '__site__'" not in observation_query_sql


def test_compute_prediction_error_passes_dimension_through():
    session = _CapturingSession([
        _ScalarsAll([]),  # no forecast runs yet for this (metric, dimension) — real insufficient-data
    ])

    result = asyncio.run(
        compute_prediction_error(
            session, client_id=1, metric_key="gsc_impressions",
            dimension_type="page", dimension_value="https://x.com/other",
        )
    )

    assert result.status == "insufficient-data"
    run_query_sql = _compiled(session.captured[0])
    assert "dimension_type = 'page'" in run_query_sql
    assert "dimension_value = 'https://x.com/other'" in run_query_sql
