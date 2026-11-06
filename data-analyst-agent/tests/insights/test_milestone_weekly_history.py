"""Regression test for the production failure "Multiple rows were found when one or none was required" (the investigating
stage, every run since early September 2026).

metric_period_stats keeps ONE ROW PER WEEK (its unique key includes period_end). The milestone check asked for exactly one weekly
row per client and score metric with no period_end and no ordering, so it raised as soon as a second week of history existed.
It must read the LATEST site-level weekly row, which is the row the milestone insight it writes is about.

Needs a real Postgres with this service's schema: set ANALYST_TEST_DATABASE_URL (asyncpg URL). Skipped otherwise, never faked.
Everything it writes is under one fixture client and removed afterwards.
"""
import os
from datetime import date

import pytest

DB_URL = os.environ.get("ANALYST_TEST_DATABASE_URL")
pytestmark = pytest.mark.skipif(not DB_URL, reason="set ANALYST_TEST_DATABASE_URL to a Postgres with this service's schema")

CLIENT_ID = 990_001


@pytest.fixture
async def session():
    from sqlalchemy import text
    from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine

    engine = create_async_engine(DB_URL)
    async with AsyncSession(engine, expire_on_commit=False) as s:
        await s.execute(text("DELETE FROM insights WHERE client_id = :c"), {"c": CLIENT_ID})
        await s.execute(text("DELETE FROM metric_period_stats WHERE client_id = :c"), {"c": CLIENT_ID})
        await s.execute(text("DELETE FROM clients WHERE id = :c"), {"c": CLIENT_ID})
        await s.execute(text("INSERT INTO clients (id, name, status, mcp_token_ciphertext, mcp_token_prefix) "
                             "VALUES (:c, 'milestone regression fixture', 'active', '\\x00'::bytea, 'test')"), {"c": CLIENT_ID})
        await s.execute(text(
            "INSERT INTO metrics_catalog (metric_key, display_name, unit, cadence, enabled, category, source, aggregation_strategy, collector_id) "
            "VALUES ('health_score', 'Health score', 'score_0_100', 'daily', true, 'technical', 'app', 'last_value', 'test') ON CONFLICT (metric_key) DO NOTHING"))
        await s.commit()
        yield s
        await s.execute(text("DELETE FROM insights WHERE client_id = :c"), {"c": CLIENT_ID})
        await s.execute(text("DELETE FROM metric_period_stats WHERE client_id = :c"), {"c": CLIENT_ID})
        await s.execute(text("DELETE FROM clients WHERE id = :c"), {"c": CLIENT_ID})
        await s.commit()
    await engine.dispose()


async def _week(session, period_end, prior, current, dimension_type="site", dimension_value="__site__"):
    from sqlalchemy import text
    await session.execute(text(
        "INSERT INTO metric_period_stats (client_id, metric_key, dimension_type, dimension_value, period_type, period_end, current_value, prior_value) "
        "VALUES (:c, 'health_score', :dt, :dv, 'wow', :pe, :cur, :pri)"),
        {"c": CLIENT_ID, "dt": dimension_type, "dv": dimension_value, "pe": period_end, "cur": current, "pri": prior})
    await session.commit()


async def _milestones(session):
    from sqlalchemy import text
    rows = (await session.execute(text(
        "SELECT period_start, evidence FROM insights WHERE client_id = :c AND insight_type = 'milestone' ORDER BY period_start"), {"c": CLIENT_ID})).all()
    return rows


async def test_many_weeks_of_history_no_longer_raise_and_the_latest_week_is_used(session):
    from app.insights.engine import _milestone_insights
    await _week(session, date(2026, 10, 25), prior=40, current=45)   # an old week, crosses nothing
    await _week(session, date(2026, 11, 1), prior=45, current=48)
    await _week(session, date(2026, 11, 8), prior=48, current=55)    # the latest week crosses 50
    await _milestone_insights(session, CLIENT_ID)
    await session.commit()
    rows = await _milestones(session)
    assert len(rows) == 1
    assert rows[0].period_start == date(2026, 11, 8)
    assert rows[0].evidence["crossed_band"] == 50.0


async def test_an_older_week_that_crossed_a_band_does_not_fire_when_the_latest_did_not(session):
    from app.insights.engine import _milestone_insights
    await _week(session, date(2026, 11, 1), prior=70, current=80)    # crossed 75 two weeks ago
    await _week(session, date(2026, 11, 8), prior=80, current=82)    # latest: nothing crossed
    await _milestone_insights(session, CLIENT_ID)
    await session.commit()
    assert await _milestones(session) == []


async def test_a_page_level_row_for_the_same_metric_is_not_mistaken_for_the_site(session):
    from app.insights.engine import _milestone_insights
    await _week(session, date(2026, 11, 8), prior=40, current=60, dimension_type="page", dimension_value="https://x.example/a")
    await _week(session, date(2026, 11, 8), prior=48, current=49)    # the site itself crossed nothing
    await _milestone_insights(session, CLIENT_ID)
    await session.commit()
    assert await _milestones(session) == []
