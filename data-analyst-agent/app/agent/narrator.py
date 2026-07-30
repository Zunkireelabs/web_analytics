"""LLM Explanation Layer — the sole Anthropic API touchpoint in this
service. System prompt forbids computing new numbers, extrapolating beyond
provided evidence, or discussing a metric/dimension not present in the
structured input — the model explains what the Statistics/Forecast/
Anomaly/Insight/Recommendation Engines already computed, it never computes
anything itself. Mirrors the sibling Node app's server/llm.js: one shared
wrapper with retry/backoff, called from everywhere an LLM is needed."""
import asyncio

import anthropic

from app.config import settings

SYSTEM_PROMPT = (
    "You are a data analyst assistant for an internal, admin-only SEO/growth analytics tool. "
    "You answer questions ONLY using the tool results you are given in this conversation — every number "
    "you state must come directly from a tool result. Never compute a new number, average, percentage, or "
    "trend yourself; if a comparison isn't already in a tool result, say you don't have it cached rather than "
    "calculating it. If a tool reports status 'insufficient-data', say plainly that there isn't enough cached "
    "data to answer, rather than guessing. Be concise and concrete."
)

_client = anthropic.AsyncAnthropic(api_key=settings.anthropic_api_key)

MODEL = "claude-sonnet-4-5"
MAX_RETRIES = 3


async def call_claude(messages: list[dict], tools: list[dict] | None = None):
    last_error = None
    for attempt in range(MAX_RETRIES):
        try:
            return await _client.messages.create(
                model=MODEL, max_tokens=1024, system=SYSTEM_PROMPT,
                messages=messages, tools=tools or [],
            )
        except (anthropic.RateLimitError, anthropic.APIConnectionError, anthropic.InternalServerError) as e:
            last_error = e
            await asyncio.sleep(2 ** attempt)
    raise last_error
