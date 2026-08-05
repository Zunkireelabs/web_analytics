"""Predictive alert delivery — pushes currently-active, unresolved
forecast_risk insights through the Node app's notification channels via the
push_predictive_alert MCP tool. Detection already happens in
insights/engine.py::_forecast_risk_insights; this only handles delivery,
kept as its own module since it's a genuinely separate concern (the Node
app owns real delivery infra — email/in-app — this side just calls out to
it, same "never build a parallel system" choice as everywhere else this
service talks to the Node app).

Re-alerts every night a forecast_risk insight is still active and
unresolved (see insights/engine.py::_replace_insight — a resolved
Recommendation freezes its Insight in place instead of regenerating it, so
once staff resolves one, delivery stops for it automatically, same
"resolved" check dashboard.py/alerts.py already use). This is a deliberate
"keep reminding while the risk is real and unactioned" choice, not a bug —
the alternative (alert once, then go silent even though the risk is still
live) is worse for a predictive-risk feature.

Requires the client's MCP token to hold at least 'ai_actions' permission —
a client still on 'read_only' (the default) is skipped, not an error,
since that's a deployment/provisioning fact this code can't fix."""
import logging

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import Client, Insight, MetricCatalog, AnalystRecommendations
from app.db.session import SessionLocal
from app.mcp_client.client import McpAuthError, McpClient, McpToolError
from app.mcp_client.tools import push_predictive_alert

logger = logging.getLogger(__name__)

ALERT_SEVERITIES = ("high", "medium")


async def deliver_predictive_alerts() -> None:
    async with SessionLocal() as session:
        clients = (await session.execute(select(Client).where(Client.status == "active"))).scalars().all()

    for client in clients:
        async with SessionLocal() as session:
            alerts = await _active_alerts(session, client.id)
        if not alerts:
            continue

        mcp = McpClient(client.mcp_token_ciphertext)
        try:
            await push_predictive_alert(mcp, alerts)
        except McpAuthError as e:
            logger.warning("deliver_predictive_alerts: client %s auth failed, skipping: %s", client.id, e)
        except McpToolError as e:
            # Covers both a real tool failure AND insufficient permission
            # (a read_only-tier token) — either way, this client's alerts
            # just don't go out tonight; never blocks any other client.
            logger.warning("deliver_predictive_alerts: client %s alert push failed, skipping: %s", client.id, e)


async def _active_alerts(session: AsyncSession, client_id: int) -> list[dict]:
    rows = (
        await session.execute(
            select(Insight, AnalystRecommendations, MetricCatalog)
            .join(MetricCatalog, MetricCatalog.metric_key == Insight.metric_key)
            .outerjoin(AnalystRecommendations, AnalystRecommendations.insight_id == Insight.id)
            .where(
                Insight.client_id == client_id, Insight.insight_type == "forecast_risk",
                Insight.severity.in_(ALERT_SEVERITIES),
            )
        )
    ).all()

    alerts = []
    for insight, rec, metric in rows:
        if rec is not None and rec.status == "resolved":
            continue
        e = insight.evidence
        default_body = (
            f"Forecast to decline {abs(e.get('pct_projected_change', 0)):.1f}% by "
            f"{e.get('predicted_date')} if the current trend continues."
        )
        alerts.append({
            "severity": insight.severity,
            "title": f"{metric.display_name} — predicted decline",
            "body": (rec.recommendation_text if rec else None) or default_body,
        })
    return alerts
