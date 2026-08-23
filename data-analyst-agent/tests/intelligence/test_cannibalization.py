"""Pure-function tests for the cannibalization grading decision
(app/intelligence/cannibalization.py::_grade_candidate) — same "no DB/MCP
harness, test the pure decision function directly" convention used
throughout this repo's test suite."""
from app.intelligence.cannibalization import MIN_AGGREGATE_IMPRESSIONS, _grade_candidate


def _page(page, clicks, impressions, avg_position=5.0):
    return {"page": page, "clicks": clicks, "impressions": impressions, "avg_position": avg_position}


def test_single_page_is_not_a_conflict():
    assert _grade_candidate([_page("https://x.com/a", 10, 100)], []) is None


def test_low_aggregate_demand_is_rejected_even_with_two_ranking_pages():
    pages = [_page("https://x.com/a", 3, 4), _page("https://x.com/b", 2, 3)]
    assert sum(p["impressions"] for p in pages) < MIN_AGGREGATE_IMPRESSIONS
    assert _grade_candidate(pages, []) is None


def test_high_demand_but_stable_single_owner_is_rejected():
    # Page A dominates in both windows and page B is far behind — real
    # aggregate demand, but not genuine competing ownership.
    recent = [_page("https://x.com/a", 100, 300), _page("https://x.com/b", 2, 5)]
    prior = [_page("https://x.com/a", 90, 280), _page("https://x.com/b", 1, 4)]
    assert sum(p["impressions"] for p in recent) >= MIN_AGGREGATE_IMPRESSIONS
    assert _grade_candidate(recent, prior) is None


def test_leadership_change_between_windows_is_a_genuine_finding():
    recent = [_page("https://x.com/b", 60, 200), _page("https://x.com/a", 40, 150)]
    prior = [_page("https://x.com/a", 60, 200), _page("https://x.com/b", 40, 150)]
    result = _grade_candidate(recent, prior)
    assert result is not None
    assert result["evidence"]["leading_page_recent"] == "https://x.com/b"
    assert result["evidence"]["leading_page_prior"] == "https://x.com/a"


def test_no_prior_window_data_falls_back_to_same_window_closeness_check():
    # New conflict, no prior-window candidate — close clicks (within 2x)
    # between the top two pages is itself evidence of split ownership.
    recent = [_page("https://x.com/a", 50, 200), _page("https://x.com/b", 40, 150)]
    result = _grade_candidate(recent, [])
    assert result is not None


def test_no_prior_window_data_and_a_lopsided_leader_is_rejected():
    recent = [_page("https://x.com/a", 100, 300), _page("https://x.com/b", 5, 20)]
    assert _grade_candidate(recent, []) is None


def test_severity_escalates_with_impression_magnitude():
    recent = [_page("https://x.com/b", 500, MIN_AGGREGATE_IMPRESSIONS * 2), _page("https://x.com/a", 400, MIN_AGGREGATE_IMPRESSIONS * 2)]
    prior = [_page("https://x.com/a", 500, MIN_AGGREGATE_IMPRESSIONS * 2), _page("https://x.com/b", 400, MIN_AGGREGATE_IMPRESSIONS * 2)]
    result = _grade_candidate(recent, prior)
    assert result["severity"] == "high"

    recent_small = [_page("https://x.com/b", 10, MIN_AGGREGATE_IMPRESSIONS), _page("https://x.com/a", 8, MIN_AGGREGATE_IMPRESSIONS)]
    prior_small = [_page("https://x.com/a", 10, MIN_AGGREGATE_IMPRESSIONS), _page("https://x.com/b", 8, MIN_AGGREGATE_IMPRESSIONS)]
    result_small = _grade_candidate(recent_small, prior_small)
    assert result_small["severity"] == "medium"
