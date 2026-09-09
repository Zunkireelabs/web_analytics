"""Proves MCP stays preferred, the database catches the outage, and a real
tool defect is still allowed to fail.

The twelve-day August 2026 outage is the scenario under test: MCP unreachable
(or its token revoked) while the shared database is perfectly healthy. Before
DataSource that combination produced zero observations, which propagated all
the way to an empty prediction -> recommendation -> execution chain. These
tests pin the behaviour that stops it recurring, including the part that is
easy to get wrong in the other direction — an McpToolError means MCP answered
and objected, so routing around it to the database would hide a defect rather
than survive an outage.
"""
import asyncio

import httpx
import pytest

from app.mcp_client.client import McpAuthError, McpToolError
from app.mcp_client.datasource import DIRECT_DB, MCP, DataSource
from app.mcp_client.tools import get_daily_series, get_site_profile


class _FakeMcp:
    """Stands in for McpClient. `behaviour` is either a value to return or an
    exception instance to raise."""

    def __init__(self, behaviour):
        self.behaviour = behaviour
        self.calls = []

    async def call_tool(self, tool_name, arguments=None):
        self.calls.append((tool_name, arguments))
        if isinstance(self.behaviour, BaseException):
            raise self.behaviour
        return self.behaviour


class _MappingsResult:
    def __init__(self, rows):
        self._rows = rows

    def mappings(self):
        return self

    def all(self):
        return self._rows

    def first(self):
        return self._rows[0] if self._rows else None


class _FakeSession:
    def __init__(self, rows):
        self._rows = rows
        self.executed = []

    async def execute(self, stmt, params=None):
        self.executed.append(params)
        return _MappingsResult(self._rows)


DB_ROWS = [{
    "date": "2026-09-01", "clicks": 10, "impressions": 100, "ctr": 0.1, "position": 4.0,
    "users": 20, "new_users": 5, "sessions": 25, "engaged_sessions": 15,
    "avg_engagement_time": 30.0, "conversions": 1, "bounce_rate": 0.4,
}]
MCP_ROWS = [{"date": "2026-09-01", "clicks": 999, "impressions": 9999}]


def test_mcp_is_preferred_and_the_database_is_never_touched_when_it_works():
    session = _FakeSession(DB_ROWS)
    ds = DataSource(client_id=1, session=session, mcp=_FakeMcp(MCP_ROWS))

    rows = asyncio.run(get_daily_series(ds, "2026-09-01", "2026-09-02"))

    assert rows == MCP_ROWS, "a healthy MCP must serve the read"
    assert session.executed == [], "the database must not be queried when MCP answered"
    assert ds.provenance == MCP


def test_transport_failure_falls_back_to_the_database():
    # httpx connect errors carry an empty message — the exact shape that made
    # the original outage invisible (see run_nightly._describe).
    session = _FakeSession(DB_ROWS)
    ds = DataSource(client_id=7, session=session, mcp=_FakeMcp(httpx.ConnectError("")))

    rows = asyncio.run(get_daily_series(ds, "2026-09-01", "2026-09-02"))

    assert rows == DB_ROWS
    assert ds.provenance == DIRECT_DB
    assert session.executed[0]["site_id"] == 7, "the fallback must scope to this client's own rows"
    assert ds.fallback_reasons and "MCP unavailable" in ds.fallback_reasons[0]
    assert "ConnectError" in ds.fallback_reasons[0], "an empty-message failure must still name itself"


def test_401_falls_back_to_the_database():
    session = _FakeSession(DB_ROWS)
    ds = DataSource(client_id=1, session=session, mcp=_FakeMcp(McpAuthError("get_daily_series: 401 — token revoked")))

    rows = asyncio.run(get_daily_series(ds, "2026-09-01", "2026-09-02"))

    assert rows == DB_ROWS
    assert ds.provenance == DIRECT_DB
    assert "MCP auth rejected" in ds.fallback_reasons[0]


def test_a_tool_error_is_not_routed_around():
    """MCP answered and objected — bad arguments or a missing permission.
    Re-asking the database would hide a real defect."""
    session = _FakeSession(DB_ROWS)
    ds = DataSource(client_id=1, session=session, mcp=_FakeMcp(McpToolError("get_daily_series: bad range")))

    with pytest.raises(McpToolError):
        asyncio.run(get_daily_series(ds, "2026-09-01", "2026-09-02"))
    assert session.executed == []


def test_a_tool_with_no_database_equivalent_still_fails_rather_than_inventing_data():
    """get_site_profile has no Node-side table behind it. Nothing may be
    fabricated to cover the gap — the failure must propagate so the run is
    recorded as insufficient-data."""
    session = _FakeSession(DB_ROWS)
    ds = DataSource(client_id=1, session=session, mcp=_FakeMcp(httpx.ConnectError("")))

    with pytest.raises(httpx.ConnectError):
        asyncio.run(get_site_profile(ds))
    assert session.executed == []


def test_provenance_reports_mixed_when_both_sources_served_one_run():
    session = _FakeSession(DB_ROWS)
    ds = DataSource(client_id=1, session=session, mcp=_FakeMcp(MCP_ROWS))
    asyncio.run(get_daily_series(ds, "2026-09-01", "2026-09-02"))

    ds._mcp = _FakeMcp(httpx.ConnectError(""))
    asyncio.run(get_daily_series(ds, "2026-09-03", "2026-09-04"))

    assert ds.provenance == "mixed", "a partially-degraded run must not report as fully MCP-served"


def test_a_bare_mcp_client_still_works_unchanged():
    """Every existing caller passes an McpClient (or a fake) rather than a
    DataSource; that path must be untouched."""
    mcp = _FakeMcp(MCP_ROWS)
    rows = asyncio.run(get_daily_series(mcp, "2026-09-01", "2026-09-02"))
    assert rows == MCP_ROWS
    assert mcp.calls == [("get_daily_series", {"start": "2026-09-01", "end": "2026-09-02"})]
