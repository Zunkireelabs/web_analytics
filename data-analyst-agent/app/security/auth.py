from fastapi import Header, HTTPException

from app.config import settings


async def require_admin_key(x_admin_key: str | None = Header(default=None)) -> None:
    """Single static admin API key — this service is internal/platform-admin-only,
    never client-facing (see Part B's role-model note). Upgrade path to JWT +
    per-admin identity is documented, not built, until multi-admin audit needs arise."""
    if not x_admin_key or x_admin_key != settings.admin_api_key:
        raise HTTPException(status_code=401, detail="Missing or invalid admin API key.")
