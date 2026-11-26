"""Whether a client has a usable MCP token, and the one place an MCP client is built.

A project registered without a token (PUT /admin/clients/by-site/{id}, app/api/routes/admin_clients.py) is stored with an
encrypted EMPTY string and the literal prefix "(none)": that is the platform's explicit "database-only" mode. Before this
module, every caller still built an McpClient from that placeholder and sent `Authorization: Bearer ` with nothing after it,
which httpx rejects (`LocalProtocolError: Illegal header value b'Bearer '`). Production showed it as 127 failed
keyword_clustering and 117 failed monthly_metrics runs in 14 days, on exactly the five projects stored that way, while the
collectors that have a database fallback quietly hid the same problem.

Rule: an McpClient is NEVER constructed from the placeholder. A caller asks `build_mcp_client` and gets either a client or
None plus a reason code it records, so "MCP unavailable because there is no token" is a named, visible state, not an HTTP
error from a half-built request."""
from __future__ import annotations

import logging

from app.mcp_client.client import McpClient, NoMcpTokenError

logger = logging.getLogger(__name__)

NO_MCP_TOKEN = "no_mcp_token"
MCP_TOKEN_UNREADABLE = "mcp_token_unreadable"

# What admin_clients.py writes into mcp_token_prefix when no real token was provided.
PLACEHOLDER_PREFIX = "(none)"


def build_mcp_client(client) -> tuple[McpClient | None, str | None]:
    """(McpClient, None) for a client with a real token; (None, reason) otherwise. The reason is one of NO_MCP_TOKEN or
    MCP_TOKEN_UNREADABLE (stored ciphertext that cannot be decrypted with this service's key: a configuration problem, not
    a database-only project, and reported as such)."""
    if getattr(client, "mcp_token_prefix", None) == PLACEHOLDER_PREFIX:
        return None, NO_MCP_TOKEN
    try:
        return McpClient(client.mcp_token_ciphertext), None
    except NoMcpTokenError:
        return None, NO_MCP_TOKEN
    except Exception:  # noqa: BLE001 — a bad ciphertext/key must not stop the other clients; it is recorded under its own code
        logger.exception("mcp token for client %s could not be decrypted", getattr(client, "id", "?"))
        return None, MCP_TOKEN_UNREADABLE


def mcp_mode(client) -> str:
    """'mcp' | 'database_only' | 'token_unreadable': what the evidence-status route shows for a client."""
    _, reason = build_mcp_client(client)
    if reason is None:
        return "mcp"
    return "database_only" if reason == NO_MCP_TOKEN else "token_unreadable"


def require_mcp(client, purpose: str) -> McpClient | None:
    """For a step that has no database fallback (alerts, drafts, keyword evidence): the client, or None after logging the
    reason code, so the caller skips THIS client for that purpose and says why."""
    mcp, reason = build_mcp_client(client)
    if mcp is None:
        logger.warning("%s: client %s skipped, %s (no MCP client built; no database fallback for this step)", purpose, client.id, reason)
    return mcp
