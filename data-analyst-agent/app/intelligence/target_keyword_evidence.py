"""Target-Keyword Evidence Grading (Prompt 8, section 9) — turns a client-
declared target keyword (a keyword_gaps row with source='user_request', per
migration 099's comment: "the Analyst page now lets a human type a keyword
they want to grow for") from "the user asked for this topic" into a graded,
evidence-backed classification, using real GSC query-page evidence
(get_query_page_metrics) and already-persisted technical SEO content
signals (get_technical_seo_signals, migration 120). Never fabricates
evidence: a keyword with no matching GSC hits and no existing_page_match is
TARGET_WITH_INSUFFICIENT_EVIDENCE and, since there is nothing actionable
yet, produces no Insight row at all — only the 4 states below that
represent real evidence become findings, feeding the exact same
Insight -> AnalystRecommendations -> opportunity scoring -> prioritizer ->
draft trigger pipeline every other insight_type already uses (see
app/insights/recommendations.py's new 'target_keyword_evidence' render
branch)."""
import logging
from datetime import date, timedelta

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import Client
from app.db.session import SessionLocal
from app.insights.engine import _replace_insight
from app.mcp_client.client import McpAuthError, McpClient, McpToolError
from app.mcp_client.tools import get_keyword_gaps, get_query_page_metrics, get_technical_seo_signals

logger = logging.getLogger(__name__)

EVIDENCE_WINDOW_DAYS = 90
# The same "thin content" bar Node's own content-gap detection already uses
# — server/agents/lib/page-content.js's MIN_WORD_COUNT (used there to tag a
# page 'Expand content'). Reused verbatim rather than inventing a second,
# competing threshold.
THIN_CONTENT_WORD_COUNT = 300
RANKING_POSITION_CEILING = 20


async def run_target_keyword_evidence() -> None:
    """Per-client isolation, same pattern as run_draft_trigger/run_
    cannibalization_detection — one client's malformed keyword_gaps row or
    MCP failure must never abort the run for every other client."""
    async with SessionLocal() as session:
        clients = (await session.execute(select(Client).where(Client.status == "active"))).scalars().all()

    for client in clients:
        try:
            async with SessionLocal() as session:
                await _grade_client_targets(session, client)
                await session.commit()
        except Exception:
            logger.exception("run_target_keyword_evidence: client %s raised — skipping this client only", client.id)


async def _grade_client_targets(session: AsyncSession, client: Client) -> None:
    mcp = McpClient(client.mcp_token_ciphertext)
    try:
        gaps = await get_keyword_gaps(mcp, status="approved")
    except (McpAuthError, McpToolError) as e:
        logger.warning("run_target_keyword_evidence: client %s get_keyword_gaps failed: %s", client.id, e)
        return

    # A client can type a target keyword before staff has reviewed it, and
    # staff can reject one — neither should keep resurfacing as an Insight,
    # so the human-approval gate (server/routes/keywords.js) is enforced
    # here via the status="approved" filter, not just by source below.
    targets = [g for g in gaps if g.get("source") == "user_request"]
    if not targets:
        return

    end = date.today()
    start = end - timedelta(days=EVIDENCE_WINDOW_DAYS)
    try:
        query_page_rows = await get_query_page_metrics(mcp, start.isoformat(), end.isoformat())
    except (McpAuthError, McpToolError) as e:
        logger.warning("run_target_keyword_evidence: client %s get_query_page_metrics failed: %s", client.id, e)
        return

    by_query_lower: dict[str, list[dict]] = {}
    for r in query_page_rows:
        by_query_lower.setdefault(r["query"].strip().lower(), []).append(r)

    for gap in targets:
        topic = gap.get("topic")
        if not topic:
            continue
        matches = by_query_lower.get(topic.strip().lower(), [])
        impressions = sum(int(m["impressions"]) for m in matches) or None
        clicks = sum(int(m["clicks"]) for m in matches) or None
        ranked_positions = [float(m["avgPosition"]) for m in matches if m.get("avgPosition") is not None]
        best_position = min(ranked_positions) if ranked_positions else None
        existing_page_match = gap.get("existing_page_match")

        word_count, checked_at = None, None
        if existing_page_match:
            try:
                signals = await get_technical_seo_signals(mcp, pages=[existing_page_match])
            except (McpAuthError, McpToolError) as e:
                logger.warning("run_target_keyword_evidence: client %s get_technical_seo_signals failed: %s", client.id, e)
                signals = []
            if signals:
                word_count = signals[0].get("word_count")
                checked_at = signals[0].get("checked_at")

        classification = _classify(
            has_demand=bool(matches), best_position=best_position,
            existing_page_match=existing_page_match, word_count=word_count,
        )
        if classification is None:
            continue  # TARGET_WITH_INSUFFICIENT_EVIDENCE — nothing actionable yet, no Insight row

        severity = "high" if classification in ("TARGET_WITH_CONTENT_GAP", "TARGET_WITH_EXISTING_DEMAND") else "low"
        await _replace_insight(
            session, client_id=client.id, metric_key="gsc_impressions", dimension_type="query",
            dimension_value=topic, period_start=end, insight_type="target_keyword_evidence",
            severity=severity,
            evidence={
                "classification": classification, "topic": topic,
                "impressions": impressions, "clicks": clicks, "best_avg_position": best_position,
                # existing_page_match: real matched URL or None (no match found/checked yet).
                # word_count: a real number means content was checked and measured; None means
                # either no matching page, or a matched page technical-seo hasn't checked yet —
                # these are distinct states and must never be conflated with "confirmed thin".
                "existing_page_match": existing_page_match, "word_count": word_count, "checked_at": checked_at,
                "thin_content_threshold_words": THIN_CONTENT_WORD_COUNT,
            },
        )


def _classify(*, has_demand: bool, best_position: float | None, existing_page_match: str | None, word_count: int | None) -> str | None:
    if existing_page_match:
        if word_count is not None and word_count >= THIN_CONTENT_WORD_COUNT:
            return "TARGET_WITH_RELEVANT_EXISTING_PAGE"
        return "TARGET_WITH_CONTENT_GAP"  # confirmed thin (word_count is a real low number) or never checked (word_count is None) — evidence dict keeps the two distinguishable
    if has_demand:
        if best_position is not None and best_position <= RANKING_POSITION_CEILING:
            return "TARGET_WITH_RANKING_SIGNAL"
        return "TARGET_WITH_EXISTING_DEMAND"
    return None  # TARGET_WITH_INSUFFICIENT_EVIDENCE
