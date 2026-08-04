"""Automatic Draft Triggering (Phase 3 Step 7) — for each Investigation
that just reached 'recommendation_generated', calls the existing,
unmodified generate_draft MCP tool (see app/mcp_client/tools.py) instead
of waiting for a staff click on the manual "Generate Content Draft"
button. Never publishes anything itself — generate_draft only ever
produces a draft row; approving/publishing still goes through the
existing Action Center human-review flow untouched.

Eligibility mirrors server/agents/lib/analyst-seo-mapping.js::
seoDraftEligibility exactly (metric_key starting with 'gsc_', dimension_
type 'page', a real decline), with one narrowing: that function falls
back to prefixing the site's own domain onto a bare path, which needs the
Node app's sites table this service has no access to. Here, only a
dimension_value that's ALREADY an absolute URL (GSC's documented normal
behavior, per that module's own comment) is eligible — anything else is
simply left un-triggered rather than guessed at.

Requires the client's MCP token to hold at least 'ai_actions' permission,
same as app/alerts/deliver.py — a 'read_only'-tier client is skipped, not
an error, since that's a provisioning fact this code can't fix."""
import logging
import re

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import Client, Insight, Investigation, InvestigationEvent
from app.db.session import SessionLocal
from app.mcp_client.client import McpAuthError, McpClient, McpToolError
from app.mcp_client.tools import generate_draft

logger = logging.getLogger(__name__)

_ABSOLUTE_URL_RE = re.compile(r"^https?://", re.IGNORECASE)


def _is_decline(insight: Insight) -> bool:
    e = insight.evidence or {}
    if insight.insight_type == "trend_shift":
        return isinstance(e.get("pct_change"), (int, float)) and e["pct_change"] < 0
    if insight.insight_type == "anomaly":
        return e.get("direction") == "low"
    if insight.insight_type == "forecast_risk":
        return True
    if insight.insight_type == "milestone":
        return e.get("direction") == "down"
    return False


def _eligibility(insight: Insight) -> dict | None:
    if not insight.metric_key.startswith("gsc_"):
        return None
    if insight.dimension_type != "page" or not insight.dimension_value:
        return None
    if not _is_decline(insight):
        return None
    if not _ABSOLUTE_URL_RE.match(insight.dimension_value):
        return None  # would need Node's site-domain fallback — not replicated here, see module docstring

    return {
        "generator_id": "expand-content",
        "params": {"page": insight.dimension_value},
        "finding_id": (
            f"analyst:{insight.metric_key}:{insight.insight_type}:"
            f"{insight.period_start.isoformat()}:{insight.dimension_value}"
        ),
    }


async def run_draft_trigger() -> None:
    async with SessionLocal() as session:
        clients = (await session.execute(select(Client).where(Client.status == "active"))).scalars().all()

    for client in clients:
        async with SessionLocal() as session:
            investigations = (
                await session.execute(
                    select(Investigation).where(
                        Investigation.client_id == client.id, Investigation.status == "recommendation_generated",
                    )
                )
            ).scalars().all()
            for investigation in investigations:
                await _try_trigger(session, client, investigation)
            await session.commit()


async def _try_trigger(session: AsyncSession, client: Client, investigation: Investigation) -> None:
    if investigation.source_insight_id is None:
        return
    insight = await session.get(Insight, investigation.source_insight_id)
    if insight is None:
        return

    action = _eligibility(insight)
    if action is None:
        return  # not eligible — expected for the vast majority of investigations, not an error

    mcp = McpClient(client.mcp_token_ciphertext)
    try:
        await generate_draft(mcp, **action)
    except McpAuthError as e:
        logger.warning("run_draft_trigger: client %s auth failed, skipping: %s", client.id, e)
        return
    except McpToolError as e:
        logger.warning("run_draft_trigger: client %s draft generation failed, skipping: %s", client.id, e)
        return

    session.add(InvestigationEvent(
        investigation_id=investigation.id, from_status=investigation.status, to_status="draft_prepared",
    ))
    investigation.status = "draft_prepared"
