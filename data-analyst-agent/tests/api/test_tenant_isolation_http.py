"""Tenant isolation at the HTTP layer.

The audit that prompted these found the underlying isolation clean — every
per-client route depends on get_active_client and filters its queries by
client_id — but verified only by reading the code, with nothing asserting it.
That was survivable while exactly one tenant existed, because a missing filter
would have been invisible. It stops being survivable the moment a second real
tenant is onboarded.

These tests therefore guard the RULE rather than a snapshot of today's routes:
a route added later without the tenant gate fails the first test here, and a
new cross-client route fails the second. Neither depends on which routes
happen to exist right now.
"""
import asyncio
import inspect

import pytest
from fastapi import HTTPException

from app.api import deps
from app.api.deps import get_active_client
from app.main import app

# The routes that are cross-client BY DESIGN. Every one is admin-key gated and
# returns aggregate or operational data across tenants; on the Node side they
# sit behind requirePlatformRole('platform_admin') plus an internal-site check
# (server/routes/dataAnalyst.js), so no tenant user can reach them.
#
# This list is the point of the test, not an exemption from it: adding a route
# here is a deliberate act that shows up in review, whereas forgetting
# get_active_client on a new per-client route is a silent mistake. Anything
# cross-client that is NOT listed fails.
INTENTIONALLY_CROSS_CLIENT = {
    "/health",
    "/alerts",
    "/activity",
    "/benchmarks/{metric_key}",
    "/benchmarks/{metric_key}/trend",
    # Client PROVISIONING, not client data — deliberately keyed by `site_id`
    # rather than `client_id` (see admin_clients.py's own note) precisely so
    # it reads here as what it is: a route that CREATES the tenant row,
    # which get_active_client cannot gate since the row may not exist yet.
    # Admin-key gated only, same tier as the routes above; on the Node side
    # only server/lib/data-analyst-client.js's provisionAnalystClient calls
    # it, itself reached from onboarding, never from a tenant-facing route.
    "/admin/clients/by-site/{site_id}",
}


def _depends_on_active_client(route) -> bool:
    """True if get_active_client is in this route's real dependency tree."""
    for dependency in route.dependant.dependencies:
        if dependency.call is get_active_client:
            return True
    # Also catch it declared directly as a parameter default.
    return any(
        getattr(param.default, "dependency", None) is get_active_client
        for param in inspect.signature(route.endpoint).parameters.values()
        if param.default is not inspect.Parameter.empty
    )


def _walk(routes):
    """Yields real endpoint routes. This FastAPI version wraps each
    include_router() call in a _IncludedRouter rather than flattening its
    routes into app.routes, so a naive iteration over app.routes sees only
    /docs and /openapi.json and would make every assertion below pass
    vacuously — the exact way a structural test like this quietly stops
    testing anything."""
    for route in routes:
        original = getattr(route, "original_router", None)
        if original is not None:
            yield from _walk(original.routes)
        elif getattr(route, "path", None):
            yield route


def _client_scoped_routes():
    for route in _walk(app.routes):
        path = getattr(route, "path", None)
        if not path or not hasattr(route, "dependant"):
            continue
        yield route, path


def test_the_route_walker_actually_finds_the_routers():
    """Guards the guard. If _walk ever stops descending into included
    routers, every other test in this file would pass while checking
    nothing."""
    paths = [p for _, p in _client_scoped_routes()]
    assert len(paths) > 20, f"expected the full route table, found only {len(paths)}: {paths}"
    assert "/clients/{client_id}/opportunities" in paths


def test_every_route_taking_a_client_id_enforces_the_tenant_gate():
    """A route that accepts a client_id MUST resolve it through
    get_active_client, which 404s an unknown client and 403s a suspended one.
    Taking the id straight off the path and querying with it would let any
    admin-key holder read any tenant by changing a number in the URL."""
    offenders = []
    for route, path in _client_scoped_routes():
        takes_client_id = "{client_id}" in path or "{id}" in path
        if not takes_client_id:
            continue
        if not _depends_on_active_client(route):
            offenders.append(f"{sorted(route.methods)} {path}")
    assert not offenders, (
        "These routes accept a client id but do not depend on get_active_client, "
        "so they never verify the caller is entitled to that tenant: " + "; ".join(offenders)
    )


