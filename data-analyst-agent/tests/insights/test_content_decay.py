"""Tests for _content_decay_insights (app/insights/engine.py) — the
content_decay classification layer over already-computed MetricPeriodStats
rows (deltas.py's nightly WoW/MoM stats engine). No new detector, no new
statistical method: this only tests the stricter, sustained-decline
classification rule. Follows this repo's established "fake queue session,
monkeypatch the real DB-writing collaborator" test convention (see
tests/investigations/test_drafts.py's _TwoCallSession)."""
import asyncio
from datetime import date

from app.db.models import MetricPeriodStats
import app.insights.engine as engine_mod


def _wow(period_end, pct_change, dimension_value="https://x.com/p", metric_key="gsc_clicks"):
    return MetricPeriodStats(
        id=1, client_id=1, metric_key=metric_key, dimension_type="page", dimension_value=dimension_value,
        period_type="wow", period_end=period_end, pct_change=pct_change,
    )


def _mom(pct_change, dimension_value="https://x.com/p", metric_key="gsc_clicks", period_end=date(2026, 8, 17)):
    return MetricPeriodStats(
        id=2, client_id=1, metric_key=metric_key, dimension_type="page", dimension_value=dimension_value,
        period_type="mom", period_end=period_end, pct_change=pct_change,
    )


class _Scalars:
    def __init__(self, rows):
        self._rows = rows

    def scalars(self):
        return self

    def all(self):
        return self._rows


class _QueueSession:
    """Serves session.execute(select(...)) calls in the exact order
    _content_decay_insights issues them, one result per call. Per
    CONTENT_DECAY_METRICS entry, that's always exactly two calls — the WoW
    query, then the batch MoM query (both .scalars().all()) — the MoM batch
    is unconditional per metric_key now, not a per-qualifying-page lookup."""

    def __init__(self, results):
        self._results = list(results)

    async def execute(self, *_a, **_kw):
        return self._results.pop(0)


def _install_capture(monkeypatch):
    captured = []

    async def fake_replace_insight(_session, **kw):
        captured.append(kw)

    monkeypatch.setattr(engine_mod, "_replace_insight", fake_replace_insight)
    return captured


def test_three_consecutive_qualifying_weeks_with_mom_corroboration_fires(monkeypatch):
    captured = _install_capture(monkeypatch)
    wow_rows = [_wow(date(2026, 8, 17), -20), _wow(date(2026, 8, 10), -18), _wow(date(2026, 8, 3), -16)]
    session = _QueueSession([
        _Scalars(wow_rows),          # gsc_clicks wow query
        _Scalars([_mom(-25)]),       # gsc_clicks mom batch query
        _Scalars([]),                # gsc_impressions wow query (no data)
        _Scalars([]),                # gsc_impressions mom batch query
    ])

    asyncio.run(engine_mod._content_decay_insights(session, client_id=1))

    assert len(captured) == 1
    kw = captured[0]
    assert kw["insight_type"] == "content_decay"
    assert kw["dimension_type"] == "page"
    assert kw["dimension_value"] == "https://x.com/p"
    assert kw["evidence"]["wow_pct_changes"] == [-20.0, -18.0, -16.0]
    assert kw["evidence"]["mom_pct_change"] == -25.0
    assert kw["evidence"]["consecutive_weeks"] == 3


def test_a_single_bad_week_among_three_does_not_fire(monkeypatch):
    captured = _install_capture(monkeypatch)
    # Middle week only -5% — doesn't independently clear the 15% wow bar.
    wow_rows = [_wow(date(2026, 8, 17), -20), _wow(date(2026, 8, 10), -5), _wow(date(2026, 8, 3), -16)]
    session = _QueueSession([_Scalars(wow_rows), _Scalars([]), _Scalars([]), _Scalars([])])

    asyncio.run(engine_mod._content_decay_insights(session, client_id=1))

    assert captured == []


def test_only_two_weekly_snapshots_is_insufficient_history(monkeypatch):
    captured = _install_capture(monkeypatch)
    wow_rows = [_wow(date(2026, 8, 17), -20), _wow(date(2026, 8, 10), -18)]
    session = _QueueSession([_Scalars(wow_rows), _Scalars([]), _Scalars([]), _Scalars([])])

    asyncio.run(engine_mod._content_decay_insights(session, client_id=1))

    assert captured == []


def test_a_gap_between_snapshots_is_treated_as_missing_data_not_confirmed_decline(monkeypatch):
    captured = _install_capture(monkeypatch)
    # 14-day gap between the middle and oldest snapshot instead of 7.
    wow_rows = [_wow(date(2026, 8, 17), -20), _wow(date(2026, 8, 10), -18), _wow(date(2026, 7, 27), -16)]
    session = _QueueSession([_Scalars(wow_rows), _Scalars([]), _Scalars([]), _Scalars([])])

    asyncio.run(engine_mod._content_decay_insights(session, client_id=1))

    assert captured == []


def test_qualifying_wow_streak_without_mom_corroboration_does_not_fire(monkeypatch):
    captured = _install_capture(monkeypatch)
    wow_rows = [_wow(date(2026, 8, 17), -20), _wow(date(2026, 8, 10), -18), _wow(date(2026, 8, 3), -16)]
    session = _QueueSession([
        _Scalars(wow_rows),
        _Scalars([]),  # no MoM snapshot yet — insufficient history, not a false negative
        _Scalars([]),
        _Scalars([]),
    ])

    asyncio.run(engine_mod._content_decay_insights(session, client_id=1))

    assert captured == []


def test_qualifying_wow_streak_with_a_recovering_mom_does_not_fire(monkeypatch):
    captured = _install_capture(monkeypatch)
    wow_rows = [_wow(date(2026, 8, 17), -20), _wow(date(2026, 8, 10), -18), _wow(date(2026, 8, 3), -16)]
    session = _QueueSession([
        _Scalars(wow_rows),
        _Scalars([_mom(-5)]),  # MoM only down 5% — doesn't clear the 20% mom bar
        _Scalars([]),
        _Scalars([]),
    ])

    asyncio.run(engine_mod._content_decay_insights(session, client_id=1))

    assert captured == []
