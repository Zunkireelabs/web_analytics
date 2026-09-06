"""Focused tests for app/investigations/outcome.py's
get_investigation_outcome_reliability — the accessor that lets a
forecast_risk Investigation's real approved/predicted-vs-actual track
record feed forecast confidence (see app/forecast/confidence.py), the same
pattern app/forecast/accuracy.py's get_rolling_accuracy already established.
No DB — a minimal fake session serves the one select this function issues."""
import asyncio

from app.investigations.outcome import MIN_EVALUATED_OUTCOMES_FOR_SIGNAL, get_investigation_outcome_reliability


class _FakeScalars:
    def __init__(self, items):
        self._items = items

    def all(self):
        return self._items


class _FakeResult:
    def __init__(self, items):
        self._items = items

    def scalars(self):
        return _FakeScalars(self._items)

    def all(self):
        # Supports the plain (non-.scalars()) `.all()` call
        # _evaluate_client's already_evaluated query uses.
        return self._items


class _FakeSession:
    def __init__(self, statuses):
        self._statuses = statuses

    async def execute(self, *_a, **_kw):
        return _FakeResult(self._statuses)


def _run(statuses):
    return asyncio.run(get_investigation_outcome_reliability(_FakeSession(statuses), client_id=1))


def test_below_minimum_sample_size_is_insufficient_data():
    result = _run(["decline_as_predicted_or_worse"] * (MIN_EVALUATED_OUTCOMES_FOR_SIGNAL - 1))
    assert result["status"] == "insufficient-data"
    assert result["reliability"] is None


def test_all_materialized_is_full_reliability():
    result = _run(["decline_as_predicted_or_worse"] * MIN_EVALUATED_OUTCOMES_FOR_SIGNAL)
    assert result["status"] == "ok"
    assert result["reliability"] == 1.0


def test_decline_smaller_than_predicted_still_counts_as_materialized():
    # The decline DID occur, just not as severely predicted — a real
    # positive signal for "was the forecast_risk warning right at all".
    result = _run(["decline_smaller_than_predicted"] * MIN_EVALUATED_OUTCOMES_FOR_SIGNAL)
    assert result["reliability"] == 1.0


def test_no_decline_occurred_counts_against_reliability():
    result = _run(["no_decline_occurred", "no_decline_occurred", "decline_as_predicted_or_worse"])
    assert result["status"] == "ok"
    assert round(result["reliability"], 4) == round(1 / 3, 4)


def test_no_outcomes_at_all_is_insufficient_data_not_zero():
    result = _run([])
    assert result["status"] == "insufficient-data"
    assert result["reliability"] is None, "no evaluated outcomes must never read as a real 0.0 reliability"


# ---------------------------------------------------------------------------
# run_investigation_outcome_evaluation / _evaluate_client — batch-isolation
# regression tests (same Prompt 4 audit defect class as
# app/investigations/drafts.py::run_draft_trigger: neither loop here had a
# try/except at the per-investigation or per-client level before this fix).
# _evaluate_one is monkeypatched — its own behavior is untouched and out of
# scope here; what's under test is purely the loop-isolation control flow.
# ---------------------------------------------------------------------------
import app.investigations.outcome as outcome_mod
from app.db.models import Client, Investigation
from app.investigations.outcome import run_investigation_outcome_evaluation


class _AsyncCtx:
    def __init__(self, value):
        self._value = value

    async def __aenter__(self):
        return self._value

    async def __aexit__(self, *_exc):
        return False


class _ClientListSession:
    """Serves run_investigation_outcome_evaluation's ONE top-level
    `select(Client)` call."""

    def __init__(self, clients):
        self._clients = clients

    async def execute(self, *_a, **_kw):
        return _FakeResult(self._clients)


class _BatchFakeSession:
    """Serves ONE client's `async with SessionLocal()` block inside
    _evaluate_client: first execute() = already_evaluated ids, second =
    candidate investigations."""

    def __init__(self, already_evaluated_ids, candidates):
        self._already_evaluated_ids = already_evaluated_ids
        self._candidates = candidates
        self._call = 0
        self.committed = False
        self.rolled_back = 0

    async def execute(self, *_a, **_kw):
        self._call += 1
        items = self._already_evaluated_ids if self._call == 1 else self._candidates
        return _FakeResult(items)

    async def commit(self):
        self.committed = True

    async def rollback(self):
        self.rolled_back += 1


def _fake_client(client_id):
    return Client(id=client_id, status="active")


def _fake_investigation(inv_id):
    return Investigation(
        id=inv_id, client_id=1, metric_key="gsc_clicks", dimension_type="page", dimension_value="https://example.com/page",
        insight_type="forecast_risk", severity="high", status="approved", affected_metrics=[], evidence={},
    )


def test_one_bad_investigation_does_not_block_the_rest_of_its_client(monkeypatch):
    client = _fake_client(1)
    good1, bad, good2 = _fake_investigation(1), _fake_investigation(2), _fake_investigation(3)

    client_list_session = _ClientListSession([client])
    per_client_session = _BatchFakeSession([], [good1, bad, good2])

    sessions = iter([client_list_session, per_client_session])
    monkeypatch.setattr(outcome_mod, "SessionLocal", lambda: _AsyncCtx(next(sessions)))

    seen = []

    async def fake_evaluate_one(_session, _client_id, inv):
        if inv.id == bad.id:
            raise RuntimeError("boom")
        seen.append(inv.id)

    monkeypatch.setattr(outcome_mod, "_evaluate_one", fake_evaluate_one)

    asyncio.run(run_investigation_outcome_evaluation())

    assert seen == [good1.id, good2.id]
    assert per_client_session.committed is True
    assert per_client_session.rolled_back == 1


