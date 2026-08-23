"""Focused tests for the run_draft_trigger decision boundary in
app/investigations/drafts.py: the priority gate (the SOLE action-selection
mechanism) and the on-demand scoring dependency resolution (the _ensure_*
helpers). A first revision of this trigger briefly added an independent
ImpactPrediction low/medium/high gate; it was removed after product review
(priority alone remains the action-selection mechanism) — see
'no_impact_prediction_gate_remains' below for the regression tests proving
that removal. No test harness/DB fixtures exist anywhere else in this repo
(no conftest.py, no pytest-asyncio dependency) — rather than bolt on new
test infrastructure for a scope this narrow, these tests exercise:

1. `_priority_decision` — a pure function over an already-fetched row. No
   DB/session/event loop needed.
2. The `_ensure_*` helpers — each tested in isolation with a two-call fake
   session (nothing persisted yet -> compute -> persisted), with the
   pre-existing, unmodified per-recommendation engine functions
   (`_estimate`/`_score`/`_predict`/`_priority_inputs`) monkeypatched out,
   since re-verifying THEIR internals is out of this change's scope.
   `_ensure_impact_prediction` is still exercised here — ImpactPrediction is
   still computed/persisted on demand for staff reporting (see
   app/api/routes/intelligence.py), it just no longer gates the decision.
3. `_try_trigger`'s end-to-end control flow, with `_latest_recommendation`,
   `_ensure_priority_ranking`, and `_ensure_impact_prediction` monkeypatched
   directly — this is the actual decision boundary this task changed, and
   testing it this way avoids re-simulating the whole ORM/session layer.
"""
import asyncio
from datetime import date, datetime, timezone
from unittest.mock import AsyncMock

from app.db.models import (
    AnalystRecommendations, Client, EffortEstimation, ImpactPrediction, Insight, Investigation,
    InvestigationEvent, OpportunityScore, RecommendationRanking,
)
from app.investigations import drafts
from app.investigations.drafts import (
    MIN_PRIORITY_SCORE_TO_TRIGGER, PriorityDecision,
    _ensure_effort_estimation, _ensure_impact_prediction, _ensure_opportunity_score, _ensure_priority_ranking,
    _eligibility, _generator_for_declining_page, _priority_decision, _try_trigger, run_draft_trigger,
)
from app.mcp_client.client import McpToolError


# ---------------------------------------------------------------------------
# fixtures / builders
# ---------------------------------------------------------------------------

def _ranking(*, status="ok", priority_score=None, rank=1) -> RecommendationRanking:
    return RecommendationRanking(
        id=1, client_id=1, recommendation_id=1, status=status, priority_score=priority_score, rank=rank,
        method_detail={},
    )


def _prediction(*, status="ok", magnitude=None, category="content") -> ImpactPrediction:
    return ImpactPrediction(
        id=1, client_id=1, recommendation_id=1, status=status, category=category,
        expected_impact_magnitude=magnitude, duration_min_weeks=4, duration_max_weeks=8, method_detail={},
    )


def _decline_insight(*, dimension_value="https://example.com/page", metric_key="gsc_impressions") -> Insight:
    # gsc_impressions (not gsc_clicks/gsc_ctr/gsc_position) is the default so
    # existing generic priority/impact/orchestration tests below stay on the
    # 'expand-content' branch of _generator_for_declining_page and don't
    # entangle with the generator-selection tests, which use their own
    # explicit metric_key per case.
    return Insight(
        id=1, client_id=1, metric_key=metric_key, dimension_type="page", dimension_value=dimension_value,
        period_start=date(2026, 8, 1), insight_type="trend_shift", severity="high",
        evidence={"pct_change": -30}, generated_at=datetime.now(timezone.utc),
    )


def _investigation() -> Investigation:
    return Investigation(
        id=42, client_id=1, metric_key="gsc_impressions", dimension_type="page", dimension_value="https://example.com/page",
        insight_type="trend_shift", severity="high", status="recommendation_generated",
        affected_metrics=[], evidence={}, source_insight_id=1,
    )


def _client() -> Client:
    return Client(id=1, mcp_token_ciphertext=b"token", status="active")


def _rec() -> AnalystRecommendations:
    return AnalystRecommendations(
        id=7, client_id=1, insight_id=1, priority="high", recommendation_text="fix it",
        investigation_id=42, generated_at=datetime.now(timezone.utc),
    )


