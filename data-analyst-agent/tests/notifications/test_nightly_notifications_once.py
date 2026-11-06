"""Predictive alerts and the morning briefing go out ONCE per day, however many times a nightly run reaches its end (production's
scheduler, a manual staging run on the same shared database, a retried pass). Real Postgres (ANALYST_TEST_DATABASE_URL, with
DATABASE_URL pointing at the same database); skipped otherwise. Uses one fixture client; everything it changes is restored, even
when the test fails."""
import os
from datetime import date

import pytest
import pytest_asyncio

DB_URL = os.environ.get("ANALYST_TEST_DATABASE_URL")
pytestmark = [
    pytest.mark.skipif(not DB_URL or os.environ.get("DATABASE_URL") != DB_URL, reason="needs the test database"),
    pytest.mark.asyncio(loop_scope="module"),
]
CLIENT = 990_003


async def _sql(stmt, **params):
    from sqlalchemy import text
    from app.db.session import SessionLocal
    async with SessionLocal() as s:
        result = await s.execute(text(stmt), params)
        rows = result.all() if result.returns_rows else None
        await s.commit()
        return rows


async def _cleanup():
    await _sql("DELETE FROM executive_briefings WHERE client_id = :c", c=CLIENT)
    await _sql("DELETE FROM insights WHERE client_id = :c", c=CLIENT)
    await _sql("DELETE FROM clients WHERE id = :c", c=CLIENT)
    await _sql("DELETE FROM ai_activity_log WHERE task_type = 'notifying'")


@pytest_asyncio.fixture(loop_scope="module")
async def world(monkeypatch):
    await _cleanup()
    # only the fixture client is active during the test; exactly the clients paused here are re-activated afterwards
    paused = [r[0] for r in (await _sql("UPDATE clients SET status = 'paused' WHERE status = 'active' RETURNING id") or [])]
    try:
        await _sql("INSERT INTO clients (id, name, status, mcp_token_ciphertext, mcp_token_prefix) "
                   "VALUES (:c, 'notify fixture', 'active', '\\x00'::bytea, 'n')", c=CLIENT)
        await _sql("INSERT INTO metrics_catalog (metric_key, display_name, unit, cadence, enabled, category, source, aggregation_strategy, collector_id) "
                   "VALUES ('gsc_clicks', 'Clicks', 'count', 'daily', true, 'search', 'gsc', 'sum', 'test') ON CONFLICT (metric_key) DO NOTHING")
        await _sql("INSERT INTO insights (client_id, metric_key, dimension_type, dimension_value, period_start, insight_type, severity, evidence) "
                   "VALUES (:c, 'gsc_clicks', 'site', '__site__', :d, 'forecast_risk', 'high', '{\"predicted_change_pct\": -30}')",
                   c=CLIENT, d=date.today())
        pushed = []

        async def fake_push(mcp, alerts):
            pushed.append(len(alerts))
            return {"delivered": len(alerts)}

        async def no_llm(*_a, **_k):
            raise RuntimeError("no LLM in tests")

        import app.alerts.deliver as deliver
        import app.briefings.generator as gen
        monkeypatch.setattr(deliver, "push_predictive_alert", fake_push)
        monkeypatch.setattr(deliver, "McpClient", lambda *_a, **_k: object())
        monkeypatch.setattr(gen, "call_llm", no_llm)
        yield pushed
    finally:
        await _cleanup()
        for cid in paused:
            await _sql("UPDATE clients SET status = 'active' WHERE id = :i", i=cid)


async def test_a_second_run_on_the_same_day_sends_nothing_again(world):
    from app.notifications.nightly import send_nightly_notifications
    assert await send_nightly_notifications() is True
    assert await send_nightly_notifications() is False
    assert world == [1], "the alert was pushed exactly once"
    rows = await _sql("SELECT count(*) FROM executive_briefings WHERE client_id = :c AND cadence = 'morning'", c=CLIENT)
    assert rows[0][0] == 1, "exactly one morning briefing"


async def test_the_briefing_generator_alone_is_also_once_per_client_and_day(world):
    from app.briefings.generator import generate_morning_briefing
    await generate_morning_briefing()
    await generate_morning_briefing()
    rows = await _sql("SELECT count(*) FROM executive_briefings WHERE client_id = :c AND cadence = 'morning'", c=CLIENT)
    assert rows[0][0] == 1


async def test_a_failed_send_is_not_recorded_as_sent_so_the_next_run_retries(world, monkeypatch):
    import app.notifications.nightly as nightly

    async def broken():
        raise RuntimeError("alert delivery crashed")

    monkeypatch.setattr(nightly, "deliver_predictive_alerts", broken)
    with pytest.raises(RuntimeError):
        await nightly.send_nightly_notifications()
    assert await nightly.notifications_sent_today() is False
