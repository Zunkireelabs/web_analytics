"""run_nightly._run_one for a database-only project: a collector that needs MCP and has no database equivalent records
status insufficient-data with the reason code no_mcp_token (not 'error', not a header failure), and never builds an MCP client."""
import asyncio
from datetime import date
from types import SimpleNamespace

from app.collectors.base import Collector
from app.ingestion import run_nightly
from app.security.secrets import encrypt_token


class _Sessions:
    """Stands in for SessionLocal: records what would be written to ingestion_runs."""

    def __init__(self):
        self.added = []

    def __call__(self):
        outer = self

        class _S:
            async def __aenter__(self_inner):
                return self_inner

            async def __aexit__(self_inner, *a):
                return False

            def add(self_inner, obj):
                outer.added.append(obj)

            async def commit(self_inner):
                return None

        return _S()


class _NeedsMcpCollector(Collector):
    collector_id = "keyword_clustering"
    metric_keys = []
    requires_mcp = True
    writes_own_storage = True

    async def collect(self, *, session, client, mcp, window_start, window_end):
        await mcp.call("save_keyword_clusters", {})  # a tool with no database equivalent
        return []


def test_database_only_client_records_no_mcp_token_for_an_mcp_only_collector(monkeypatch):
    sessions = _Sessions()
    monkeypatch.setattr(run_nightly, "SessionLocal", sessions)
    built = []
    monkeypatch.setattr(run_nightly, "build_mcp_client", lambda c: (built.append(c) or (None, "no_mcp_token")))
    client = SimpleNamespace(id=8871, mcp_token_ciphertext=encrypt_token(""), mcp_token_prefix="(none)")

    asyncio.run(run_nightly._run_one(client, _NeedsMcpCollector(), date(2026, 11, 1), date(2026, 11, 25)))

    run = sessions.added[-1]
    assert run.status == "insufficient-data"
    assert run.error.startswith("no_mcp_token:")
    assert "Bearer" not in run.error and "Illegal header" not in run.error
    assert built == [client]
