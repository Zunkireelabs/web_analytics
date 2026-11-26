"""A project registered without a token is database-only. An MCP client must never be built from its placeholder (which sent
`Authorization: Bearer ` with nothing after it: 127 failed keyword_clustering and 117 failed monthly_metrics runs in 14 days in
production), and a collector with no database equivalent must record the reason code no_mcp_token."""
import asyncio
from types import SimpleNamespace

import pytest

from app.mcp_client.client import McpAuthError, McpClient, NoMcpTokenError
from app.mcp_client.datasource import DIRECT_DB, DataSource
from app.mcp_client.token import MCP_TOKEN_UNREADABLE, NO_MCP_TOKEN, build_mcp_client, mcp_mode, require_mcp
from app.security.secrets import encrypt_token


def _client(token: str, prefix: str | None = None, cid: int = 7):
    return SimpleNamespace(id=cid, mcp_token_ciphertext=encrypt_token(token), mcp_token_prefix=prefix if prefix is not None else token[:8])


def test_the_none_placeholder_never_becomes_an_mcp_client():
    placeholder = _client("", prefix="(none)")
    client, reason = build_mcp_client(placeholder)
    assert client is None and reason == NO_MCP_TOKEN
    assert mcp_mode(placeholder) == "database_only"


def test_an_empty_token_is_refused_even_if_the_prefix_is_not_the_placeholder():
    with pytest.raises(NoMcpTokenError):
        McpClient(encrypt_token(""))
    client, reason = build_mcp_client(_client("", prefix="abc"))
    assert client is None and reason == NO_MCP_TOKEN
    with pytest.raises(NoMcpTokenError):
        McpClient(encrypt_token("   "))


def test_a_real_token_builds_a_client():
    client, reason = build_mcp_client(_client("sk_realtoken_1234567890"))
    assert isinstance(client, McpClient) and reason is None
    assert mcp_mode(_client("sk_realtoken_1234567890")) == "mcp"


def test_an_undecryptable_token_is_reported_under_its_own_code_not_as_database_only():
    broken = SimpleNamespace(id=9, mcp_token_ciphertext=b"not-a-fernet-token", mcp_token_prefix="abc12345")
    client, reason = build_mcp_client(broken)
    assert client is None and reason == MCP_TOKEN_UNREADABLE
    assert mcp_mode(broken) == "token_unreadable"


def test_require_mcp_returns_none_and_never_raises_for_a_database_only_client(caplog):
    assert require_mcp(_client("", prefix="(none)"), "run_draft_trigger") is None
    assert "no_mcp_token" in caplog.text


def test_a_tool_with_no_database_equivalent_records_no_mcp_token_for_a_database_only_client():
    ds = DataSource(client_id=7, session=None, mcp=None, mcp_reason=NO_MCP_TOKEN)
    with pytest.raises(NoMcpTokenError) as e:
        asyncio.run(ds.call("save_keyword_clusters", {}))
    assert str(e.value).startswith("no_mcp_token:")
    assert isinstance(e.value, McpAuthError)  # existing handlers still treat it as "MCP unavailable for this client"


def test_a_tool_with_a_database_equivalent_is_served_from_the_database_without_a_fallback_warning(monkeypatch):
    from app.mcp_client import datasource

    async def fake_fallback(session, client_id, **kw):
        return {"rows": [1]}
    monkeypatch.setitem(datasource.FALLBACKS, "get_daily_series", fake_fallback)
    ds = DataSource(client_id=7, session=None, mcp=None, mcp_reason=NO_MCP_TOKEN)
    assert asyncio.run(ds.call("get_daily_series", {})) == {"rows": [1]}
    assert ds.provenance == DIRECT_DB
    assert ds.fallback_reasons == []  # database-only is an explicit mode, not a night-by-night fallback


def test_an_unreadable_token_served_from_the_database_stays_visible_as_a_fallback(monkeypatch):
    from app.mcp_client import datasource

    async def fake_fallback(session, client_id, **kw):
        return {}
    monkeypatch.setitem(datasource.FALLBACKS, "get_daily_series", fake_fallback)
    ds = DataSource(client_id=9, session=None, mcp=None, mcp_reason=MCP_TOKEN_UNREADABLE)
    asyncio.run(ds.call("get_daily_series", {}))
    assert any("mcp_token_unreadable" in r for r in ds.fallback_reasons)