def test_one_bad_client_does_not_block_subsequent_clients(monkeypatch):
    client_a, client_b = _fake_client(1), _fake_client(2)
    inv_b = _fake_investigation(10)

    client_list_session = _ClientListSession([client_a, client_b])

    class _ExplodingSession(_BatchFakeSession):
        async def execute(self, *_a, **_kw):
            raise RuntimeError("client A's query itself blows up")

    session_a = _ExplodingSession([], [])
    session_b = _BatchFakeSession([], [inv_b])

    sessions = iter([client_list_session, session_a, session_b])
    monkeypatch.setattr(outcome_mod, "SessionLocal", lambda: _AsyncCtx(next(sessions)))

    seen = []

    async def fake_evaluate_one(_session, _client_id, inv):
        seen.append(inv.id)

    monkeypatch.setattr(outcome_mod, "_evaluate_one", fake_evaluate_one)

    asyncio.run(run_investigation_outcome_evaluation())

    assert seen == [inv_b.id]
    assert session_b.committed is True


# ---------------------------------------------------------------------------
# _evaluate_observed_decline_one — the trend_shift/anomaly/milestone path
# added alongside the existing forecast_risk one (migration 0039). No real
# prediction exists for these insight_types, so the outcome compares a real
# before-value (the insight's own evidence) against a real after-value
# (a landed MetricObservation at/after the evaluation horizon), never a
# sampled or estimated number.
# ---------------------------------------------------------------------------
from datetime import date, datetime, timedelta, timezone

from app.investigations.outcome import OBSERVED_EVALUATION_HORIZON_DAYS, _evaluate_observed_decline_one


class _ScalarSession:
    """Serves _evaluate_observed_decline_one's sequential .scalar() calls
    (approved_at, then actual value) and records everything .add()ed."""

    def __init__(self, scalars):
        self._scalars = iter(scalars)
        self.added = []

    async def scalar(self, *_a, **_kw):
        return next(self._scalars)

    def add(self, obj):
        self.added.append(obj)


def _fake_observed_investigation(evidence, status="approved"):
    return Investigation(
        id=1, client_id=1, metric_key="gsc_clicks", dimension_type="page", dimension_value="https://example.com/page",
        insight_type="trend_shift", severity="high", status=status, affected_metrics=[], evidence=evidence,
    )


def _old_enough_approval():
    return datetime.now(timezone.utc) - timedelta(days=OBSERVED_EVALUATION_HORIZON_DAYS + 5)


def test_observed_decline_missing_baseline_evidence_is_skipped():
    inv = _fake_observed_investigation(evidence={})
    session = _ScalarSession([])
    asyncio.run(_evaluate_observed_decline_one(session, 1, inv))
    assert session.added == []  # nothing to compute a baseline from — never invent one


def test_observed_decline_too_early_to_evaluate_is_skipped():
    inv = _fake_observed_investigation(evidence={"current_value": 100.0})
    recent_approval = datetime.now(timezone.utc) - timedelta(days=1)
    session = _ScalarSession([recent_approval])
    asyncio.run(_evaluate_observed_decline_one(session, 1, inv))
    assert session.added == []  # horizon hasn't passed yet — retry a later night


def test_observed_decline_no_actual_value_landed_yet_is_skipped():
    inv = _fake_observed_investigation(evidence={"current_value": 100.0})
    session = _ScalarSession([_old_enough_approval(), None])
    asyncio.run(_evaluate_observed_decline_one(session, 1, inv))
    assert session.added == []


def test_observed_decline_recovered_is_improved():
    inv = _fake_observed_investigation(evidence={"current_value": 100.0})
    session = _ScalarSession([_old_enough_approval(), 130.0])
    asyncio.run(_evaluate_observed_decline_one(session, 1, inv))
    outcome = session.added[0]
    assert outcome.outcome_status == "improved"
    assert outcome.predicted_value is None  # no prediction existed for this insight_type
    assert outcome.pct_projected_change is None
    assert inv.status == "completed"


def test_observed_decline_kept_falling_is_worsened():
    inv = _fake_observed_investigation(evidence={"current_value": 100.0})
    session = _ScalarSession([_old_enough_approval(), 60.0])
    asyncio.run(_evaluate_observed_decline_one(session, 1, inv))
    assert session.added[0].outcome_status == "worsened"


def test_observed_decline_within_flat_band_is_unchanged():
    inv = _fake_observed_investigation(evidence={"current_value": 100.0})
    session = _ScalarSession([_old_enough_approval(), 101.0])
    asyncio.run(_evaluate_observed_decline_one(session, 1, inv))
    assert session.added[0].outcome_status == "unchanged"


def test_observed_decline_anomaly_evidence_uses_value_key():
    # anomaly insights key their evidence 'value', not 'current_value'
    # (app/insights/engine.py::_anomaly_insights) — must be read too.
    inv = _fake_observed_investigation(evidence={"value": 50.0})
    inv.insight_type = "anomaly"
    session = _ScalarSession([_old_enough_approval(), 20.0])
    asyncio.run(_evaluate_observed_decline_one(session, 1, inv))
    assert session.added[0].outcome_status == "worsened"