# ---------------------------------------------------------------------------
# _priority_decision — pure predicate (unchanged from Prompt 1, kept as a
# regression guard now that _try_trigger's plumbing around it changed)
# ---------------------------------------------------------------------------

def test_sufficiently_strong_priority_triggers():
    strong = MIN_PRIORITY_SCORE_TO_TRIGGER + 0.05
    decision = _priority_decision(_ranking(priority_score=strong))
    assert decision.should_act is True


def test_insufficient_priority_does_not_trigger():
    weak = MIN_PRIORITY_SCORE_TO_TRIGGER - 0.05
    decision = _priority_decision(_ranking(priority_score=weak))
    assert decision.should_act is False


def test_no_ranking_row_fails_closed():
    assert _priority_decision(None).should_act is False


def test_insufficient_data_ranking_status_fails_closed():
    decision = _priority_decision(_ranking(status="insufficient-data", priority_score=None))
    assert decision.should_act is False


# ---------------------------------------------------------------------------
# _generator_for_declining_page — regression tests for the Prompt 4 audit
# defect: this trigger previously hardcoded 'expand-content' for every
# gsc_* metric, while server/agents/lib/analyst-seo-mapping.js's
# generatorForDecliningPage differentiates by metric_key. Since
# getDraftByFindingId's idempotency check matches on finding_id alone (not
# generator_id), the two subsystems disagreeing on which generator a
# finding maps to could let one silently and permanently suppress the
# other's correct draft for the same finding. These tests pin the mapping
# to match Node's exactly, metric_key by metric_key.
# ---------------------------------------------------------------------------

def test_ctr_decline_maps_to_meta_title():
    insight = _decline_insight(metric_key="gsc_ctr")
    generator_id, params = _generator_for_declining_page(insight)
    assert generator_id == "meta-title"
    assert params == {"page": "https://example.com/page", "query": "https://example.com/page"}


def test_clicks_decline_maps_to_meta_title():
    insight = _decline_insight(metric_key="gsc_clicks")
    generator_id, params = _generator_for_declining_page(insight)
    assert generator_id == "meta-title"


def test_position_decline_maps_to_qa_content():
    insight = _decline_insight(metric_key="gsc_position")
    generator_id, params = _generator_for_declining_page(insight)
    assert generator_id == "qa-content"
    assert params == {"page": "https://example.com/page"}


def test_impressions_decline_maps_to_expand_content():
    insight = _decline_insight(metric_key="gsc_impressions")
    generator_id, params = _generator_for_declining_page(insight)
    assert generator_id == "expand-content"
    assert params == {"page": "https://example.com/page"}


def test_eligibility_selects_the_correct_generator_end_to_end():
    # _eligibility (not just the helper) must actually use the mapping.
    for metric_key, expected_generator in [
        ("gsc_ctr", "meta-title"), ("gsc_clicks", "meta-title"),
        ("gsc_position", "qa-content"), ("gsc_impressions", "expand-content"),
    ]:
        action = _eligibility(_decline_insight(metric_key=metric_key))
        assert action is not None
        assert action["generator_id"] == expected_generator


# ---------------------------------------------------------------------------
# _ensure_* helpers — dependency resolution in isolation. Each helper makes
# exactly two session.execute(select(...)) calls when nothing is persisted
# yet (none found -> compute -> re-fetch), one when something already is.
# ---------------------------------------------------------------------------

class _FakeResult:
    def __init__(self, scalar=None):
        self._scalar = scalar

    def scalar_one_or_none(self):
        return self._scalar


class _TwoCallSession:
    """Serves exactly the sequence of session.execute(select(...)) calls one
    _ensure_* helper makes: `results` in call order."""

    def __init__(self, results):
        self._results = iter(results)
        self.flush_count = 0

    async def execute(self, *_a, **_kw):
        return next(self._results)

    async def flush(self):
        self.flush_count += 1

    def add(self, _obj):
        pass


def test_ensure_effort_estimation_returns_existing_without_computing(monkeypatch):
    engine_mock = AsyncMock()
    monkeypatch.setattr(drafts.effort_estimation_engine, "_estimate", engine_mock)

    existing = EffortEstimation(id=1, client_id=1, recommendation_id=7, status="ok", effort_level=3)
    session = _TwoCallSession([_FakeResult(scalar=existing)])

    result = asyncio.run(_ensure_effort_estimation(session, _client(), _rec()))

    assert result is existing
    engine_mock.assert_not_called()


