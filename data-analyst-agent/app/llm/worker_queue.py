"""The Claude worker's queue, used from the Data Analyst service.

ALL AI goes through the Claude Code worker (owner's rule, 2026-11-27); only the AI-visibility probes and the client chat assistant use a paid API. The platform
and this service share one database, so this does exactly what the platform's server/store/llm-requests.js does: insert a row into llm_requests, then poll it until
the worker has answered. Single-shot, text in and text out; a call that needs a model working through tools stays where it is (the /ask chat loop).

With LLM_WORKER_MODE unset or not "on" nothing here is used and the service behaves as it always did. LLM_WORKER_FALLBACK=api keeps the paid call when no worker is connected.
"""
from __future__ import annotations

import asyncio
import json
import os
from collections.abc import Callable

from sqlalchemy import text

WORKER_ONLINE_SECONDS = 90          # same as the platform's WORKER_ONLINE_MS
DEFAULT_WAIT_SECONDS = 600
POLL_SECONDS = 1.5


class WorkerUnavailable(RuntimeError):
    """No worker is connected, or it did not answer in time. Callers treat it as "AI unavailable right now": retried later, never as a wrong answer."""


def worker_mode_on(env=None) -> bool:
    return str((env if env is not None else os.environ).get("LLM_WORKER_MODE", "")).lower() == "on"


def paid_api_fallback(env=None) -> bool:
    return str((env if env is not None else os.environ).get("LLM_WORKER_FALLBACK", "")).lower() == "api"


def _session_factory():
    from app.db.session import SessionLocal  # imported late: tests pass their own factory

    return SessionLocal


async def worker_online(session_factory: Callable | None = None) -> bool:
    factory = session_factory or _session_factory()
    async with factory() as session:
        row = (await session.execute(
            text("SELECT 1 FROM llm_workers WHERE last_seen_at > now() - make_interval(secs => :s) LIMIT 1"), {"s": WORKER_ONLINE_SECONDS},
        )).first()
    return row is not None


async def ask(
    system: str, user: str, *, site_id: int | None = None, generator_id: str | None = None,
    timeout_s: float = DEFAULT_WAIT_SECONDS, poll_s: float = POLL_SECONDS, session_factory: Callable | None = None,
    sleep: Callable = asyncio.sleep,
) -> str:
    """Queue one request, wait for the worker's text. Raises WorkerUnavailable when no worker is online, or it failed or did not answer in time."""
    factory = session_factory or _session_factory()
    if not await worker_online(factory):
        raise WorkerUnavailable("The Claude worker is not connected, so this AI call waits until it is (the laptop runs it when open).")
    async with factory() as session:
        row = (await session.execute(
            text(
                "INSERT INTO llm_requests (site_id, generator_id, system_text, user_text, options, expires_at) "
                "VALUES (:site, :gen, :sys, :usr, CAST(:opts AS jsonb), now() + make_interval(secs => :ttl)) RETURNING id"
            ),
            {"site": site_id, "gen": generator_id, "sys": system, "usr": user, "opts": json.dumps({"tier": "daily", "source": "data-analyst"}), "ttl": max(1.0, float(timeout_s))},
        )).first()
        await session.commit()
    request_id = row[0]
    waited = 0.0
    while True:
        async with factory() as session:
            r = (await session.execute(text("SELECT status, response_text, error FROM llm_requests WHERE id = :id"), {"id": request_id})).first()
            if r is None:
                raise WorkerUnavailable("The request is gone.")
            status, response_text, error = r
            if status == "done":
                return response_text or ""
            if status == "failed":
                raise WorkerUnavailable(f"The Claude worker could not write this: {error or 'unknown error'}")
            if status == "expired" or waited >= timeout_s:
                if status != "expired":
                    await session.execute(text("UPDATE llm_requests SET status = 'expired' WHERE id = :id AND status IN ('pending', 'claimed')"), {"id": request_id})
                    await session.commit()
                raise WorkerUnavailable("No worker answered in time.")
        await sleep(poll_s)
        waited += poll_s
