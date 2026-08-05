from fastapi import APIRouter, Depends
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import Client, Insight, MetricCatalog, AnalystRecommendations
from app.db.session import get_session
from app.security.auth import require_admin_key

router = APIRouter()

SEVERITY_RANK = {"high": 0, "medium": 1, "low": 2}


@router.get("/alerts")
async def get_alerts(
    session: AsyncSession = Depends(get_session),
    _admin: None = Depends(require_admin_key),
) -> dict:
    """Cross-client — every active client's open (unresolved) insight in one
    call, so staff can triage without opening each client's dashboard one at
    a time. No client_id in the path: this is the one view that deliberately
    spans every tenant, gated only by the same admin key as everything else
    in this admin-only service. Cache-only, same discipline as
    GET /dashboard/{client_id} — never computes anything new."""
    clients = (await session.execute(select(Client).where(Client.status == "active"))).scalars().all()
    catalog_by_key = {m.metric_key: m for m in (await session.execute(select(MetricCatalog))).scalars().all()}

    alerts = []
    for client in clients:
        insights = (
            await session.execute(
                select(Insight).where(Insight.client_id == client.id).order_by(Insight.generated_at.desc())
            )
        ).scalars().all()
        for insight in insights:
            rec = (
                await session.execute(select(AnalystRecommendations).where(AnalystRecommendations.insight_id == insight.id))
            ).scalar_one_or_none()
            if rec is not None and rec.status in ("resolved", "dismissed"):
                continue
            metric = catalog_by_key.get(insight.metric_key)
            alerts.append({
                "client_id": client.id, "client_name": client.name,
                "metric_key": insight.metric_key,
                "display_name": metric.display_name if metric else insight.metric_key,
                "insight_type": insight.insight_type, "severity": insight.severity,
                "period_start": insight.period_start.isoformat(), "evidence": insight.evidence,
                "generated_at": insight.generated_at.isoformat(),
                "recommendation_id": rec.id if rec else None,
                "root_cause": rec.root_cause_text if rec else None,
                "recommendation": rec.recommendation_text if rec else None,
            })

    # Stable sort: most recent first, then grouped by severity — high-severity
    # items lead the feed without losing recency order within each severity.
    alerts.sort(key=lambda a: a["generated_at"], reverse=True)
    alerts.sort(key=lambda a: SEVERITY_RANK.get(a["severity"], 3))

    return {"count": len(alerts), "alerts": alerts}
