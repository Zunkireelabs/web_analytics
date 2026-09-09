"""One read interface for collectors, with MCP preferred and the shared
database as a fallback.

Collectors call the helpers in tools.py and never learn which source served
them — that is the point. What they must not do is stop working because a
second process is unreachable, which is what happened for twelve days in
August 2026 and silently emptied the whole prediction pipeline.

Precedence, deliberately in this order:
  1. MCP, when a token exists and the call succeeds. It is the Node app's
     supported contract and the only source for values Node computes rather
     than stores.
  2. The shared database, when MCP is unavailable (transport failure) or
     rejects us (401/403), AND the tool has a real Node-side table behind it
     (db_fallback.FALLBACKS).
  3. Neither -> the original exception propagates, and run_nightly records
     insufficient-data/error for that (client, collector). Nothing is ever
     invented to fill the gap.

An McpToolError is deliberately NOT fallback-eligible: it means MCP was
reachable and answered, and the tool itself objected (bad arguments, missing
permission). Re-running the same question against the database would paper
over a real defect rather than route around an outage.
"""
from app.mcp_client.client import McpAuthError, McpClient, McpToolError
from app.mcp_client.db_fallback import FALLBACKS

MCP = "mcp"
DIRECT_DB = "direct-db"


class DataSource:
    """Per (client, collector-run) read handle. Not shared across clients —
    it holds that client's MCP token and that client's id, the same one-token-
    one-client rule McpClient already enforces."""

    def __init__(self, *, client_id: int, session, mcp: McpClient | None = None):
        self.client_id = client_id
        self._session = session
        self._mcp = mcp
        # Every source actually used this run, in use order. A run that only
        # ever hit one source reports exactly that source; a run that started
        # on MCP and fell back reports both, so "mixed" is visible rather than
        # rounded to whichever came last.
        self.sources_used: list[str] = []
        self.fallback_reasons: list[str] = []

    @property
    def provenance(self) -> str | None:
        """'mcp' | 'direct-db' | 'mixed' | None (no read happened)."""
        distinct = set(self.sources_used)
        if not distinct:
            return None
        if len(distinct) == 1:
            return next(iter(distinct))
        return "mixed"

    def _record(self, source: str) -> None:
        self.sources_used.append(source)

    async def call(self, tool_name: str, arguments: dict | None = None, **db_kwargs):
        """Run one logical read. `db_kwargs` are the arguments the direct-DB
        implementation takes (which are the MCP arguments minus the transport
        wrapper, plus the session/site_id this object already holds)."""
        fallback = FALLBACKS.get(tool_name)

        if self._mcp is not None:
            try:
                result = await self._mcp.call_tool(tool_name, arguments)
                self._record(MCP)
                return result
            except McpToolError:
                # Answered and objected — a real defect, not an outage.
                raise
            except McpAuthError as e:
                if fallback is None:
                    raise
                self.fallback_reasons.append(f"{tool_name}: MCP auth rejected ({e}) — read from database instead")
            except Exception as e:  # noqa: BLE001 — transport failures carry empty messages; see run_nightly._describe
                if fallback is None:
                    raise
                reason = str(e).strip() or type(e).__name__
                self.fallback_reasons.append(f"{tool_name}: MCP unavailable ({reason}) — read from database instead")
        elif fallback is None:
            raise McpAuthError(f"{tool_name}: no MCP token for this client and no database fallback for this tool")

        result = await fallback(self._session, self.client_id, **db_kwargs)
        self._record(DIRECT_DB)
        return result
