from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.config import settings

# statement_cache_size=0 disables asyncpg's client-side prepared-statement
# cache — required against a transaction-mode pgbouncer (Supabase's
# Transaction Pooler, port 6543, which this DATABASE_URL now points at):
# each query in a transaction can land on a different real backend
# connection, so a statement prepared against one backend and reused
# against another fails with "prepared statement ... does not exist".
# Session-mode pgbouncer (and a direct connection) don't have this failure
# mode, but leaving the cache off costs nothing there either.
engine = create_async_engine(
    settings.database_url, pool_pre_ping=True,
    connect_args={"statement_cache_size": 0},
)
SessionLocal = async_sessionmaker(engine, expire_on_commit=False, class_=AsyncSession)


async def get_session() -> AsyncSession:
    async with SessionLocal() as session:
        yield session
