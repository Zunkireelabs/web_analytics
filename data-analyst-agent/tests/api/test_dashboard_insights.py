"""Focused tests for _recent_insights (app/api/routes/dashboard.py) — the
query GET /clients/{client_id}/insights was added to expose on its own
(previously only reachable bundled inside GET /dashboard/{client_id}).

server/job.js's nightly runAnalystSyncForAllSites calls this exact route
(via fetchAnalystInsights) to turn eligible insights into Action Center
recommendations through analyst-seo-mapping.js's seoDraftEligibility, which
mirrors _eligibility in app/investigations/drafts.py field-for-field — so the
shape asserted here (id, metric_key, insight_type, period_start as an ISO
date string, evidence, dimension_type, dimension_value) is a real
cross-service contract, not incidental.

No test harness/DB fixtures exist anywhere else in this repo (see
tests/investigations/test_drafts.py's own docstring) — same fake-session
approach here, extended with a `.scalars().all()` result shape since this
query returns a list rather than a single row.
"""
import asyncio
from datetime import date, datetime, timezone

from app.api.routes.dashboard import _recent_insights
from app.db.models import AnalystRecommendations, Insight


def _insight(*, id=1, metric_key="gsc_impressions", period_start=date(2026, 8, 18)) -> Insight:
    return Insight(
        id=id, client_id=1, metric_key=metric_key, dimension_type="page",
        dimension_value="https://example.com/page", period_start=period_start,
        insight_type="trend_shift", severity="high", evidence={"pct_change": -30},
        generated_at=datetime(2026, 8, 19, tzinfo=timezone.utc),
    )


def _recommendation(*, insight_id, status="new") -> AnalystRecommendations:
    return AnalystRecommendations(
        id=99, client_id=1, insight_id=insight_id, priority="high",
        recommendation_text="Fix it", root_cause_text="Because", narration_status="ok", status=status,
    )


class _ScalarsResult:
    def __init__(self, rows):
        self._rows = rows

    def scalars(self):
        return self

    def all(self):
        return self._rows


class _FakeSession:
    """Serves the two session.execute(select(...)) calls _recent_insights
    makes in order: Insight rows, then AnalystRecommendations rows."""

    def __init__(self, insight_rows, rec_rows):
        self._results = iter([_ScalarsResult(insight_rows), _ScalarsResult(rec_rows)])

    async def execute(self, *_a, **_kw):
        return next(self._results)


def test_returns_the_cross_service_contract_shape_json_analyst_seo_mapping_needs():
    insight = _insight()
    session = _FakeSession([insight], [])

    result = asyncio.run(_recent_insights(session, client_id=1))

    assert result == [{
        "id": 1, "metric_key": "gsc_impressions", "insight_type": "trend_shift", "severity": "high",
        "period_start": "2026-08-18", "evidence": {"pct_change": -30},
        "dimension_type": "page", "dimension_value": "https://example.com/page",
        "recommendation_id": None, "root_cause": None, "recommendation": None, "narration_status": None,
    }]


def test_no_second_query_issued_when_there_are_no_insights():
    session = _FakeSession([], [])
    # A session that only serves ONE result would raise StopIteration if a
    # second execute() were issued for an empty insights_rows — proves the
    # "one query for every recommendation instead of one per insight"
    # optimization still short-circuits correctly.
    session._results = iter([_ScalarsResult([])])

    result = asyncio.run(_recent_insights(session, client_id=1))
    assert result == []


def test_excludes_an_insight_whose_recommendation_was_resolved_or_dismissed():
    kept = _insight(id=1)
    resolved = _insight(id=2)
    dismissed = _insight(id=3)
    session = _FakeSession(
        [kept, resolved, dismissed],
        [_recommendation(insight_id=2, status="resolved"), _recommendation(insight_id=3, status="dismissed")],
    )

    result = asyncio.run(_recent_insights(session, client_id=1))

    assert [r["id"] for r in result] == [1]


def test_includes_an_insight_whose_recommendation_is_still_open():
    insight = _insight(id=1)
    session = _FakeSession([insight], [_recommendation(insight_id=1, status="new")])

    result = asyncio.run(_recent_insights(session, client_id=1))

    assert len(result) == 1
    assert result[0]["recommendation_id"] == 99
    assert result[0]["root_cause"] == "Because"
