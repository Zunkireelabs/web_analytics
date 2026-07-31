"""LLM Explanation Layer — the sole OpenAI API touchpoint in this service
(swapped from Anthropic per product decision — see call_llm's own note).
System prompt forbids computing new numbers, extrapolating beyond provided
evidence, or discussing a metric/dimension not present in the structured
input — the model explains what the Statistics/Forecast/Anomaly/Insight/
Recommendation Engines already computed, it never computes anything
itself. Mirrors the sibling Node app's server/llm.js: one shared wrapper
with retry/backoff, called from everywhere an LLM is needed."""
import asyncio
import json
from dataclasses import dataclass

import openai
from openai import AsyncOpenAI

from app.config import settings

SYSTEM_PROMPT = (
    "You are a data analyst assistant for an internal, admin-only SEO/growth analytics tool. "
    "You answer questions ONLY using the tool results you are given in this conversation — every number "
    "you state must come directly from a tool result. Never compute a new number, average, percentage, or "
    "trend yourself; if a comparison isn't already in a tool result, say you don't have it cached rather than "
    "calculating it. If a tool reports status 'insufficient-data', say plainly that there isn't enough cached "
    "data to answer, rather than guessing. Be concise and concrete."
)

_client = AsyncOpenAI(api_key=settings.openai_api_key)

MODEL = "gpt-4o-mini"
MAX_RETRIES = 3


@dataclass
class TextBlock:
    text: str
    type: str = "text"


@dataclass
class ToolUseBlock:
    id: str
    name: str
    input: dict
    type: str = "tool_use"


@dataclass
class ChatResponse:
    content: list


async def call_llm(
    messages: list[dict], tools: list[dict] | None = None,
    tool_choice: dict | None = None, system: str | None = None,
):
    """Presents an Anthropic-Messages-API-shaped interface (messages/tools/
    tool_choice in, a response with .content blocks out) even though it
    calls OpenAI underneath — both callers (agent/loop.py's multi-round
    tool loop, insights/recommendations.py's single forced tool call) were
    written against that shape, and translating request/response here keeps
    the provider swap contained to this one file rather than touching
    either caller's conversation-building logic. system defaults to the
    /ask conversational prompt above; callers with a different task pass
    their own. tool_choice lets a caller force a specific tool call for
    structured output instead of leaving it to the model."""
    kwargs = {"model": MODEL, "messages": _to_openai_messages(system or SYSTEM_PROMPT, messages)}
    if tools:
        kwargs["tools"] = [_to_openai_tool(t) for t in tools]
        kwargs["tool_choice"] = _to_openai_tool_choice(tool_choice) if tool_choice is not None else "auto"

    last_error = None
    for attempt in range(MAX_RETRIES):
        try:
            response = await _client.chat.completions.create(**kwargs)
            return _from_openai_response(response)
        except (openai.RateLimitError, openai.APIConnectionError, openai.InternalServerError) as e:
            last_error = e
            await asyncio.sleep(2 ** attempt)
    raise last_error


def _to_openai_tool(tool: dict) -> dict:
    return {
        "type": "function",
        "function": {
            "name": tool["name"],
            "description": tool.get("description", ""),
            "parameters": tool.get("input_schema") or {"type": "object", "properties": {}},
        },
    }


def _to_openai_tool_choice(tool_choice: dict):
    if tool_choice.get("type") == "tool":
        return {"type": "function", "function": {"name": tool_choice["name"]}}
    return "auto"


def _to_openai_messages(system: str, messages: list[dict]) -> list[dict]:
    openai_messages = [{"role": "system", "content": system}]
    for m in messages:
        role, content = m["role"], m["content"]
        if isinstance(content, str):
            openai_messages.append({"role": role, "content": content})
            continue

        if role == "assistant":
            # content is the list of TextBlock/ToolUseBlock this module
            # itself returned from a prior call_llm() — never a raw
            # provider-native response, since this service never persists
            # one across process boundaries.
            text = "".join(b.text for b in content if isinstance(b, TextBlock))
            msg = {"role": "assistant", "content": text or None}
            tool_calls = [
                {"id": b.id, "type": "function", "function": {"name": b.name, "arguments": json.dumps(b.input)}}
                for b in content if isinstance(b, ToolUseBlock)
            ]
            if tool_calls:
                msg["tool_calls"] = tool_calls
            openai_messages.append(msg)
        else:
            # A user-role turn carrying Anthropic-shaped tool_result blocks
            # (built by agent/loop.py) — one OpenAI "tool" message per block.
            for block in content:
                openai_messages.append({
                    "role": "tool", "tool_call_id": block["tool_use_id"], "content": block["content"],
                })
    return openai_messages


def _from_openai_response(response) -> ChatResponse:
    message = response.choices[0].message
    blocks = []
    if message.content:
        blocks.append(TextBlock(text=message.content))
    for tc in (message.tool_calls or []):
        try:
            args = json.loads(tc.function.arguments) if tc.function.arguments else {}
        except json.JSONDecodeError:
            args = {}
        blocks.append(ToolUseBlock(id=tc.id, name=tc.function.name, input=args))
    return ChatResponse(content=blocks)
