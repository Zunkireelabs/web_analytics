"""Pure-function tests for the new insight_type render branches added to
app/insights/recommendations.py::_render — content_decay,
target_keyword_evidence (all 4 actionable classifications), and
cannibalization. _render never touches a DB/session, so these are
straightforward direct calls."""
from datetime import date

from app.db.models import Insight
from app.insights.recommendations import _render


def _insight(insight_type, evidence, metric_key="gsc_clicks"):
    return Insight(
        id=1, client_id=1, metric_key=metric_key, dimension_type="page", dimension_value="https://x.com/p",
        period_start=date(2026, 8, 17), insight_type=insight_type, severity="high", evidence=evidence,
    )


def test_content_decay_renders_a_grounded_sentence():
    text = _render(_insight("content_decay", {
        "wow_pct_changes": [-20.0, -18.0, -16.0], "mom_pct_change": -25.0,
    }), None)
    assert text is not None
    assert "3 consecutive weeks" in text
    assert "25.0%" in text


def test_target_keyword_evidence_content_gap_renders():
    text = _render(_insight("target_keyword_evidence", {
        "classification": "TARGET_WITH_CONTENT_GAP", "topic": "best hiking boots",
        "existing_page_match": "https://x.com/boots", "word_count": 120, "thin_content_threshold_words": 300,
    }), None)
    assert "best hiking boots" in text
    assert "120 words" in text


def test_target_keyword_evidence_existing_demand_renders():
    text = _render(_insight("target_keyword_evidence", {
        "classification": "TARGET_WITH_EXISTING_DEMAND", "topic": "trail maps",
        "impressions": 500, "best_avg_position": None,
    }), None)
    assert "trail maps" in text
    assert "500" in text


def test_target_keyword_evidence_ranking_signal_renders():
    text = _render(_insight("target_keyword_evidence", {
        "classification": "TARGET_WITH_RANKING_SIGNAL", "topic": "trail maps",
        "impressions": 500, "best_avg_position": 8.0,
    }), None)
    assert "8.0" in text


def test_target_keyword_evidence_relevant_existing_page_renders():
    text = _render(_insight("target_keyword_evidence", {
        "classification": "TARGET_WITH_RELEVANT_EXISTING_PAGE", "topic": "trail maps",
        "existing_page_match": "https://x.com/maps", "word_count": 900,
    }), None)
    assert "https://x.com/maps" in text


def test_cannibalization_renders_a_grounded_sentence():
    text = _render(_insight("cannibalization", {
        "pages": [{"page": "https://x.com/a"}, {"page": "https://x.com/b"}],
    }), None)
    assert "2 of this site's own pages" in text
    assert "https://x.com/a" in text and "https://x.com/b" in text
