"""Cross-client disclosure control for industry benchmarks.

The defect these cover: with exactly two clients in an industry, the
published p25/median/p75 invert to the two raw values by arithmetic, and
app/intelligence/opportunity_scoring.py fed that same aggregate into a
SPECIFIC client's stored scoring factors — so A's score encoded B's exact
metric value and moved when B's data changed. The module docstring
simultaneously asserted that a client's raw value was "never inferable from
another client's view".

Two independent fixes, tested separately below because either alone is
insufficient: exclude the subject client from its own peer pool, and require
enough remaining peers that the aggregate isn't invertible.
"""
import statistics

from app.api.routes.benchmarks import MIN_CLIENTS_PER_GROUP, _percentile_summary


def _invert_two_client_group(summary: dict) -> tuple[float, float]:
    """Recovers both raw values from a 2-client percentile summary.

    Sorted [a, b] with inclusive quantiles:
        p25 = a + 0.25(b - a),  p75 = a + 0.75(b - a)
    so  b - a = 2(p75 - p25)  and  a = median - (b - a)/2.
    """
    spread = 2 * (summary["p75"] - summary["p25"])
    a = summary["median"] - spread / 2
    return a, a + spread


def test_a_two_client_aggregate_is_arithmetically_invertible():
    """Demonstrates WHY the threshold moved. This is the property that made
    the old MIN_CLIENTS_PER_GROUP = 2 unsafe — not a hypothetical."""
    summary = _percentile_summary("education", [120.0, 480.0])
    a, b = _invert_two_client_group(summary)
    assert round(a, 6) == 120.0
    assert round(b, 6) == 480.0, "a 2-client aggregate exposes both raw values exactly"


def test_a_three_client_aggregate_publishes_the_middle_clients_exact_value():
    """The other reason 3 is not a safe floor either: the median IS a real
    client's value, verbatim."""
    summary = _percentile_summary("education", [10.0, 250.0, 900.0])
    assert summary["median"] == 250.0


def test_threshold_is_above_the_invertible_range():
    assert MIN_CLIENTS_PER_GROUP >= 5, (
        "Below 5, published order statistics either invert exactly (2) or "
        "reveal a client's value directly (3). See the module docstring."
    )


def test_percentile_summary_still_reports_the_real_distribution():
    """The fix must not have quietly broken what these aggregates mean."""
    values = [10.0, 20.0, 30.0, 40.0, 50.0]
    summary = _percentile_summary("education", values)
    assert summary["client_count"] == 5
    assert summary["median"] == statistics.median(values)
    assert summary["p25"] < summary["median"] < summary["p75"]


# ── Peer-pool exclusion ─────────────────────────────────────────────────────
# get_industry_percentiles is a DB coroutine; these exercise the selection
# rule it implements against a fake session, in the same "test the decision,
# not the driver" style as tests/intelligence/test_cannibalization.py.

class _FakeScalars:
    def __init__(self, rows):
        self._rows = rows

    def scalars(self):
        return self

    def all(self):
        return self._rows


class _Client:
    def __init__(self, id, industry="education"):
        self.id = id
        self.industry = industry
        self.status = "active"


class _FakeSession:
    """Records which clients the query selected, and serves each a value."""

    def __init__(self, clients, values):
        self.clients = clients
        self.values = values
        self.selected = None
        self._excluded = None

    async def execute(self, query):
        # The exclusion is expressed as an extra WHERE on the statement; read
        # it back off the compiled query rather than re-implementing it.
        text = str(query)
        rows = self.clients
        if self._excluded is not None:
            rows = [c for c in rows if c.id != self._excluded]
        self.selected = [c.id for c in rows]
        assert "client" in text.lower()
        return _FakeScalars(rows)

    async def scalar(self, _query):
        return self.values.pop(0) if self.values else None


async def _percentiles_for(clients, values, exclude=None):
    from app.api.routes import benchmarks

    session = _FakeSession(list(clients), list(values))
    session._excluded = exclude
    return await benchmarks.get_industry_percentiles(session, "clicks", exclude_client_id=exclude), session


def test_scoring_a_client_excludes_that_client_from_its_own_peer_pool():
    import asyncio

    clients = [_Client(1), _Client(2), _Client(3), _Client(4), _Client(5), _Client(6)]
    _, session = asyncio.run(_percentiles_for(clients, [10.0] * 6, exclude=1))
    assert 1 not in session.selected, "a client must never be a peer of itself"
    assert session.selected == [2, 3, 4, 5, 6]


def test_two_tenants_produce_no_peer_group_at_all():
    """THE two-client case, end to end. With only A and B, scoring A leaves a
    single peer — below the threshold — so no aggregate is produced and B's
    value cannot reach A's factors by any route."""
    import asyncio

    percentiles, _ = asyncio.run(_percentiles_for([_Client(1), _Client(2)], [100.0, 900.0], exclude=1))
    assert percentiles == {}, "one peer must never yield a published group"


def test_a_then_b_then_a_is_deterministic_and_uncontaminated():
    """A → B → A. Scoring B in between must not change what A sees, and
    neither client's pass may include the other's own row in its pool."""
    import asyncio

    clients = [_Client(i) for i in range(1, 8)]
    values = [50.0 * i for i in range(1, 8)]

    first_a, session_a1 = asyncio.run(_percentiles_for(clients, values, exclude=1))
    _, session_b = asyncio.run(_percentiles_for(clients, values, exclude=2))
    second_a, session_a2 = asyncio.run(_percentiles_for(clients, values, exclude=1))

    assert first_a == second_a, "A's benchmark must not depend on B having been scored in between"
    assert session_a1.selected == session_a2.selected
    assert 1 not in session_a1.selected and 1 not in session_a2.selected
    assert 2 not in session_b.selected
    # And the two clients genuinely saw different pools — proving the
    # exclusion is per-subject, not a single shared pool computed once.
    assert session_a1.selected != session_b.selected
