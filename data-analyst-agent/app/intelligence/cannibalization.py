"""Cannibalization Detector (Prompt 8, section 12) — grades Node's raw
get_cannibalized_queries candidates (2+ of a site's own pages both
genuinely ranking for the same query) into evidence-backed findings. The
raw candidate list is deliberately NOT itself sufficient evidence — two
pages sharing a keyword is common and often harmless. A candidate only
becomes a finding once it clears a real aggregate-demand floor AND shows
evidence of unstable/competing ownership across two adjacent time windows,
never just "2+ pages appeared in one query's list once"."""
import logging
from datetime import date, timedelta

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import Client
from app.db.session import SessionLocal
from app.insights.engine import _replace_insight
from app.mcp_client.client import McpAuthError, McpClient, McpToolError
from app.mcp_client.tools import get_cannibalized_queries

logger = logging.getLogger(__name__)

WINDOW_DAYS = 45
# get_cannibalized_queries already floors each PAGE at this many impressions
# individually (the tool's own per-page default). MIN_AGGREGATE_IMPRESSIONS
# below is a SEPARATE, additional floor across the whole conflicting set —
# a pair of pages that each barely clear the per-page floor is not yet real
# aggregate demand worth a finding. 10x is a deliberately conservative
# multiple, chosen to keep this a low-noise signal, not a precisely
# calibrated statistic.
MIN_IMPRESSIONS_PER_PAGE = 5
MIN_AGGREGATE_IMPRESSIONS = MIN_IMPRESSIONS_PER_PAGE * 10


async def run_cannibalization_detection() -> None:
    """Per-client isolation, same pattern as run_draft_trigger — one
    client's MCP failure must never abort the run for every other client."""
    async with SessionLocal() as session:
        clients = (await session.execute(select(Client).where(Client.status == "active"))).scalars().all()

    for client in clients:
        try:
            async with SessionLocal() as session:
                await _detect_for_client(session, client)
                await session.commit()
        except Exception:
            logger.exception("run_cannibalization_detection: client %s raised — skipping this client only", client.id)


async def _detect_for_client(session: AsyncSession, client: Client) -> None:
    mcp = McpClient(client.mcp_token_ciphertext)
    end = date.today()
    recent_start = end - timedelta(days=WINDOW_DAYS)
    prior_end = recent_start - timedelta(days=1)
    prior_start = prior_end - timedelta(days=WINDOW_DAYS - 1)

    try:
        recent = await get_cannibalized_queries(mcp, recent_start.isoformat(), end.isoformat(), min_impressions=MIN_IMPRESSIONS_PER_PAGE)
        prior = await get_cannibalized_queries(mcp, prior_start.isoformat(), prior_end.isoformat(), min_impressions=MIN_IMPRESSIONS_PER_PAGE)
    except (McpAuthError, McpToolError) as e:
        logger.warning("run_cannibalization_detection: client %s MCP call failed: %s", client.id, e)
        return

    prior_by_query = {c["query"]: c for c in prior}

    for candidate in recent:
        query_text = candidate["query"]
        pages = [
            {"page": p["page"], "clicks": int(p["clicks"]), "impressions": int(p["impressions"]),
             "avg_position": float(p["avg_position"]) if p.get("avg_position") is not None else None}
            for p in candidate["pages"]
        ]
        prior_candidate = prior_by_query.get(query_text)
        prior_pages = prior_candidate["pages"] if prior_candidate else []

        graded = _grade_candidate(pages, prior_pages)
        if graded is None:
            continue

        await _replace_insight(
            session, client_id=client.id, metric_key="gsc_clicks", dimension_type="query",
            dimension_value=query_text, period_start=end, insight_type="cannibalization",
            severity=graded["severity"], evidence=graded["evidence"],
        )


def _grade_candidate(pages: list[dict], prior_pages: list[dict]) -> dict | None:
    """Pure grading decision over already-normalized page lists (each
    {page, clicks, impressions, avg_position}, pages sorted by clicks desc —
    Node's getCannibalizedQueries already guarantees this ordering). No DB/
    MCP access, directly unit-testable. Returns {severity, evidence} to
    persist as an Insight, or None if this candidate doesn't clear both the
    aggregate-demand floor and the ownership-instability check.

    Ownership instability (chosen over a same-window-only closeness check
    for being the cheaper, unambiguous signal given data already fetched):
    the page winning this query changed between the two windows. Falls back
    to a same-window closeness check only when there's no prior-window
    candidate to compare against (e.g. a newly-detected conflict) — two
    pages within 2x of each other's clicks are genuinely splitting traffic,
    not one page incidentally picking up a few stray impressions."""
    if len(pages) < 2:
        return None
    total_impressions = sum(p["impressions"] for p in pages)
    if total_impressions < MIN_AGGREGATE_IMPRESSIONS:
        return None  # real conflict, but not enough aggregate demand to act on yet

    leading_recent = pages[0]["page"]
    leading_prior = prior_pages[0]["page"] if prior_pages else None

    if leading_prior is not None:
        unstable = leading_prior != leading_recent
    else:
        second_clicks = pages[1]["clicks"]
        if second_clicks > 0:
            unstable = (pages[0]["clicks"] / second_clicks) <= 2
        else:
            # Both pages rank for this query but neither is converting clicks
            # (poor CTR/high position) — a clicks ratio is undefined here, so
            # fall back to impressions to still catch a real, comparable-
            # demand conflict instead of silently never flagging it.
            second_impressions = pages[1]["impressions"]
            unstable = second_impressions > 0 and (pages[0]["impressions"] / second_impressions) <= 2

    if not unstable:
        return None

    severity = "high" if total_impressions >= MIN_AGGREGATE_IMPRESSIONS * 3 else "medium"
    return {
        "severity": severity,
        "evidence": {
            "pages": pages, "leading_page_recent": leading_recent, "leading_page_prior": leading_prior,
            "total_impressions": total_impressions, "min_aggregate_impressions": MIN_AGGREGATE_IMPRESSIONS,
        },
    }
