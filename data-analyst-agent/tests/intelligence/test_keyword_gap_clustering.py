"""Pure-function tests for keyword-gap topic clustering
(app/intelligence/keyword_clustering.py::_normalize_clusters) — same
"no DB/MCP harness, test the pure decision function directly" convention as
test_target_keyword_evidence.py. find_gaps' own LLM call is not exercised
here (no network); this covers only the deterministic cleanup applied to
whatever the LLM proposed, which is the part with real logic to get wrong."""
from app.intelligence.keyword_clustering import _normalize_clusters


def gap(topic, priority="medium", cluster=None, role=None):
    return {"topic": topic, "reason": None, "priority": priority, "topic_cluster": cluster, "cluster_role": role}


def test_a_standalone_gap_with_no_cluster_is_untouched():
    gaps = [gap("solo topic")]
    result = _normalize_clusters(gaps)
    assert result[0]["topic_cluster"] is None
    assert result[0]["cluster_role"] is None


def test_a_cluster_with_fewer_than_three_members_is_ungrouped():
    gaps = [
        gap("a", cluster="Widgets", role="pillar"),
        gap("b", cluster="Widgets", role="supporting"),
    ]
    result = _normalize_clusters(gaps)
    assert all(g["topic_cluster"] is None and g["cluster_role"] is None for g in result)


def test_a_cluster_with_three_plus_members_but_no_pillar_is_ungrouped():
    gaps = [
        gap("a", cluster="Widgets", role="supporting"),
        gap("b", cluster="Widgets", role="supporting"),
        gap("c", cluster="Widgets", role="supporting"),
    ]
    result = _normalize_clusters(gaps)
    assert all(g["topic_cluster"] is None and g["cluster_role"] is None for g in result)


def test_a_well_formed_cluster_with_one_pillar_is_kept_as_is():
    gaps = [
        gap("pillar topic", cluster="Widgets", role="pillar"),
        gap("supporting one", cluster="Widgets", role="supporting"),
        gap("supporting two", cluster="Widgets", role="supporting"),
    ]
    result = _normalize_clusters(gaps)
    assert [g["cluster_role"] for g in result] == ["pillar", "supporting", "supporting"]
    assert all(g["topic_cluster"] == "Widgets" for g in result)


def test_two_pillars_in_the_same_cluster_demotes_the_lower_priority_one():
    gaps = [
        gap("pillar A", priority="medium", cluster="Widgets", role="pillar"),
        gap("pillar B", priority="high", cluster="Widgets", role="pillar"),
        gap("supporting", priority="low", cluster="Widgets", role="supporting"),
    ]
    result = _normalize_clusters(gaps)
    roles_by_topic = {g["topic"]: g["cluster_role"] for g in result}
    assert roles_by_topic["pillar B"] == "pillar"  # higher priority keeps the pillar role
    assert roles_by_topic["pillar A"] == "supporting"  # demoted, not dropped
    assert roles_by_topic["supporting"] == "supporting"


def test_two_unrelated_clusters_are_evaluated_independently():
    gaps = [
        gap("a", cluster="Widgets", role="pillar"),
        gap("b", cluster="Widgets", role="supporting"),
        gap("c", cluster="Widgets", role="supporting"),
        # A second cluster with no pillar — must not affect Widgets above.
        gap("x", cluster="Gadgets", role="supporting"),
        gap("y", cluster="Gadgets", role="supporting"),
        gap("z", cluster="Gadgets", role="supporting"),
    ]
    result = _normalize_clusters(gaps)
    by_topic = {g["topic"]: g for g in result}
    assert by_topic["a"]["cluster_role"] == "pillar"
    assert by_topic["a"]["topic_cluster"] == "Widgets"
    assert by_topic["x"]["topic_cluster"] is None
    assert by_topic["x"]["cluster_role"] is None
