"""Measured fix outcomes against a REAL Postgres: stored once, kept per client, and they change a later impact prediction.

Opt-in and local-only like tests/predict/test_prediction_layer_db.py: skipped unless DATABASE_URL is the local scratch analyst database,
so it can never touch production. Creates two clients and deletes them (cascade) afterwards."""
from datetime import date, datetime, timezone

import pytest
import pytest_asyncio
from sqlalchemy import delete, func, select

from app.config import settings

LOCAL_SCRATCH = "127.0.0.1:55432/analyst_stage1_test"
pytestmark = [
    pytest.mark.skipif(LOCAL_SCRATCH not in settings.database_url, reason="opt-in: needs the local scratch analyst database"),
    pytest.mark.asyncio(loop_scope="module"),
]

from app.api.routes.fix_outcomes import FixOutcomeIn, post_fix_outcome  # noqa: E402
from app.db.models import AnalystRecommendations, Client, FixOutcome, ImpactPrediction, Insight, MetricCatalog  # noqa: E402
from app.db.session import SessionLocal  # noqa: E402
from app.intelligence import impact_prediction  # noqa: E402
from app.intelligence.fix_outcomes import MIN_MEASURED_FOR_CONFIDENCE, measured_evidence  # noqa: E402
from app.security.secrets import encrypt_token  # noqa: E402

A, B = 990011, 990012
NOW = datetime(2026, 11, 26, tzinfo=timezone.utc)


@pytest_asyncio.fixture(autouse=True, loop_scope="module")
async def _clean():
    async def wipe():
        async with SessionLocal() as s:
            await s.execute(delete(Client).where(Client.id.in_([A, B])))
            await s.commit()
    await wipe()
    async with SessionLocal() as s:
        for cid in (A, B):
            s.add(Client(id=cid, name=f"stage5-itest-{cid}", status="active", timezone="UTC", mcp_token_ciphertext=encrypt_token(""),
                         mcp_token_prefix="(none)", mcp_permission_level="read_only"))
        await s.commit()
    yield
    await wipe()


async def _send(client_id, ref, generator="meta-title", improved=True, delta=12.0):
    async with SessionLocal() as s:
        client = await s.get(Client, client_id)
        return await post_fix_outcome(
            FixOutcomeIn(external_ref=ref, generator_id=generator, improved=improved, clicks_delta=delta, delta={"clicks": delta}, measured_at=NOW),
            client=client, session=s,
        )


async def _count(client_id):
    async with SessionLocal() as s:
        return (await s.execute(select(func.count()).select_from(FixOutcome).where(FixOutcome.client_id == client_id))).scalar_one()


async def test_a_retried_send_updates_the_same_row_instead_of_adding_another():
    first = await _send(A, "analyst_evidence:1", improved=False, delta=-3.0)
    again = await _send(A, "analyst_evidence:1", improved=True, delta=9.0)
    assert first["id"] == again["id"] and await _count(A) == 1
    async with SessionLocal() as s:
        row = await s.get(FixOutcome, again["id"])
        assert row.improved is True and float(row.clicks_delta) == 9.0     # the retry's value wins


async def test_a_generator_with_no_category_is_stored_but_never_counted():
    result = await _send(A, "analyst_evidence:2", generator="something-new")
    assert result == {"id": result["id"], "category": None, "counts_toward_confidence": False}
    async with SessionLocal() as s:
        assert (await measured_evidence(s, A, "metadata"))["measured"] == 0


async def test_one_clients_outcomes_never_count_for_another():
    for i in range(MIN_MEASURED_FOR_CONFIDENCE):
        await _send(A, f"analyst_evidence:{i}")
    async with SessionLocal() as s:
        assert (await measured_evidence(s, A, "metadata"))["enough"] is True
        b = await measured_evidence(s, B, "metadata")
        assert b["measured"] == 0 and b["confidence"] is None


async def test_measured_outcomes_change_the_confidence_of_a_later_prediction():
    async with SessionLocal() as s:
        if await s.get(MetricCatalog, "gsc_clicks") is None:
            pytest.skip("scratch database has no gsc_clicks in metrics_catalog")
        insight = Insight(client_id=A, metric_key="gsc_clicks", dimension_type="page", dimension_value="/p", period_start=date(2026, 11, 20),
                          insight_type="trend_shift", severity="high", evidence={})
        s.add(insight)
        await s.flush()
        before_rec = AnalystRecommendations(client_id=A, insight_id=insight.id, priority="high", recommendation_text="x")
        after_rec = AnalystRecommendations(client_id=A, insight_id=insight.id, priority="high", recommendation_text="y")
        s.add_all([before_rec, after_rec])
        await s.flush()
        await impact_prediction._predict(s, A, before_rec)          # nothing measured yet
        await s.commit()
        before_id, after_id = before_rec.id, after_rec.id

    # metadata is the category of gsc_ctr; gsc_clicks is "content": measure content fixes, 8 of 10 improved clicks
    for i in range(10):
        await _send(A, f"analyst_evidence:c{i}", generator="expand-content", improved=i < 8)

    async with SessionLocal() as s:
        after_rec = await s.get(AnalystRecommendations, after_id)
        await impact_prediction._predict(s, A, after_rec)           # the same kind of fix, predicted after the evidence landed
        await s.commit()
        rows = {p.recommendation_id: p for p in (await s.execute(select(ImpactPrediction).where(ImpactPrediction.client_id == A))).scalars()}

    assert rows[before_id].confidence is None                        # existing predictions are never rewritten
    later = rows[after_id]
    assert later.confidence is not None and 0.4 < float(later.confidence) < 0.8   # lower bound of 8/10, not the raw 0.8
    assert later.method_detail["measured_outcomes"]["measured"] == 10 and later.method_detail["measured_outcomes"]["improved"] == 8


async def test_the_node_payload_is_accepted_over_http_with_the_admin_key_and_an_unknown_project_gets_a_404():
    """The exact body the Node app sends (server/agents/lib/analyst-outcome.js), through the real app: auth, validation, the tenant gate."""
    import httpx
    from app.main import app

    body = {"external_ref": "analyst_evidence:77", "generator_id": "meta-title", "improved": True, "clicks_delta": 12,
            "delta": {"clicks": 12, "impressions": 300}, "measured_at": "2026-11-20T00:00:00.000Z"}
    headers = {"X-Admin-Key": settings.admin_api_key}
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://analyst") as c:
        ok = await c.post(f"/clients/{A}/fix-outcomes", json=body, headers=headers)
        assert ok.status_code == 200 and ok.json()["category"] == "metadata" and ok.json()["counts_toward_confidence"] is True
        assert (await c.post(f"/clients/{A}/fix-outcomes", json=body)).status_code == 401                       # no admin key
        assert (await c.post("/clients/999999999/fix-outcomes", json=body, headers=headers)).status_code == 404  # unknown project: permanent, not retried
        assert (await c.post(f"/clients/{A}/fix-outcomes", json={**body, "improved": "maybe?"}, headers=headers)).status_code == 422
    assert await _count(A) == 1
