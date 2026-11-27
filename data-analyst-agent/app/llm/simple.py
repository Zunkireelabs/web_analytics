"""Minimal single-call JSON-completion helper — a second, deliberately
separate OpenAI touchpoint alongside app/agent/narrator.py's call_llm().
narrator.py's helper exists to emulate the Anthropic-Messages-API tool-call
shape both its own callers (agent/loop.py's multi-round tool loop,
insights/recommendations.py's forced tool call) were written against; that
translation is unnecessary indirection for a caller that just wants a plain
JSON object back from one prompt (app/intelligence/keyword_clustering.py).
Same fail-honestly-never-fabricate discipline as narrator.py and the retired
agents/clustering.py it replaces: any SDK/network/parse failure returns
None, never raises — one bad LLM response must never crash a whole
multi-site collector run."""
import json
import logging
import re

from openai import AsyncOpenAI

from app.llm import worker_queue

from app.config import settings
from app.llm.controls import LlmUnavailable, controls

logger = logging.getLogger(__name__)

_client = AsyncOpenAI(api_key=settings.openai_api_key)

MODEL = "gpt-4o-mini"


def _parse_json_response(raw: str | None) -> dict | None:
    if not raw:
        return None
    cleaned = re.sub(r"^```(?:json)?\s*|\s*```$", "", raw.strip())
    try:
        return json.loads(cleaned)
    except (json.JSONDecodeError, TypeError):
        return None


async def call_json(system: str, user: str, max_tokens: int = 800) -> dict | None:
    # All AI goes through the Claude worker (see app/llm/worker_queue.py): with LLM_WORKER_MODE=on the paid API is not used here.
    if worker_queue.worker_mode_on() and not worker_queue.paid_api_fallback():
        try:
            return _parse_json_response((await worker_queue.ask(system, user)).strip())
        except worker_queue.WorkerUnavailable as e:
            logger.warning("keyword-clustering LLM call skipped: %s", e)
            return None
    try:
        resp = await controls.run("json_completion", lambda: _client.chat.completions.create(
            model=MODEL, max_tokens=max_tokens,
            messages=[{"role": "system", "content": system}, {"role": "user", "content": user}],
        ))
        raw = (resp.choices[0].message.content or "").strip()
    except LlmUnavailable as e:
        # Quota breaker open: not attempted, already logged and counted by the controls. None keeps this helper's contract.
        logger.warning("keyword-clustering LLM call skipped: %s", e)
        return None
    except Exception:  # noqa: BLE001 — any SDK/network failure reports honestly, never fabricates a result (controls logged and counted it)
        logger.exception("keyword-clustering LLM call failed")
        return None
    return _parse_json_response(raw)
