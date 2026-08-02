import itertools
import json

import httpx

from app.config import settings
from app.security.secrets import decrypt_token

_id_counter = itertools.count(1)


class McpToolError(Exception):
    """The MCP endpoint returned isError:true for a tool call."""


class McpAuthError(Exception):
    """401/403 — revoked token or suspended site. Caller should mark the
    ingestion run as insufficient-data, never retry-loop on this."""


class McpClient:
    """Thin client for the existing Node app's POST /api/mcp endpoint.
    One instance per client (per-client bearer token) — never shares a token
    across clients. This is the ONLY interface this service ever calls for
    production data; it never touches the Node app's Postgres directly."""

    def __init__(self, mcp_token_ciphertext: bytes):
        self._token = decrypt_token(mcp_token_ciphertext)

    async def call_tool(self, tool_name: str, arguments: dict | None = None) -> dict:
        payload = {
            "jsonrpc": "2.0",
            "id": next(_id_counter),
            "method": "tools/call",
            "params": {"name": tool_name, "arguments": arguments or {}},
        }
        headers = {
            "Content-Type": "application/json",
            "Accept": "application/json, text/event-stream",
            "Authorization": f"Bearer {self._token}",
        }
        async with httpx.AsyncClient(timeout=30.0) as client:
            resp = await client.post(settings.mcp_base_url, json=payload, headers=headers)

        if resp.status_code in (401, 403):
            raise McpAuthError(f"{tool_name}: {resp.status_code} — token revoked or site suspended")
        resp.raise_for_status()

        message = _parse_response_body(resp)
        if "error" in message:
            raise McpToolError(f"{tool_name}: {message['error']}")

        result = message.get("result", {})
        if result.get("isError"):
            text = _extract_text(result)
            raise McpToolError(f"{tool_name}: {text}")
        return json.loads(_extract_text(result))


def _extract_text(result: dict) -> str:
    for block in result.get("content", []):
        if block.get("type") == "text":
            return block["text"]
    return ""


def _parse_response_body(resp: httpx.Response) -> dict:
    content_type = resp.headers.get("content-type", "")
    if "text/event-stream" in content_type:
        for line in resp.text.splitlines():
            if line.startswith("data:"):
                return json.loads(line[len("data:"):].strip())
        raise McpToolError("SSE response contained no data: frame")
    return resp.json()
