"""Prompt 8 Option A, test requirement #13 ('page data cannot cross tenant
boundaries'): dimension_values_for (app/db/dimension_lookup.py) is the
single place run_forecasts/run_stats/run_anomaly_detection all discover
which real page URLs (or channel/device values) exist for a dimension —
this proves its query is always scoped to the given client_id, so one
client's forecasting/stats pass can never enumerate or read another
client's pages. Unmodified this session; this locks in existing,
already-correct behavior."""
import asyncio

from app.db.dimension_lookup import dimension_values_for


class _ScalarsAll:
    def __init__(self, rows):
        self._rows = rows

    def scalars(self):
        return self

    def all(self):
        return self._rows

    def group_by(self, *_a, **_kw):
        return self

    def having(self, *_a, **_kw):
        return self


class _CapturingSession:
    def __init__(self, rows):
        self._rows = rows
        self.captured = None

    async def execute(self, stmt, *_a, **_kw):
        self.captured = stmt
        return _ScalarsAll(self._rows)


def test_site_dimension_never_issues_a_query_at_all():
    session = _CapturingSession(["https://x.com/should-not-be-returned"])
    values = asyncio.run(dimension_values_for(session, client_id=1, metric_key="gsc_clicks", dimension_type="site"))
    assert values == ["__site__"]
    assert session.captured is None  # short-circuited before any query — nothing to scope


def test_page_dimension_query_is_scoped_to_the_given_client_id():
    session = _CapturingSession(["https://x.com/a", "https://x.com/b"])
    values = asyncio.run(dimension_values_for(session, client_id=42, metric_key="gsc_clicks", dimension_type="page"))
    assert values == ["https://x.com/a", "https://x.com/b"]
    compiled = str(session.captured.compile(compile_kwargs={"literal_binds": True}))
    assert "client_id = 42" in compiled
    assert "dimension_type = 'page'" in compiled
    assert "metric_key = 'gsc_clicks'" in compiled
