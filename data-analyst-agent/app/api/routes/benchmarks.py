"""Cross-client benchmarking + industry trends — the first routes in this
service that deliberately span every tenant rather than scoping to one
client_id. Gated only by the admin key (same pattern as GET /alerts), never
by get_active_client. Every response is aggregate-only (percentiles across
>= MIN_CLIENTS_PER_GROUP clients) — never a per-client breakdown, so one
client's raw value is never inferable from another client's view. industry
has no fixed vocabulary yet (a product/sales decision, not an engineering
one) — see app/db/models.py::Client.industry."""
import statistics
from datetime import date

from dateutil.relativedelta import relativedelta
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import Client, MetricCatalog, MetricObservation
from app.db.session import get_session
from app.security.auth import require_admin_key
from app.stats.deltas import _aggregate

router = APIRouter()

MIN_CLIENTS_PER_GROUP = 2
DEFAULT_TREND_MONTHS = 6


async def get_industry_percentiles(session: AsyncSession, metric_key: str) -> dict[str, dict]:
    """{industry: {industry, client_count, p25, median, p75}} for every
    industry with >= MIN_CLIENTS_PER_GROUP active, industry-tagged clients
    holding a recent site-level value for this metric. Plain function (no
    FastAPI dependency injection) extracted from get_benchmark's own body so
    app/intelligence/opportunity_scoring.py can reuse the exact same
    cross-client aggregate-only logic — same reuse pattern as
    app/api/routes/breakdown.py::get_page_query_top_movers_data."""
    clients = (
        await session.execute(
            select(Client).where(Client.status == "active", Client.industry.is_not(None))
        )
    ).scalars().all()

    by_industry: dict[str, list[float]] = {}
    for client in clients:
        latest = await session.scalar(
            select(MetricObservation.value).where(
                MetricObservation.client_id == client.id, MetricObservation.metric_key == metric_key,
                MetricObservation.dimension_type == "site", MetricObservation.dimension_value == "__site__",
            ).order_by(MetricObservation.period_start.desc()).limit(1)
        )
        if latest is not None:
            by_industry.setdefault(client.industry, []).append(float(latest))

    return {
        industry: _percentile_summary(industry, values) for industry, values in by_industry.items()
        if len(values) >= MIN_CLIENTS_PER_GROUP
    }


@router.get("/benchmarks/{metric_key}")
async def get_benchmark(
    metric_key: str,
    session: AsyncSession = Depends(get_session),
    _admin: None = Depends(require_admin_key),
) -> dict:
    """Each active, industry-tagged client's latest real site-level value for
    this metric, grouped by industry into p25/median/p75 — a snapshot, not a
    trend (see the /trend endpoint below for that)."""
    metric = await session.get(MetricCatalog, metric_key)
    if metric is None:
        raise HTTPException(status_code=404, detail="Unknown metric_key.")

    percentiles = await get_industry_percentiles(session, metric_key)
    return {
        "metric_key": metric_key, "display_name": metric.display_name, "unit": metric.unit,
        "min_clients_per_group": MIN_CLIENTS_PER_GROUP,
        "industries": [v for _, v in sorted(percentiles.items())],
    }


@router.get("/benchmarks/{metric_key}/trend")
async def get_benchmark_trend(
    metric_key: str, months: int = DEFAULT_TREND_MONTHS,
    session: AsyncSession = Depends(get_session),
    _admin: None = Depends(require_admin_key),
) -> dict:
    """Same industry grouping as /benchmarks/{metric_key}, but one point per
    calendar month over the last `months` months — each client's monthly
    value computed via the metric's own aggregation_strategy (the same
    canonical-formula logic stats/deltas.py uses, reused here rather than
    re-derived, so a 'sum' metric like clicks is genuinely summed per month
    per client before cross-client percentiles are taken, not averaged
    across days in a way that would silently misrepresent it)."""
    metric = await session.get(MetricCatalog, metric_key)
    if metric is None:
        raise HTTPException(status_code=404, detail="Unknown metric_key.")

    clients = (
        await session.execute(
            select(Client).where(Client.status == "active", Client.industry.is_not(None))
        )
    ).scalars().all()

    today = date.today()
    month_starts = [
        date(today.year, today.month, 1) - relativedelta(months=i)
        for i in range(months - 1, -1, -1)
    ]

    by_month_industry: dict[date, dict[str, list[float]]] = {m: {} for m in month_starts}
    for client in clients:
        for month_start in month_starts:
            month_end = month_start + relativedelta(months=1) - relativedelta(days=1)
            value = await _aggregate(session, client.id, metric, "site", "__site__", month_start, month_end)
            if value is not None:
                by_month_industry[month_start].setdefault(client.industry, []).append(value)

    points = []
    for month_start in month_starts:
        for industry, values in sorted(by_month_industry[month_start].items()):
            if len(values) >= MIN_CLIENTS_PER_GROUP:
                points.append({"month": month_start.isoformat(), **_percentile_summary(industry, values)})

    return {
        "metric_key": metric_key, "display_name": metric.display_name, "unit": metric.unit,
        "min_clients_per_group": MIN_CLIENTS_PER_GROUP, "points": points,
    }


def _percentile_summary(industry: str, values: list[float]) -> dict:
    values = sorted(values)
    return {
        "industry": industry, "client_count": len(values),
        "p25": statistics.quantiles(values, n=4, method="inclusive")[0] if len(values) >= 2 else values[0],
        "median": statistics.median(values),
        "p75": statistics.quantiles(values, n=4, method="inclusive")[2] if len(values) >= 2 else values[0],
    }