def test_no_undeclared_cross_client_routes_exist():
    """Every route that does NOT scope to a client must be one we have
    deliberately decided is cross-client. A new one appearing without being
    added to INTENTIONALLY_CROSS_CLIENT is exactly the mistake this catches."""
    undeclared = []
    for route, path in _client_scoped_routes():
        if path in INTENTIONALLY_CROSS_CLIENT:
            continue
        if "{client_id}" in path or "{id}" in path:
            continue  # covered by the test above
        if _depends_on_active_client(route):
            continue
        # Routes FastAPI adds itself (docs, openapi) aren't ours.
        if path.startswith(("/openapi", "/docs", "/redoc")):
            continue
        undeclared.append(f"{sorted(route.methods)} {path}")
    assert not undeclared, (
        "These routes are neither client-scoped nor declared cross-client. If one is "
        "genuinely meant to span tenants, add it to INTENTIONALLY_CROSS_CLIENT so the "
        "decision is visible in review: " + "; ".join(undeclared)
    )


def test_the_declared_cross_client_routes_still_exist():
    """Guards the allowlist against rot — a stale entry would silently widen
    what the test above permits."""
    live = {p for _, p in _client_scoped_routes()}
    missing = INTENTIONALLY_CROSS_CLIENT - live
    assert not missing, f"Allowlisted cross-client routes no longer exist and should be removed: {missing}"


# ── The gate's own behaviour ────────────────────────────────────────────────

class _Client:
    def __init__(self, id, status="active"):
        self.id = id
        self.status = status


class _FakeSession:
    def __init__(self, clients):
        self.clients = clients
        self.requested = []

    async def get(self, _model, client_id):
        self.requested.append(client_id)
        return self.clients.get(client_id)


def test_gate_returns_only_the_requested_tenant():
    session = _FakeSession({1: _Client(1), 2: _Client(2)})
    a = asyncio.run(get_active_client(1, session=session, _admin=None))
    b = asyncio.run(get_active_client(2, session=session, _admin=None))
    assert a.id == 1
    assert b.id == 2
    assert session.requested == [1, 2], "each call must look up exactly the tenant asked for"


def test_gate_404s_an_unknown_client_without_leaking_existence():
    session = _FakeSession({1: _Client(1)})
    with pytest.raises(HTTPException) as exc:
        asyncio.run(get_active_client(999, session=session, _admin=None))
    assert exc.value.status_code == 404
    # 404, not 403: a different code would confirm which ids exist.
    assert "not found" in exc.value.detail.lower()


def test_gate_403s_a_suspended_client():
    session = _FakeSession({1: _Client(1, status="suspended")})
    with pytest.raises(HTTPException) as exc:
        asyncio.run(get_active_client(1, session=session, _admin=None))
    assert exc.value.status_code == 403


def test_a_failure_for_one_tenant_does_not_affect_the_next():
    """Client A failing must leave Client B fully serviceable — the per-tenant
    isolation the scheduled jobs rely on, asserted at the gate."""
    session = _FakeSession({2: _Client(2)})
    with pytest.raises(HTTPException):
        asyncio.run(get_active_client(1, session=session, _admin=None))  # A is unknown -> 404
    b = asyncio.run(get_active_client(2, session=session, _admin=None))
    assert b.id == 2, "B must still resolve after A failed"


def test_a_then_b_then_a_is_stable():
    session = _FakeSession({1: _Client(1), 2: _Client(2)})
    first = asyncio.run(get_active_client(1, session=session, _admin=None))
    asyncio.run(get_active_client(2, session=session, _admin=None))
    again = asyncio.run(get_active_client(1, session=session, _admin=None))
    assert first.id == again.id == 1, "serving B in between must not change what A resolves to"
