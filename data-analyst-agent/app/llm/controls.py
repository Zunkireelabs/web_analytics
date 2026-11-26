"""Server-side controls around every OpenAI call the Data Analyst makes (recommendation text, investigation reasoning, keyword
clustering, /ask). These calls run on the server and never depend on the laptop worker; before this module they had a bare
retry loop in one caller and a swallow-everything `except` in the other, so a spent quota or an outage just produced nothing,
with no record of why.

What this adds, for both callers:
  * retry with exponential backoff for transient failures only (rate limit that is not a spent quota, connection errors,
    timeouts, 5xx), at most MAX_ATTEMPTS;
  * a quota circuit breaker: a spent quota (`insufficient_quota`) will not heal in seconds, so it stops further calls for
    QUOTA_COOLDOWN_SECONDS instead of hammering, then lets one call probe (same shape as the Node app's server/llm.js breaker);
  * one structured log line per call (purpose, outcome, attempts, duration; never the prompt, the response or a key);
  * in-process counters per purpose and outcome, shown by the admin evidence-status route, so quota trouble is visible.

Counters are per process and reset on restart. Persistent spend/quota history needs a table, which is a migration and is left
for separate approval; until then the log lines are the durable record."""
from __future__ import annotations

import asyncio
import logging
import time
from collections import defaultdict
from typing import Awaitable, Callable, TypeVar

import openai

logger = logging.getLogger(__name__)

T = TypeVar("T")

MAX_ATTEMPTS = 3
BASE_DELAY_SECONDS = 1.0
QUOTA_COOLDOWN_SECONDS = 15 * 60

QUOTA, AUTH, TRANSIENT, REJECTED, UNKNOWN = "quota_exhausted", "auth_failed", "transient", "request_rejected", "unknown"


class LlmUnavailable(RuntimeError):
    """The call was not attempted: the quota breaker is open. Carries the reason code."""

    def __init__(self, reason: str, retry_after_seconds: int):
        super().__init__(f"{reason}: OpenAI calls are paused for about {retry_after_seconds}s after the quota was exhausted")
        self.reason = reason
        self.retry_after_seconds = retry_after_seconds


def classify(exc: BaseException) -> str:
    text = str(exc).lower()
    if isinstance(exc, openai.RateLimitError):
        return QUOTA if ("insufficient_quota" in text or getattr(exc, "code", None) == "insufficient_quota") else TRANSIENT
    if isinstance(exc, openai.AuthenticationError | openai.PermissionDeniedError):
        return AUTH
    if isinstance(exc, openai.APIConnectionError | openai.APITimeoutError | openai.InternalServerError):
        return TRANSIENT
    if isinstance(exc, openai.BadRequestError | openai.UnprocessableEntityError | openai.NotFoundError):
        return REJECTED
    return UNKNOWN


class LlmControls:
    def __init__(self, *, sleep: Callable[[float], Awaitable] = asyncio.sleep, clock: Callable[[], float] = time.monotonic):
        self._sleep = sleep
        self._clock = clock
        self._quota_blocked_until = 0.0
        self.counters: dict[str, dict[str, int]] = defaultdict(lambda: defaultdict(int))
        self.last_failure: dict | None = None

    def _breaker_remaining(self) -> int:
        return max(0, int(self._quota_blocked_until - self._clock()))

    async def run(self, purpose: str, call: Callable[[], Awaitable[T]]) -> T:
        remaining = self._breaker_remaining()
        if remaining:
            self.counters[purpose]["blocked_by_quota_breaker"] += 1
            logger.warning("llm_call purpose=%s outcome=blocked_by_quota_breaker retry_after_s=%s", purpose, remaining)
            raise LlmUnavailable(QUOTA, remaining)

        started = self._clock()
        last_exc: BaseException | None = None
        for attempt in range(1, MAX_ATTEMPTS + 1):
            try:
                result = await call()
            except Exception as exc:  # noqa: BLE001 — classified below, then re-raised after the bounded retries
                last_exc = exc
                kind = classify(exc)
                if kind == QUOTA:
                    self._quota_blocked_until = self._clock() + QUOTA_COOLDOWN_SECONDS
                if kind == TRANSIENT and attempt < MAX_ATTEMPTS:
                    self.counters[purpose]["retries"] += 1
                    logger.warning("llm_call purpose=%s outcome=retrying attempt=%s kind=%s", purpose, attempt, kind)
                    await self._sleep(BASE_DELAY_SECONDS * (2 ** (attempt - 1)))
                    continue
                self.counters[purpose][f"failed_{kind}"] += 1
                self.last_failure = {"purpose": purpose, "kind": kind, "exception": type(exc).__name__}
                logger.error("llm_call purpose=%s outcome=failed kind=%s attempts=%s ms=%s exception=%s", purpose, kind, attempt,
                             int((self._clock() - started) * 1000), type(exc).__name__)
                raise
            self.counters[purpose]["ok"] += 1
            logger.info("llm_call purpose=%s outcome=ok attempts=%s ms=%s", purpose, attempt, int((self._clock() - started) * 1000))
            return result
        raise last_exc  # unreachable: the loop either returns or raises

    def status(self) -> dict:
        return {
            "quota_breaker_open": self._breaker_remaining() > 0, "quota_breaker_seconds_remaining": self._breaker_remaining(),
            "counters": {p: dict(c) for p, c in self.counters.items()}, "last_failure": self.last_failure,
        }


controls = LlmControls()
