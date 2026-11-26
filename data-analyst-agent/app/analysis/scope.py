"""Which clients an analysis stage may process right now.

Every engine in the nightly pass used to select ALL active clients itself. The pass now decides, per stage, which clients have the
fresh inputs that stage needs (app/analysis/freshness.py) and records the rest as insufficient_data. To do that without touching
each engine's own logic, they all ask `active_clients(session)` instead of selecting from the clients table directly; outside a
stage that excluded anyone (an API request, a manual script) it returns exactly what the old query did."""
from __future__ import annotations

from contextlib import contextmanager
from contextvars import ContextVar
from typing import Iterable

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import Client

_excluded: ContextVar[frozenset[int]] = ContextVar("analysis_excluded_client_ids", default=frozenset())


async def active_clients(session: AsyncSession) -> list[Client]:
    clients = (await session.execute(select(Client).where(Client.status == "active"))).scalars().all()
    excluded = _excluded.get()
    return [c for c in clients if c.id not in excluded] if excluded else list(clients)


@contextmanager
def excluding(client_ids: Iterable[int]):
    """Within this block every `active_clients` call leaves these clients out. Set per stage by the pass runner."""
    token = _excluded.set(frozenset(client_ids))
    try:
        yield
    finally:
        _excluded.reset(token)


# ---- per-client failures inside a stage ------------------------------------------------------------------------------
# Several engines isolate clients on purpose (one client failing must not stop the others) and used to log the failure and carry
# on, so a stage in which a client's work threw still looked completed. They now also report it here; the pass runner collects
# the reports, records them against the stage and leaves that client out of the findings' coverage.
import sys  # noqa: E402

_failures: ContextVar[dict | None] = ContextVar("analysis_client_failures", default=None)


def note_client_failure(client_id: int) -> None:
    """Call from inside the `except` block that isolates one client. Records the exception being handled. A no-op outside a pass."""
    failures = _failures.get()
    if failures is None:
        return
    exc = sys.exc_info()[1]
    failures.setdefault(client_id, f"{type(exc).__name__}: {str(exc).strip() or '(no message)'}"[:2000] if exc else "unknown error")


@contextmanager
def collecting_failures():
    """Yields the dict that note_client_failure fills for the duration of one stage."""
    bucket: dict = {}
    token = _failures.set(bucket)
    try:
        yield bucket
    finally:
        _failures.reset(token)
