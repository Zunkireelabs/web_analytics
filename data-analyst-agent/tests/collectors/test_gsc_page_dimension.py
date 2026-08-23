"""Prompt 8 Option A: proves the canonical page identity flowing into
MetricObservation.dimension_value is the exact, unmodified real GSC page
URL already used by gsc_query_page/page_inventory Node-side — never a
synthetic/derived page ID invented in this collector. Also proves the
zero-gap-tolerance admission gate (a page must hold a real 14-consecutive-
day top-50 streak) still holds, since that's what keeps forecasting from
ever running on a fabricated/sparse series."""
import asyncio
from datetime import date

from app.collectors.gsc_page_dimension import STABILITY_WINDOW_DAYS, GscPageDimensionCollector
from app.db.models import PageQueryObservation


class _Client:
    id = 1


def _obs(page_url: str, day: date, *, clicks=5, impressions=50, ctr=0.1, position=8.0):
    return PageQueryObservation(
        client_id=1, dimension_type="page", dimension_value=page_url, period_start=day,
        clicks=clicks, impressions=impressions, ctr=ctr, position=position,
    )


class _RowsResult:
    def __init__(self, rows):
        self._rows = rows

    def scalars(self):
        return self

    def all(self):
        return self._rows


class _FakeSession2:
    """Serves scalar() for the max-day lookup and execute() for the range
    query, in that order."""

    def __init__(self, latest_day, rows):
        self._latest_day = latest_day
        self._rows = rows

    async def scalar(self, *_a, **_kw):
        return self._latest_day

    async def execute(self, *_a, **_kw):
        return _RowsResult(self._rows)


def test_canonical_page_url_passes_through_unmodified_as_the_dimension_value():
    latest = date(2026, 8, 17)
    real_url = "https://example.com/blog/real-canonical-post"
    days = [latest - __import__("datetime").timedelta(days=i) for i in range(STABILITY_WINDOW_DAYS)]
    rows = [_obs(real_url, d) for d in days]
    session = _FakeSession2(latest, rows)

    observations = asyncio.run(GscPageDimensionCollector().collect(
        session=session, client=_Client(), mcp=None, window_start=days[-1], window_end=latest,
    ))

    assert observations, "a genuinely unbroken 14-day streak must be admitted"
    values = {o.dimension_value for o in observations}
    assert values == {real_url}  # the exact same string, no transformation/synthetic ID
    for o in observations:
        assert o.dimension_type == "page"


def test_a_page_with_a_gap_in_its_streak_is_excluded_entirely():
    latest = date(2026, 8, 17)
    real_url = "https://example.com/blog/gappy-post"
    days = [latest - __import__("datetime").timedelta(days=i) for i in range(STABILITY_WINDOW_DAYS)]
    rows = [_obs(real_url, d) for d in days if d != days[3]]  # drop one day — breaks the streak
    session = _FakeSession2(latest, rows)

    observations = asyncio.run(GscPageDimensionCollector().collect(
        session=session, client=_Client(), mcp=None, window_start=days[-1], window_end=latest,
    ))

    assert observations == []  # any gap at all disqualifies — no partial/interpolated series


def test_ctr_and_position_pass_through_unmodified_no_alternative_formula():
    # gsc_ctr/gsc_position values already arrive on PageQueryObservation
    # computed via GSC's own page-dimension API pull (server/ingest/gsc.js
    # -> queryApi(['page']) Node-side), which is exactly SUM(clicks)/
    # SUM(impressions) for CTR and the impressions-weighted average
    # position GSC itself defines. This collector must never recompute or
    # substitute a different number for these two metrics.
    latest = date(2026, 8, 17)
    real_url = "https://example.com/blog/real-canonical-post"
    days = [latest - __import__("datetime").timedelta(days=i) for i in range(STABILITY_WINDOW_DAYS)]
    rows = [_obs(real_url, d, clicks=12, impressions=240, ctr=0.05, position=6.25) for d in days]
    session = _FakeSession2(latest, rows)

    observations = asyncio.run(GscPageDimensionCollector().collect(
        session=session, client=_Client(), mcp=None, window_start=days[-1], window_end=latest,
    ))

    ctr_values = {o.value for o in observations if o.metric_key == "gsc_ctr"}
    position_values = {o.value for o in observations if o.metric_key == "gsc_position"}
    assert ctr_values == {0.05}
    assert position_values == {6.25}


def test_no_pages_yet_returns_no_observations():
    session = _FakeSession2(None, [])
    observations = asyncio.run(GscPageDimensionCollector().collect(
        session=session, client=_Client(), mcp=None, window_start=date(2026, 8, 1), window_end=date(2026, 8, 17),
    ))
    assert observations == []
