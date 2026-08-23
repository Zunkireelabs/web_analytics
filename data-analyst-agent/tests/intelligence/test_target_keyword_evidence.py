"""Pure-function tests for the target-keyword evidence classification
(app/intelligence/target_keyword_evidence.py::_classify) — same "no DB/MCP
harness, test the pure decision function directly" convention as
app/investigations/drafts.py's _priority_decision tests."""
from app.intelligence.target_keyword_evidence import RANKING_POSITION_CEILING, THIN_CONTENT_WORD_COUNT, _classify


def test_no_demand_and_no_existing_page_is_insufficient_evidence():
    assert _classify(has_demand=False, best_position=None, existing_page_match=None, word_count=None) is None


def test_demand_but_no_ranking_page_is_existing_demand():
    assert _classify(has_demand=True, best_position=None, existing_page_match=None, word_count=None) == "TARGET_WITH_EXISTING_DEMAND"


def test_demand_with_a_page_ranking_beyond_the_ceiling_is_still_existing_demand_not_ranking_signal():
    assert _classify(has_demand=True, best_position=RANKING_POSITION_CEILING + 5, existing_page_match=None, word_count=None) == "TARGET_WITH_EXISTING_DEMAND"


def test_demand_with_a_page_ranking_within_the_ceiling_is_ranking_signal():
    assert _classify(has_demand=True, best_position=RANKING_POSITION_CEILING, existing_page_match=None, word_count=None) == "TARGET_WITH_RANKING_SIGNAL"


def test_existing_page_match_with_adequate_content_is_relevant_existing_page():
    assert _classify(
        has_demand=True, best_position=5, existing_page_match="https://x.com/p", word_count=THIN_CONTENT_WORD_COUNT,
    ) == "TARGET_WITH_RELEVANT_EXISTING_PAGE"


def test_existing_page_match_with_thin_content_is_content_gap():
    assert _classify(
        has_demand=False, best_position=None, existing_page_match="https://x.com/p", word_count=THIN_CONTENT_WORD_COUNT - 1,
    ) == "TARGET_WITH_CONTENT_GAP"


def test_existing_page_match_never_checked_is_content_gap_not_confirmed_thin():
    # word_count=None (never checked by technical-seo) must still route to
    # CONTENT_GAP (a real gap in the "haven't verified" sense) rather than
    # silently defaulting to RELEVANT_EXISTING_PAGE — but the evidence trail
    # (built by the caller, not this pure function) must keep word_count as
    # None so it's never conflated with a confirmed-thin page.
    assert _classify(has_demand=False, best_position=None, existing_page_match="https://x.com/p", word_count=None) == "TARGET_WITH_CONTENT_GAP"


def test_existing_page_match_takes_priority_over_demand_signal():
    # Even with strong ranking demand, a thin matched page is still a
    # content gap — the existing-page branch is checked first.
    assert _classify(
        has_demand=True, best_position=1, existing_page_match="https://x.com/p", word_count=10,
    ) == "TARGET_WITH_CONTENT_GAP"
