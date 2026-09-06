"""Proves the two properties the keyword weekly cycle depends on, at the
COLLECTOR level — which is where the real bug lived.

app/intelligence/keyword_clustering.py's gaps_from_research was never itself
wrong: handed an empty dedupe set it always emitted correctly. The deadlock
was in this collector, which seeded that set with every ALREADY-PERSISTED gap
before calling it. A research topic found again in a later week was therefore
dropped here, before save_keyword_gaps was ever reached, so its
observation_count could never leave 1 — and qualifyAndShipContentGaps
(server/agents/lib/analyst-seo-mapping.js) requires >= 2.

A pure-function test of gaps_from_research passes either way and proves
nothing about this. Same reason server/store/data-analyst-tenant-isolation.test.js's
existing "observation_count increments to 2" assertion stayed green through
the whole outage: it calls saveKeywordGaps directly, and the pipeline never
got there. These tests exercise the caller.
"""
import asyncio
from datetime import date

from app.collectors import keyword_clustering as kc


class _Client:
    id = 1


def _profile():
    return {"industry": "education", "site_type": "service", "main_topics": ["study abroad"]}


def test_topic_already_persisted_is_still_sent_to_save_keyword_gaps(monkeypatch):
    """THE regression test. 'study in canada from nepal' is already a stored
    gap from an earlier week. It must still reach save_keyword_gaps, because
    that call is the only thing that can advance observation_count."""
    saved = []

    async def _fake_research(site_type, industry, topic):
        return [{"keyword": "study in canada from nepal", "estimated_difficulty": "medium", "search_intent": "informational"}]

    async def _fake_save(mcp, gaps, source):
        saved.append({"gaps": gaps, "source": source})

    monkeypatch.setattr(kc.ic, "research_topic_keywords", _fake_research)
    monkeypatch.setattr(kc, "save_keyword_gaps", _fake_save)

    collector = kc.KeywordClusteringCollector()
    asyncio.run(collector._run_external_research(None, _Client(), _profile(), [], []))

    assert len(saved) == 1, "a re-seen research topic must still be persisted as a re-observation"
    assert saved[0]["source"] == "claude_research"
    assert [g["topic"] for g in saved[0]["gaps"]] == ["study in canada from nepal"]


def test_topic_this_run_already_emitted_in_clustering_is_not_duplicated(monkeypatch):
    """The guard that must SURVIVE: step 3's own gaps from this same run are
    still suppressed, so one run never counts a topic twice."""
    saved = []

    async def _fake_research(site_type, industry, topic):
        return [{"keyword": "ielts prep", "estimated_difficulty": "low", "search_intent": "informational"}]

    async def _fake_save(mcp, gaps, source):
        saved.append(gaps)

    monkeypatch.setattr(kc.ic, "research_topic_keywords", _fake_research)
    monkeypatch.setattr(kc, "save_keyword_gaps", _fake_save)

    collector = kc.KeywordClusteringCollector()
    step3_gaps = [{"topic": "ielts prep"}]
    asyncio.run(collector._run_external_research(None, _Client(), _profile(), [], step3_gaps))

    assert saved == [], "a topic this run's clustering pass already emitted must not be emitted again"


def test_week_start_is_monday_and_matches_postgres_date_trunc():
    """_week_start must agree with migration 143's date_trunc('week', ...)::date
    and with analyst-seo-mapping.js's isoWeekStart. All three are Monday-based."""
    # 2026-09-06 is a Sunday; its ISO week began Monday 2026-08-31.
    assert kc._week_start(date(2026, 9, 6)) == date(2026, 8, 31)
    # A Monday is its own week start.
    assert kc._week_start(date(2026, 8, 31)) == date(2026, 8, 31)
    # The next day rolls into the following week.
    assert kc._week_start(date(2026, 9, 7)) == date(2026, 9, 7)


def test_discovery_is_skipped_when_it_already_ran_this_calendar_week(monkeypatch):
    """Double-run safety, and the reason the old rolling-7-day gate had to go.
    The nightly pipeline is not guaranteed to fire once a day — staging runs it
    twice — so a second run inside the same week must do no work."""
    calls = []

    async def _fake_get_site_profile(mcp):
        # Profiled on Monday of the same week as window_end below.
        return {"profiled_at": "2026-08-31T02:00:00Z", "industry": "education",
                "site_type": "service", "main_topics": ["study abroad"]}

    async def _fake_breakdown(*a, **kw):
        calls.append("breakdown")
        return []

    monkeypatch.setattr(kc, "get_site_profile", _fake_get_site_profile)
    monkeypatch.setattr(kc, "get_gsc_breakdown", _fake_breakdown)

    collector = kc.KeywordClusteringCollector()
    result = asyncio.run(collector.collect(
        session=None, client=_Client(), mcp=None,
        window_start=date(2026, 8, 31), window_end=date(2026, 9, 4),  # Friday, same ISO week
    ))

    assert result == []
    assert calls == [], "no GSC fetch or LLM work may run a second time inside one calendar week"


def test_discovery_runs_again_once_the_week_rolls_over(monkeypatch):
    """The complement: a new calendar week is genuinely due, which is what
    lets a recurring topic earn its second observation."""
    calls = []

    async def _fake_get_site_profile(mcp):
        return {"profiled_at": "2026-08-31T02:00:00Z", "industry": "education",
                "site_type": "service", "main_topics": ["study abroad"]}

    async def _fake_breakdown(*a, **kw):
        calls.append("breakdown")
        return []  # empty -> collector returns early after the due-check, which is all we're asserting

    monkeypatch.setattr(kc, "get_site_profile", _fake_get_site_profile)
    monkeypatch.setattr(kc, "get_gsc_breakdown", _fake_breakdown)

    collector = kc.KeywordClusteringCollector()
    asyncio.run(collector.collect(
        session=None, client=_Client(), mcp=None,
        window_start=date(2026, 9, 7), window_end=date(2026, 9, 7),  # the NEXT Monday
    ))

    assert calls == ["breakdown"], "a new calendar week must re-run discovery"