def test_ensure_effort_estimation_computes_on_demand_when_missing(monkeypatch):
    engine_mock = AsyncMock()
    monkeypatch.setattr(drafts.effort_estimation_engine, "_estimate", engine_mock)

    computed = EffortEstimation(id=2, client_id=1, recommendation_id=7, status="ok", effort_level=3)
    session = _TwoCallSession([_FakeResult(scalar=None), _FakeResult(scalar=computed)])

    result = asyncio.run(_ensure_effort_estimation(session, _client(), _rec()))

    assert result is computed
    engine_mock.assert_awaited_once()
    assert session.flush_count == 1


def test_ensure_opportunity_score_computes_on_demand_when_missing(monkeypatch):
    engine_mock = AsyncMock()
    monkeypatch.setattr(drafts.opportunity_scoring_engine, "_score", engine_mock)

    computed = OpportunityScore(id=2, client_id=1, recommendation_id=7, status="ok", opportunity_score=60.0, factors={}, method_detail={})
    session = _TwoCallSession([_FakeResult(scalar=None), _FakeResult(scalar=computed)])

    result = asyncio.run(_ensure_opportunity_score(session, _client(), _rec()))

    assert result is computed
    engine_mock.assert_awaited_once()


def test_ensure_impact_prediction_computes_on_demand_when_missing(monkeypatch):
    engine_mock = AsyncMock()
    monkeypatch.setattr(drafts.impact_prediction_engine, "_predict", engine_mock)

    computed = _prediction(magnitude="medium")
    session = _TwoCallSession([_FakeResult(scalar=None), _FakeResult(scalar=computed)])

    result = asyncio.run(_ensure_impact_prediction(session, _client(), _rec()))

    assert result is computed
    engine_mock.assert_awaited_once()


def test_ensure_impact_prediction_returns_existing_without_computing(monkeypatch):
    engine_mock = AsyncMock()
    monkeypatch.setattr(drafts.impact_prediction_engine, "_predict", engine_mock)

    existing = _prediction(magnitude="high")
    session = _TwoCallSession([_FakeResult(scalar=existing)])

    result = asyncio.run(_ensure_impact_prediction(session, _client(), _rec()))

    assert result is existing
    engine_mock.assert_not_called()


class _PriorityRankingSession:
    """Serves _ensure_priority_ranking's own lookup (no existing ranking),
    then delegates to monkeypatched _ensure_effort_estimation/
    _ensure_opportunity_score (patched at module level, so this session
    only needs to answer the FIRST select)."""

    def __init__(self):
        self.added = []

    async def execute(self, *_a, **_kw):
        return _FakeResult(scalar=None)

    async def flush(self):
        pass

    def add(self, obj):
        self.added.append(obj)


def test_ensure_priority_ranking_computes_on_demand_when_scoring_available(monkeypatch):
    """'Scoring data becomes available' case: effort + opportunity can both
    be resolved (mocked as already resolvable), so priority_inputs succeeds
    and a usable (unpersisted) RecommendationRanking is returned."""
    monkeypatch.setattr(drafts, "_ensure_effort_estimation", AsyncMock(return_value=object()))
    monkeypatch.setattr(drafts, "_ensure_opportunity_score", AsyncMock(return_value=object()))
    monkeypatch.setattr(
        drafts.prioritizer_engine, "_priority_inputs", AsyncMock(return_value=(70.0, 0.8, 3)),
    )

    session = _PriorityRankingSession()
    ranking = asyncio.run(_ensure_priority_ranking(session, _client(), _rec()))

    assert ranking is not None
    assert ranking.status == "ok"
    expected = drafts.prioritizer_engine.compute_priority_score(70.0, 0.8, 3)
    assert ranking.priority_score == expected
    assert session.added == []  # deliberately not persisted — see _ensure_priority_ranking's docstring


def test_ensure_priority_ranking_fails_closed_when_scoring_still_insufficient(monkeypatch):
    """The other half of 'scoring data becomes available': BEFORE it's
    available, priority_inputs still returns None (e.g. effort estimation
    itself came back insufficient-data), so no ranking is produced."""
    monkeypatch.setattr(drafts, "_ensure_effort_estimation", AsyncMock(return_value=None))
    monkeypatch.setattr(drafts, "_ensure_opportunity_score", AsyncMock(return_value=None))
    monkeypatch.setattr(drafts.prioritizer_engine, "_priority_inputs", AsyncMock(return_value=None))

    session = _PriorityRankingSession()
    ranking = asyncio.run(_ensure_priority_ranking(session, _client(), _rec()))

    assert ranking is None


