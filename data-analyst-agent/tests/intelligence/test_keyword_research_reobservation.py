"""Regression tests for the research-gap re-observation deadlock
(app/intelligence/keyword_clustering.py::gaps_from_research).

WHY THIS FILE EXISTS, and why the existing green suite did not catch the bug
it covers: server/store/data-analyst-tenant-isolation.test.js already asserts
that observation_count increments to 2 on re-discovery, and it passes. It
passes because it calls saveKeywordGaps directly. The real pipeline never got
that far — gaps_from_research filtered every already-persisted topic out
BEFORE save_keyword_gaps was reached, so a research-sourced gap's count could
never leave 1, while qualifyAndShipContentGaps requires >= 2. 111 of site 1's
118 rows were stranded exactly there. A test that exercises the store but not
the caller proves the wrong half of the path.

Same "no DB/MCP harness, test the pure decision function directly" convention
as test_cannibalization.py.
"""
from app.intelligence.keyword_clustering import (
    EXTERNAL_RESEARCH_RANKING_THRESHOLD, gaps_from_research,
)


def _researched(keyword, difficulty="medium", intent="informational"):
    return {"keyword": keyword, "estimated_difficulty": difficulty, "search_intent": intent}


def test_already_persisted_topic_is_re_emitted_so_it_can_be_re_observed():
    """THE regression. A topic discovered in an earlier week must still be
    emitted this week — that re-emission is the only way saveKeywordGaps is
    reached, and therefore the only way observation_count can ever reach the
    >= 2 that qualifyAndShipContentGaps demands."""
    researched = [_researched("study in canada from nepal")]
    # seen_this_run starts EMPTY — previously the caller seeded it with every
    # already-persisted gap, which is precisely what caused the deadlock.
    gaps = gaps_from_research("study abroad", researched, {}, set())
    assert len(gaps) == 1
    assert gaps[0]["topic"] == "study in canada from nepal"


def test_same_keyword_twice_in_one_run_is_emitted_once():
    """Within a single run, one observation — not one per topic-loop
    iteration. This is the guard that must survive; it is not the one that
    caused the deadlock."""
    seen = set()
    first = gaps_from_research("study abroad", [_researched("ielts prep")], {}, seen)
    second = gaps_from_research("test prep", [_researched("ielts prep")], {}, seen)
    assert len(first) == 1
    assert second == []


def test_step3_clustering_gaps_are_not_duplicated_by_research():
    """The collector seeds seen_this_run with this run's own clustering gaps,
    so research cannot re-emit something step 3 already emitted this run."""
    seen = {"ielts prep"}
    assert gaps_from_research("test prep", [_researched("IELTS Prep")], {}, seen) == []


def test_keyword_already_ranking_well_is_not_a_gap_and_is_not_re_observed():
    """Coverage is still the substantive test. A topic the site now ranks for
    has stopped being an opportunity, so it must NOT be re-observed — its
    observation_count should stall, and it should age out rather than
    accumulate its way to shipping."""
    strong = EXTERNAL_RESEARCH_RANKING_THRESHOLD - 1
    positions = {"study in canada from nepal": float(strong)}
    assert gaps_from_research("study abroad", [_researched("study in canada from nepal")], positions, set()) == []


def test_keyword_ranking_poorly_is_still_a_gap():
    weak = EXTERNAL_RESEARCH_RANKING_THRESHOLD + 5
    positions = {"study in denmark from nepal": float(weak)}
    gaps = gaps_from_research("study abroad", [_researched("study in denmark from nepal")], positions, set())
    assert len(gaps) == 1


def test_seen_this_run_is_mutated_in_place_for_the_callers_loop():
    """The collector relies on this: one set threaded through every topic
    iteration, so cross-topic duplicates within the run are caught."""
    seen = set()
    gaps_from_research("study abroad", [_researched("masters in germany")], {}, seen)
    assert "masters in germany" in seen
