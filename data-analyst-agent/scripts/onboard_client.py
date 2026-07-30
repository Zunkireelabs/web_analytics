"""Register one client with this service.

The raw MCP token itself is minted through the existing Node app's own admin
surface (its self-serve "create token" route, or the create_api_token admin
MCP tool) — never by this script, since a brand-new client has no token yet
to call MCP with in the first place. This script only encrypts and stores a
token an admin already has in hand, alongside the client's own site_id
(which MUST equal the Node app's sites.id — see clients table comment).

Usage:
  python -m scripts.onboard_client --client-id 42 --name "Acme Co" --token <raw-token>
"""
import argparse
import asyncio

from sqlalchemy.dialects.postgresql import insert as pg_insert

from app.db.models import Client
from app.db.session import SessionLocal
from app.security.secrets import encrypt_token


async def onboard(client_id: int, name: str, token: str, timezone: str, permission_level: str) -> None:
    stmt = pg_insert(Client).values(
        id=client_id, name=name, status="active", timezone=timezone,
        mcp_token_ciphertext=encrypt_token(token), mcp_token_prefix=token[:8],
        mcp_permission_level=permission_level,
    )
    stmt = stmt.on_conflict_do_update(
        index_elements=["id"],
        set_={
            "name": stmt.excluded.name,
            "mcp_token_ciphertext": stmt.excluded.mcp_token_ciphertext,
            "mcp_token_prefix": stmt.excluded.mcp_token_prefix,
            "mcp_permission_level": stmt.excluded.mcp_permission_level,
            "timezone": stmt.excluded.timezone,
        },
    )
    async with SessionLocal() as session:
        await session.execute(stmt)
        await session.commit()
    print(f"Onboarded client {client_id} ({name}), token prefix {token[:8]}...")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--client-id", type=int, required=True, help="Must equal the Node app's sites.id")
    parser.add_argument("--name", required=True)
    parser.add_argument("--token", required=True, help="Raw MCP api_token, minted via the existing app")
    parser.add_argument("--timezone", default="UTC")
    parser.add_argument("--permission-level", default="read_only", choices=["read_only", "ai_actions", "automation", "admin"])
    args = parser.parse_args()
    asyncio.run(onboard(args.client_id, args.name, args.token, args.timezone, args.permission_level))


if __name__ == "__main__":
    main()