# ---------------------------------------------------------------------------
# _try_trigger — end-to-end orchestration. _latest_recommendation,
# _ensure_priority_ranking, and _ensure_impact_prediction are monkeypatched
# directly: this is the actual decision boundary Prompt 2 changed, and
# testing it this way avoids re-simulating the whole session/ORM layer for
# behavior already covered by the isolated tests above.
# ---------------------------------------------------------------------------

class _TriggerSession:
    def __init__(self):
        self.added = []

    async def get(self, model, _pk):
        assert model is Insight
        return self._insight

    def add(self, obj):
        self.added.append(obj)


def _wire_trigger(monkeypatch, *, rec, ranking, prediction):
    monkeypatch.setattr(drafts, "_latest_recommendation", AsyncMock(return_value=rec))
    monkeypatch.setattr(drafts, "_ensure_priority_ranking", AsyncMock(return_value=ranking))
    monkeypatch.setattr(drafts, "_ensure_impact_prediction", AsyncMock(return_value=prediction))
    monkeypatch.setattr(drafts, "McpClient", lambda *_a, **_kw: object())


def _run_trigger(monkeypatch, generate_draft_mock, *, insight, rec, ranking, prediction):
    monkeypatch.setattr(drafts, "generate_draft", generate_draft_mock)
    _wire_trigger(monkeypatch, rec=rec, ranking=ranking, prediction=prediction)
    session = _TriggerSession()
    session._insight = insight
    asyncio.run(_try_trigger(session, _client(), _investigation()))
    return session


# 1. strong priority -> triggers (priority is the SOLE action-selection
# mechanism now; ImpactPrediction is attached to the event purely as
# informational reporting, never a precondition).
def test_strong_priority_triggers_regardless_of_impact_prediction(monkeypatch):
    generate_draft_mock = AsyncMock()
    strong = MIN_PRIORITY_SCORE_TO_TRIGGER + 0.1
    session = _run_trigger(
        monkeypatch, generate_draft_mock, insight=_decline_insight(), rec=_rec(),
        ranking=_ranking(priority_score=strong), prediction=_prediction(magnitude="medium"),
    )

    generate_draft_mock.assert_awaited_once()
    kwargs = generate_draft_mock.await_args.kwargs
    assert kwargs["generator_id"] == "expand-content"
    assert kwargs["params"] == {"page": "https://example.com/page"}

    assert len(session.added) == 1
    event = session.added[0]
    assert isinstance(event, InvestigationEvent)
    assert event.to_status == "draft_prepared"
    assert event.detail["priority_gate"]["priority_score"] == strong
    assert event.detail["impact_prediction"] == {"status": "ok", "expected_impact_magnitude": "medium"}


# 2, 3, 4: no_impact_prediction_gate_remains — a first revision of this
# trigger gated on ImpactPrediction's low/medium/high expected_impact_
# magnitude; removed after product review. These are regression tests
# proving that gate is gone: strong priority triggers a draft regardless of
# what ImpactPrediction says, including 'low', missing, or malformed.
def test_no_impact_prediction_gate_low_magnitude_still_triggers(monkeypatch):
    generate_draft_mock = AsyncMock()
    strong = MIN_PRIORITY_SCORE_TO_TRIGGER + 0.1
    _run_trigger(
        monkeypatch, generate_draft_mock, insight=_decline_insight(), rec=_rec(),
        ranking=_ranking(priority_score=strong), prediction=_prediction(magnitude="low"),
    )
    generate_draft_mock.assert_awaited_once()


def test_no_impact_prediction_gate_missing_prediction_still_triggers(monkeypatch):
    generate_draft_mock = AsyncMock()
    strong = MIN_PRIORITY_SCORE_TO_TRIGGER + 0.1
    session = _run_trigger(
        monkeypatch, generate_draft_mock, insight=_decline_insight(), rec=_rec(),
        ranking=_ranking(priority_score=strong), prediction=None,
    )
    generate_draft_mock.assert_awaited_once()
    assert session.added[0].detail["impact_prediction"] is None


def test_no_impact_prediction_gate_malformed_prediction_still_triggers(monkeypatch):
    generate_draft_mock = AsyncMock()
    strong = MIN_PRIORITY_SCORE_TO_TRIGGER + 0.1
    _run_trigger(
        monkeypatch, generate_draft_mock, insight=_decline_insight(), rec=_rec(),
        ranking=_ranking(priority_score=strong), prediction=_prediction(status="ok", magnitude="not-a-real-value"),
    )
    generate_draft_mock.assert_awaited_once()


