import pytest_asyncio


@pytest_asyncio.fixture(autouse=True, loop_scope="module", scope="module")
async def _fresh_db_pool_per_module():
    """The service's database engine (app/db/session.py) is process-global, but each test module runs on its own event loop.
    Pooled connections opened on one module's loop cannot be used on the next ("attached to a different loop"), so the pool is
    emptied around every module. Costs nothing for tests that never touch the database."""
    from app.db.session import engine
    await engine.dispose()
    yield
    await engine.dispose()
