from fastapi import Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import Client
from app.db.session import get_session
from app.security.auth import require_admin_key


async def get_active_client(
    client_id: int,
    session: AsyncSession = Depends(get_session),
    _admin: None = Depends(require_admin_key),
) -> Client:
    """The tenant-isolation gate for every per-client route — mirrors the
    Node app's suspension check in server/mcp/auth.js. 404 on an unknown
    client (never leak existence), 403 on a suspended one."""
    client = await session.get(Client, client_id)
    if client is None:
        raise HTTPException(status_code=404, detail="Client not found.")
    if client.status == "suspended":
        raise HTTPException(status_code=403, detail="Client is suspended.")
    return client