def test_no_impact_prediction_gate_insufficient_data_status_still_triggers(monkeypatch):
    generate_draft_mock = AsyncMock()
    strong = MIN_PRIORITY_SCORE_TO_TRIGGER + 0.1
    _run_trigger(
        monkeypatch, generate_draft_mock, insight=_decline_insight(), rec=_rec(),
        ranking=_ranking(priority_score=strong), prediction=_prediction(status="insufficient-data", magnitude=None),
    )
    generate_draft_mock.assert_awaited_once()


# 5. existing eligibility failure -> no draft, regardless of score
def test_eligibility_failure_blocks_before_any_scoring_lookup(monkeypatch):
    generate_draft_mock = AsyncMock()
    monkeypatch.setattr(drafts, "generate_draft", generate_draft_mock)
    latest_rec_mock = AsyncMock()
    monkeypatch.setattr(drafts, "_latest_recommendation", latest_rec_mock)

    # site-level (not page-level) insight — _eligibility already rejects this.
    insight = Insight(
        id=1, client_id=1, metric_key="gsc_clicks", dimension_type="site", dimension_value="__site__",
        period_start=date(2026, 8, 1), insight_type="trend_shift", severity="high",
        evidence={"pct_change": -30}, generated_at=datetime.now(timezone.utc),
    )
    session = _TriggerSession()
    session._insight = insight

    asyncio.run(_try_trigger(session, _client(), _investigation()))

    generate_draft_mock.assert_not_called()
    latest_rec_mock.assert_not_called()  # never even looks up scoring for an ineligible finding
    assert session.added == []


# 6. missing RecommendationRanking -> the dependency-resolution path is
# exercised (verified separately above); here, verify _try_trigger fails
# closed when _ensure_priority_ranking legitimately can't produce one yet.
def test_no_recommendation_ranking_available_fails_closed(monkeypatch):
    generate_draft_mock = AsyncMock()
    session = _run_trigger(
        monkeypatch, generate_draft_mock, insight=_decline_insight(), rec=_rec(),
        ranking=None, prediction=_prediction(magnitude="medium"),
    )

    generate_draft_mock.assert_not_called()
    assert session.added == []


# 7. scoring data becomes available -> valid recommendation can subsequently
# trigger (two sequential calls against the same rec, first without then
# with usable scoring — mirrors the real nightly-retry shape without
# depending on it, since _ensure_priority_ranking is what makes "becomes
# available" actually reachable within a single run now).
def test_scoring_becoming_available_allows_a_later_trigger(monkeypatch):
    generate_draft_mock = AsyncMock()
    insight = _decline_insight()
    rec = _rec()

    first = _run_trigger(
        monkeypatch, generate_draft_mock, insight=insight, rec=rec, ranking=None,
        prediction=_prediction(magnitude="medium"),
    )
    generate_draft_mock.assert_not_called()
    assert first.added == []

    strong = MIN_PRIORITY_SCORE_TO_TRIGGER + 0.1
    second = _run_trigger(
        monkeypatch, generate_draft_mock, insight=insight, rec=rec,
        ranking=_ranking(priority_score=strong), prediction=_prediction(magnitude="medium"),
    )
    generate_draft_mock.assert_awaited_once()
    assert len(second.added) == 1


# 8. existing generate_draft MCP arguments remain unchanged
def test_generate_draft_arguments_unchanged_by_the_new_gates(monkeypatch):
    generate_draft_mock = AsyncMock()
    strong = MIN_PRIORITY_SCORE_TO_TRIGGER + 0.1
    insight = _decline_insight(dimension_value="https://example.com/other-page")
    _run_trigger(
        monkeypatch, generate_draft_mock, insight=insight, rec=_rec(),
        ranking=_ranking(priority_score=strong), prediction=_prediction(magnitude="high"),
    )

    kwargs = generate_draft_mock.await_args.kwargs
    assert kwargs == {
        "generator_id": "expand-content",
        "params": {"page": "https://example.com/other-page"},
        "finding_id": "analyst:gsc_impressions:trend_shift:2026-08-01:https://example.com/other-page",
    }


