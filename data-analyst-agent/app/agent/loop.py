"""Tool-calling orchestration for POST /ask/{client_id}. Decides which of
the 5 cache tools to call (via Claude) and dispatches them to handlers.py,
closed over the caller's already-validated client_id — client_id is never
something the model can set. Mirrors the sibling Node app's
agentic-orchestrator.js pattern (bounded rounds, bounded tool calls) but
reads only the nightly cache, never MCP, never live recomputation."""
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.agent.handlers import HANDLERS
from app.agent.narrator import call_claude
from app.agent.tools import build_tool_definitions
from app.db.models import MetricCatalog

MAX_ROUNDS = 4


async def ask(session: AsyncSession, client_id: int, question: str) -> dict:
    enabled_metric_keys = list(
        (await session.execute(select(MetricCatalog.metric_key).where(MetricCatalog.enabled.is_(True)))).scalars()
    )
    tools = build_tool_definitions(enabled_metric_keys)
    messages = [{"role": "user", "content": question}]
    trace = []

    for _round in range(MAX_ROUNDS):
        response = await call_claude(messages, tools)
        messages.append({"role": "assistant", "content": response.content})

        tool_uses = [block for block in response.content if block.type == "tool_use"]
        if not tool_uses:
            final_text = "".join(block.text for block in response.content if block.type == "text")
            return {"answer": final_text, "status": "ok", "tool_calls": trace}

        tool_results = []
        for call in tool_uses:
            handler = HANDLERS.get(call.name)
            if handler is None:
                result = {"error": f"unknown tool {call.name}"}
            else:
                result = await handler(session, client_id, **call.input)
            trace.append({"tool": call.name, "input": call.input})
            tool_results.append({"type": "tool_result", "tool_use_id": call.id, "content": _stringify(result)})
        messages.append({"role": "user", "content": tool_results})

    return {"answer": "Reached the maximum number of tool-call rounds without a final answer.", "status": "error", "tool_calls": trace}


def _stringify(result: dict) -> str:
    import json
    return json.dumps(result)
