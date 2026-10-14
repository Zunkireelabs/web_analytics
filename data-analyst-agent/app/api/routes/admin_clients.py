"""HTTP equivalent of scripts/onboard_client.py.

Onboarding a Node-side tenant used to require someone to run that script by
hand with a raw MCP token — a hidden manual step nothing else in the
onboarding flow surfaced, so a connected tenant could sit with no forecasts,
no anomalies and no forecast_risk recommendations indefinitely with no error
anywhere. This route lets server/lib/data-analyst-client.js call the same
upsert from Node's own connect-repo/connect-site path, closing that gap.

The token is optional here in a way the script never allowed: DataSource
(app/mcp_client/datasource.py) can serve every collector straight from the
shared database, so a client with no MCP token yet is not stuck — it simply
runs direct-db-only until a real token is minted and PUT in later.
mcp_token_ciphertext stays NOT NULL, so a placeholder (an encrypted empty
string) is stored until then. That empty token still lets McpClient
construct and call successfully as far as this service is concerned — the
Node MCP endpoint is what rejects an empty bearer with 401, which
run_nightly.py's DataSource then catches as McpAuthError and falls back to
the database, exactly like any other revoked/expired token.
"""
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import Client
from app.db.session import get_session
from app.security.auth import require_admin_key
from app.security.secrets import encrypt_token

router = APIRouter()

# Never decryptable to a usable bearer token — McpClient's own decrypt_token
# call fails loudly on this rather than silently authenticating as "".
NO_TOKEN_PLACEHOLDER = encrypt_token("")


class ClientUpsert(BaseModel):
    name: str
    timezone: str = "UTC"
    token: str | None = None
    permission_level: str = "read_only"
    industry: str | None = None


@router.put("/admin/clients/by-site/{site_id}", dependencies=[Depends(require_admin_key)])
async def upsert_client(site_id: int, body: ClientUpsert, session: AsyncSession = Depends(get_session)) -> dict:
    """`site_id` (Node's sites.id), not `client_id` — deliberately distinct
    from the rest of this API's path parameter, and not merely cosmetic: this
    route is provisioning, not reading. Every other route in this service
    resolves an id it assumes already exists via get_active_client, which
    404s an unknown one; this one is what MAKES that row exist in the first
    place, so that gate cannot apply here — see
    tests/api/test_tenant_isolation_http.py's own note on why `client_id`
    paths are checked unconditionally."""
    ciphertext = encrypt_token(body.token) if body.token else NO_TOKEN_PLACEHOLDER
    prefix = body.token[:8] if body.token else None

    stmt = pg_insert(Client).values(
        id=site_id, name=body.name, status="active", timezone=body.timezone,
        mcp_token_ciphertext=ciphertext, mcp_token_prefix=prefix or "(none)",
        mcp_permission_level=body.permission_level, industry=body.industry,
    )
    stmt = stmt.on_conflict_do_update(
        index_elements=["id"],
        set_={
            "name": stmt.excluded.name,
            "timezone": stmt.excluded.timezone,
            # A token PATCHed in later must not be silently wiped by a
            # re-run of onboarding that doesn't carry one.
            "mcp_token_ciphertext": stmt.excluded.mcp_token_ciphertext if body.token else Client.mcp_token_ciphertext,
            "mcp_token_prefix": stmt.excluded.mcp_token_prefix if body.token else Client.mcp_token_prefix,
            "mcp_permission_level": stmt.excluded.mcp_permission_level if body.token else Client.mcp_permission_level,
            "industry": stmt.excluded.industry if body.industry is not None else Client.industry,
        },
    )
    await session.execute(stmt)
    await session.commit()

    client = await session.get(Client, site_id)
    return {
        "id": client.id, "name": client.name, "status": client.status,
        "has_mcp_token": client.mcp_token_prefix not in (None, "(none)"),
    }


@router.get("/admin/clients/by-site/{site_id}", dependencies=[Depends(require_admin_key)])
async def get_client(site_id: int, session: AsyncSession = Depends(get_session)) -> dict:
    client = await session.get(Client, site_id)
    if client is None:
        raise HTTPException(status_code=404, detail="Client not onboarded.")
    return {
        "id": client.id, "name": client.name, "status": client.status,
        "has_mcp_token": client.mcp_token_prefix not in (None, "(none)"),
    }