# 9. MCP failure behavior remains unchanged (no InvestigationEvent written)
def test_mcp_tool_error_after_both_gates_pass_still_skips_event(monkeypatch):
    generate_draft_mock = AsyncMock(side_effect=McpToolError("boom"))
    strong = MIN_PRIORITY_SCORE_TO_TRIGGER + 0.1
    session = _run_trigger(
        monkeypatch, generate_draft_mock, insight=_decline_insight(), rec=_rec(),
        ranking=_ranking(priority_score=strong), prediction=_prediction(magnitude="medium"),
    )

    generate_draft_mock.assert_awaited_once()
    assert session.added == []


# 10. Node/Design Agent behavior is untouched — nothing in this change
# reaches server/, mcp-server/tools/, or the design agent; the only
# interface crossed is the pre-existing, unmodified generate_draft MCP call
# tested above with unchanged arguments. No test double for Node/Design
# Agent code is needed or appropriate from this side of the MCP boundary.


# ---------------------------------------------------------------------------
# run_draft_trigger — batch-isolation regression tests (Prompt 4 audit
# defect: this loop previously had no try/except at either the
# per-investigation or per-client level, unlike every one of its Node
# siblings — one uncaught exception used to abort every remaining
# investigation for that client AND every subsequent client in the same
# run). _try_trigger itself is monkeypatched (its own behavior is already
# covered above); what's under test here is purely run_draft_trigger's own
# loop-isolation control flow.
# ---------------------------------------------------------------------------

class _AsyncCtx:
    def __init__(self, value):
        self._value = value

    async def __aenter__(self):
        return self._value

    async def __aexit__(self, *_exc):
        return False


class _BatchFakeSession:
    """Serves one canned `select(Investigation)` result and records
    commit/rollback calls, for ONE client's `async with SessionLocal()`
    block."""

    def __init__(self, investigations):
        self._investigations = investigations
        self.committed = False
        self.rolled_back = 0

    async def execute(self, *_a, **_kw):
        return _FakeScalarsResult(self._investigations)

    async def commit(self):
        self.committed = True

    async def rollback(self):
        self.rolled_back += 1


class _FakeScalarsResult:
    def __init__(self, items):
        self._items = items

    def scalars(self):
        return self

    def all(self):
        return self._items


def _fake_client(client_id):
    return Client(id=client_id, mcp_token_ciphertext=b"token", status="active")


def _fake_investigation(inv_id):
    return Investigation(
        id=inv_id, client_id=1, metric_key="gsc_impressions", dimension_type="page",
        dimension_value="https://example.com/page", insight_type="trend_shift", severity="high",
        status="recommendation_generated", affected_metrics=[], evidence={}, source_insight_id=1,
    )


def test_one_bad_investigation_does_not_block_the_rest_of_its_client(monkeypatch):
    client = _fake_client(1)
    good1, bad, good2 = _fake_investigation(1), _fake_investigation(2), _fake_investigation(3)

    client_list_session = _BatchFakeSession([client])
    per_client_session = _BatchFakeSession([good1, bad, good2])

    sessions = iter([client_list_session, per_client_session])
    monkeypatch.setattr(drafts, "SessionLocal", lambda: _AsyncCtx(next(sessions)))

    seen = []

    async def fake_try_trigger(_session, _client, investigation):
        if investigation.id == bad.id:
            raise RuntimeError("boom")
        seen.append(investigation.id)

    monkeypatch.setattr(drafts, "_try_trigger", fake_try_trigger)

    asyncio.run(run_draft_trigger())

    assert seen == [good1.id, good2.id], "the bad investigation must not stop good1 or good2 in the same client"
    assert per_client_session.committed is True, "surviving investigations' work must still commit"
    assert per_client_session.rolled_back == 1


def test_one_bad_client_does_not_block_subsequent_clients(monkeypatch):
    client_a, client_b = _fake_client(1), _fake_client(2)
    inv_b = _fake_investigation(10)

    client_list_session = _BatchFakeSession([client_a, client_b])

    class _ExplodingSession(_BatchFakeSession):
        async def execute(self, *_a, **_kw):
            raise RuntimeError("client A's query itself blows up")

    session_a = _ExplodingSession([])
    session_b = _BatchFakeSession([inv_b])

    sessions = iter([client_list_session, session_a, session_b])
    monkeypatch.setattr(drafts, "SessionLocal", lambda: _AsyncCtx(next(sessions)))

    seen = []

    async def fake_try_trigger(_session, _client, investigation):
        seen.append(investigation.id)

    monkeypatch.setattr(drafts, "_try_trigger", fake_try_trigger)

    asyncio.run(run_draft_trigger())

    assert seen == [inv_b.id], "client B must still be processed even though client A's own query raised"
    assert session_b.committed is True
