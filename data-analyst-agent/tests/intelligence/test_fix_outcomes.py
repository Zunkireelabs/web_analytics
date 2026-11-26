"""Measured fix outcomes -> an honest confidence on impact predictions. Pure logic; the stored round trip is in test_fix_outcomes_db.py."""
import asyncio
from types import SimpleNamespace

import pytest

from app.intelligence import impact_prediction
from app.intelligence.fix_outcomes import (
    CATEGORY_BY_GENERATOR, MIN_MEASURED_FOR_CONFIDENCE, category_for_generator, wilson_lower_bound,
)


def test_wilson_lower_bound_is_cautious_with_small_samples():
    assert wilson_lower_bound(0, 0) is None
    five_of_five = wilson_lower_bound(5, 5)
    assert 0.5 < five_of_five < 0.6          # five wins out of five is NOT 100%
    assert wilson_lower_bound(50, 50) > 0.9  # but fifty out of fifty is strong
    assert wilson_lower_bound(0, 5) == 0.0
    # the same 30% rate: more evidence raises the bound toward the rate, but it never reaches or passes it
    assert wilson_lower_bound(3, 10) < wilson_lower_bound(30, 100) < 0.3


def test_a_generator_without_a_category_has_none_and_is_never_guessed():
    assert category_for_generator("meta-title") == "metadata"
    assert category_for_generator("expand-content") == "content"
    assert category_for_generator("some-new-generator") is None
    assert category_for_generator(None) is None
    assert set(CATEGORY_BY_GENERATOR.values()) <= {"metadata", "content", "technical", "restructuring"}


class _Session:
    """Returns the (measured, improved) counts the evidence query would."""
    def __init__(self, counts):
        self.counts, self.added = counts, []

    async def get(self, *_a):
        return SimpleNamespace(metric_key="gsc_clicks")

    def add(self, obj):
        self.added.append(obj)

    async def execute(self, _stmt):
        return SimpleNamespace(one=lambda: self.counts)


def _predict(counts):
    session = _Session(counts)
    asyncio.run(impact_prediction._predict(session, 1, SimpleNamespace(id=7, insight_id=3)))
    (row,) = session.added
    return row


def test_too_few_measured_outcomes_means_no_confidence_but_the_count_is_shown():
    row = _predict((MIN_MEASURED_FOR_CONFIDENCE - 1, 4))
    assert row.confidence is None
    assert row.method_detail["measured_outcomes"] == {
        "measured": MIN_MEASURED_FOR_CONFIDENCE - 1, "improved": 4, "needed": MIN_MEASURED_FOR_CONFIDENCE, "enough": False, "confidence": None,
    }


def test_enough_measured_outcomes_give_a_measured_confidence_that_changes_with_the_evidence():
    good = _predict((20, 18))
    bad = _predict((20, 4))
    assert good.confidence is not None and bad.confidence is not None
    assert good.confidence > bad.confidence
    assert good.confidence < 18 / 20          # a lower bound, never the raw rate
    assert good.method_detail["measured_outcomes"]["enough"] is True
    assert good.method_detail["fitted_to_client_data"] is False   # duration and magnitude are still the static lookup


@pytest.mark.parametrize("counts", [(0, 0), (4, 4)])
def test_no_confidence_is_ever_invented_below_the_minimum(counts):
    assert _predict(counts).confidence is None
