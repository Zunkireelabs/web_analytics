"""Server-side OpenAI controls: bounded retry for transient failures only, a quota circuit breaker, counters, and no prompt/response
or key in what is logged."""
import asyncio

import httpx
import openai
import pytest

from app.llm.controls import LlmControls, LlmUnavailable, QUOTA, TRANSIENT, classify


def _rate_limit(code):
    req = httpx.Request("POST", "https://api.openai.com/v1/chat/completions")
    resp = httpx.Response(429, request=req)
    return openai.RateLimitError("rate limited", response=resp, body={"code": code})


def _controls():
    sleeps = []

    async def sleep(s):
        sleeps.append(s)
    clock = {"t": 1000.0}
    c = LlmControls(sleep=sleep, clock=lambda: clock["t"])
    return c, sleeps, clock


def test_a_spent_quota_is_classified_apart_from_an_ordinary_rate_limit():
    e = _rate_limit("insufficient_quota")
    e.code = "insufficient_quota"
    assert classify(e) == QUOTA
    assert classify(_rate_limit("rate_limit_exceeded")) == TRANSIENT


def test_transient_failures_are_retried_with_backoff_then_succeed():
    c, sleeps, _ = _controls()
    attempts = []

    async def call():
        attempts.append(1)
        if len(attempts) < 3:
            raise openai.APIConnectionError(request=httpx.Request("POST", "https://x"))
        return "ok"
    assert asyncio.run(c.run("narrator", call)) == "ok"
    assert len(attempts) == 3 and sleeps == [1.0, 2.0]
    assert c.counters["narrator"]["retries"] == 2 and c.counters["narrator"]["ok"] == 1


def test_a_spent_quota_is_not_retried_and_opens_the_breaker_so_the_next_call_is_not_attempted():
    c, sleeps, clock = _controls()
    calls = []

    async def spent():
        calls.append(1)
        e = _rate_limit("insufficient_quota")
        e.code = "insufficient_quota"
        raise e
    with pytest.raises(openai.RateLimitError):
        asyncio.run(c.run("narrator", spent))
    assert calls == [1] and sleeps == []                   # no retry on a quota that will not heal in seconds
    with pytest.raises(LlmUnavailable) as e:
        asyncio.run(c.run("narrator", spent))
    assert calls == [1] and e.value.reason == QUOTA        # the breaker stopped the second call before it was made
    assert c.status()["quota_breaker_open"] is True
    clock["t"] += 16 * 60                                  # after the cooldown one call may probe again
    with pytest.raises(openai.RateLimitError):
        asyncio.run(c.run("narrator", spent))
    assert calls == [1, 1]


def test_a_non_transient_failure_is_raised_after_one_attempt_and_counted():
    c, sleeps, _ = _controls()

    async def bad():
        raise openai.BadRequestError("bad", response=httpx.Response(400, request=httpx.Request("POST", "https://x")), body=None)
    with pytest.raises(openai.BadRequestError):
        asyncio.run(c.run("json_completion", bad))
    assert sleeps == [] and c.counters["json_completion"]["failed_request_rejected"] == 1
    assert c.status()["last_failure"]["kind"] == "request_rejected"


def test_the_log_line_never_contains_the_prompt_or_response(caplog):
    c, _, _ = _controls()

    async def call():
        return "SECRET-RESPONSE-TEXT"
    caplog.set_level("INFO")
    asyncio.run(c.run("narrator", call))
    assert "llm_call purpose=narrator outcome=ok" in caplog.text and "SECRET" not in caplog.text
