"""The freshness gate: the analyst knows what data it has and refuses to analyse a client on stale inputs."""
from datetime import date, timedelta

from app.analysis import freshness as f

TODAY = date(2026, 11, 25)


def _ev(**ages):
    latest = {k: (TODAY - timedelta(days=v) if v is not None else None) for k, v in ages.items()}
    return f.evaluate(1, latest, TODAY)


def test_gsc_four_days_behind_is_fresh_because_search_console_publishes_late_but_six_is_stale():
    assert _ev(gsc_site=4, ga4_site=1, page_query=4).sources["gsc_site"].state == f.FRESH
    assert _ev(gsc_site=6, ga4_site=1, page_query=4).sources["gsc_site"].state == f.STALE


def test_ga4_is_held_to_the_tighter_limit():
    assert _ev(gsc_site=1, ga4_site=3, page_query=1).sources["ga4_site"].state == f.FRESH
    assert _ev(gsc_site=1, ga4_site=4, page_query=1).sources["ga4_site"].state == f.STALE


def test_a_missing_source_is_missing_not_fresh():
    ev = _ev(gsc_site=1, ga4_site=None, page_query=1)
    assert ev.sources["ga4_site"].state == f.MISSING and ev.verdict == "degraded"


def test_verdicts_match_the_node_words():
    assert _ev(gsc_site=1, ga4_site=1, page_query=1).verdict == "fresh"
    assert _ev(gsc_site=1, ga4_site=9, page_query=9).verdict == "degraded"
    assert _ev(gsc_site=9, ga4_site=9, page_query=9).verdict == "stale"


def test_a_stage_needing_all_inputs_is_refused_with_the_reason_naming_the_input():
    ev = _ev(gsc_site=1, ga4_site=1, page_query=30)
    ok, why = ev.usable(needs_all=("gsc_site", "page_query"))
    assert not ok and "page_query" in why and "30 day(s) old" in why


def test_a_stage_needing_any_input_runs_while_one_is_fresh_and_stops_when_none_is():
    assert _ev(gsc_site=9, ga4_site=1, page_query=1).usable(needs_any=("gsc_site", "ga4_site"))[0]
    ok, why = _ev(gsc_site=9, ga4_site=9, page_query=1).usable(needs_any=("gsc_site", "ga4_site"))
    assert not ok and "no required input is fresh" in why


def test_gap_codes_are_read_from_the_front_of_the_error():
    assert f.gap_code("no_mcp_token: save_keyword_clusters needs MCP") == "no_mcp_token"
    assert f.gap_code("LocalProtocolError: Illegal header value b'Bearer '") == "error"
    assert f.gap_code(None) == "error"
