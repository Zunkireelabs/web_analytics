"""The impact prediction is a hand-curated rule of thumb, so it must not carry a confidence number (it was exactly 1.00 on all
364 production rows)."""
import asyncio
from types import SimpleNamespace

from app.intelligence import impact_prediction


class _FakeSession:
    def __init__(self, insight):
        self.insight, self.added = insight, []

    async def get(self, _model, _id):
        return self.insight

    def add(self, obj):
        self.added.append(obj)

    async def execute(self, _stmt):
        # no measured fixes for this client: the evidence query counts zero rows
        return SimpleNamespace(one=lambda: (0, 0))


def test_an_ok_impact_prediction_says_what_it_is_and_carries_no_confidence():
    session = _FakeSession(SimpleNamespace(metric_key="gsc_clicks"))
    asyncio.run(impact_prediction._predict(session, 1, SimpleNamespace(id=7, insight_id=3)))
    (row,) = session.added
    assert row.status == "ok" and row.confidence is None and row.confidence_score_id is None
    assert row.method_detail["basis"] == "static_category_rule" and row.method_detail["fitted_to_client_data"] is False
