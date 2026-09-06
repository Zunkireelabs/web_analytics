from datetime import timedelta

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_active_client
from app.db.dimension_lookup import dimension_values_for
from app.db.models import (
    Anomaly, Client, ForecastPoint, ForecastRun, MetricCatalog,
    MetricDimensionSupport, MetricObservation, MetricPeriodStats, PageQueryObservation,
)
from app.db.session import get_session

router = APIRouter()

PAGE_QUERY_COMPARISON_DAYS = 7


@router.get("/clients/{client_id}/metrics/{metric_key}/dimensions")
async def get_available_dimensions(
    metric_key: str, client: Client = Depends(get_active_client), session: AsyncSession = Depends(get_session),
) -> dict:
    """Which dimension breakdowns are actually worth offering as a drill-down
    for this metric, for this client — catalog-enabled (MetricDimensionSupport)
    AND with real observed values in this client's own data
    (dimension_values_for), so a UI action like "Analyze Devices" never opens
    onto an empty breakdown. Excludes 'site', which is the metric's own
    default view, not a breakdown."""
    metric = await session.get(MetricCatalog, metric_key)
    if metric is None:
        raise HTTPException(status_code=404, detail="Unknown metric_key.")

    supported = (
        await session.execute(
            select(MetricDimensionSupport.dimension_type).where(
                MetricDimensionSupport.metric_key == metric_key,
                MetricDimensionSupport.enabled.is_(True),
                MetricDimensionSupport.dimension_type != "site",
            )
        )
    ).scalars().all()

    dimensions = []
    for dimension_type in supported:
        values = await dimension_values_for(session, client.id, metric_key, dimension_type)
        if values:
            dimensions.append({"dimension_type": dimension_type, "value_count": len(values)})

    return {"metric_key": metric_key, "dimensions": dimensions}


@router.get("/dashboard/{client_id}/breakdown/{metric_key}/{dimension_type}")
async def get_breakdown(
    metric_key: str, dimension_type: str,
    client: Client = Depends(get_active_client), session: AsyncSession = Depends(get_session),
) -> dict:
    """Per-dimension-value cards for one metric x dimension (e.g. ga4_sessions
    x channel) — same construction as dashboard.py's site-level _metric_card,
    parameterized. Additive: does not change the existing /dashboard/{client_id}
    response shape, so nothing that already reads it needs to change."""
    metric = await session.get(MetricCatalog, metric_key)
    if metric is None:
        raise HTTPException(status_code=404, detail="Unknown metric_key.")

    support = await session.get(MetricDimensionSupport, {"metric_key": metric_key, "dimension_type": dimension_type})
    if support is None or not support.enabled:
        raise HTTPException(status_code=404, detail=f"'{dimension_type}' is not an enabled dimension for '{metric_key}'.")

    dim_values = await dimension_values_for(session, client.id, metric_key, dimension_type)

    return {
        "client": {"id": client.id, "name": client.name},
        "metric_key": metric_key, "display_name": metric.display_name, "unit": metric.unit,
        "dimension_type": dimension_type,
        "breakdown": [await _dimension_card(session, client.id, metric, dimension_type, v) for v in sorted(dim_values)],
    }


async def _dimension_card(session: AsyncSession, client_id: int, metric: MetricCatalog, dimension_type: str, dimension_value: str) -> dict:
    latest = (
        await session.execute(
            select(MetricObservation).where(
                MetricObservation.client_id == client_id, MetricObservation.metric_key == metric.metric_key,
                MetricObservation.dimension_type == dimension_type, MetricObservation.dimension_value == dimension_value,
            ).order_by(MetricObservation.period_start.desc()).limit(1)
        )
    ).scalar_one_or_none()

    period_stats = {}
    for period_type in ("wow", "mom"):
        row = (
            await session.execute(
                select(MetricPeriodStats).where(
                    MetricPeriodStats.client_id == client_id, MetricPeriodStats.metric_key == metric.metric_key,
                    MetricPeriodStats.dimension_type == dimension_type, MetricPeriodStats.dimension_value == dimension_value,
                    MetricPeriodStats.period_type == period_type,
                ).order_by(MetricPeriodStats.period_end.desc()).limit(1)
            )
        ).scalar_one_or_none()
        if row:
            period_stats[period_type] = {
                "current_value": float(row.current_value) if row.current_value is not None else None,
                "prior_value": float(row.prior_value) if row.prior_value is not None else None,
                "pct_change": float(row.pct_change) if row.pct_change is not None else None,
            }

    recent_anomalies = (
        await session.execute(
            select(Anomaly).where(
                Anomaly.client_id == client_id, Anomaly.metric_key == metric.metric_key,
                Anomaly.dimension_type == dimension_type, Anomaly.dimension_value == dimension_value,
            ).order_by(Anomaly.period_start.desc()).limit(5)
        )
    ).scalars().all()

    forecast_run = (
        await session.execute(
            select(ForecastRun).where(
                ForecastRun.client_id == client_id, ForecastRun.metric_key == metric.metric_key,
                ForecastRun.dimension_type == dimension_type, ForecastRun.dimension_value == dimension_value,
            ).order_by(ForecastRun.generated_at.desc()).limit(1)
        )
    ).scalar_one_or_none()
    forecast = None
    if forecast_run is not None:
        points = []
        if forecast_run.status == "ok":
            points = (
                await session.execute(
                    select(ForecastPoint).where(ForecastPoint.forecast_run_id == forecast_run.id).order_by(ForecastPoint.target_period)
                )
            ).scalars().all()
        forecast = {
            "status": forecast_run.status, "model": forecast_run.model,
            "points": [
                {"target_date": p.target_period.isoformat(), "point_estimate": float(p.point_estimate),
                 "lower_bound": float(p.lower_bound), "upper_bound": float(p.upper_bound)}
                for p in points
            ],
        }

    return {
        "dimension_value": dimension_value,
        "latest_value": float(latest.value) if latest and latest.value is not None else None,
        "latest_date": latest.period_start.isoformat() if latest else None,
        "period_stats": period_stats,
        "anomalies": [
            {"date": a.period_start.isoformat(), "method": a.method, "direction": a.direction,
             "score": float(a.score) if a.score is not None else None}
            for a in recent_anomalies
        ],
        "forecast": forecast,
    }


async def get_page_query_top_movers_data(session: AsyncSession, client_id: int, dimension_type: str) -> dict:
    """Top pages/queries (by clicks) for the most recent ingested day, each
    with a live-computed change vs. the same dimension_value's row
    PAGE_QUERY_COMPARISON_DAYS earlier — computed on demand from
    page_query_observations, never stored (see that model's docstring for
    why this deliberately skips metric_period_stats/anomalies/
    forecast_runs). Bounded to whatever was actually ingested that day
    (top-50 by clicks, per app/collectors/page_query.py) — never "every
    real page/query". Plain function (no FastAPI dependency injection) so
    it's reusable from the nightly Root Cause Analysis Engine
    (app/intelligence/root_cause.py) as well as the route below."""
    latest_date = await session.scalar(
        select(func.max(PageQueryObservation.period_start)).where(
            PageQueryObservation.client_id == client_id, PageQueryObservation.dimension_type == dimension_type,
        )
    )
    if latest_date is None:
        return {"date": None, "compared_to_date": None, "rows": []}

    prior_date = latest_date - timedelta(days=PAGE_QUERY_COMPARISON_DAYS)

    current_rows = (
        await session.execute(
            select(PageQueryObservation).where(
                PageQueryObservation.client_id == client_id, PageQueryObservation.dimension_type == dimension_type,
                PageQueryObservation.period_start == latest_date,
            ).order_by(PageQueryObservation.clicks.desc())
        )
    ).scalars().all()

    prior_rows = (
        await session.execute(
            select(PageQueryObservation).where(
                PageQueryObservation.client_id == client_id, PageQueryObservation.dimension_type == dimension_type,
                PageQueryObservation.period_start == prior_date,
            )
        )
    ).scalars().all()
    prior_by_value = {r.dimension_value: r for r in prior_rows}

    rows = []
    for r in current_rows:
        prior = prior_by_value.get(r.dimension_value)
        clicks = float(r.clicks) if r.clicks is not None else None
        prior_clicks = float(prior.clicks) if prior and prior.clicks is not None else None
        rows.append({
            "dimension_value": r.dimension_value,
            "clicks": clicks, "impressions": float(r.impressions) if r.impressions is not None else None,
            "ctr": float(r.ctr) if r.ctr is not None else None, "position": float(r.position) if r.position is not None else None,
            "prior_clicks": prior_clicks,
            # Only present when both this value's current AND prior-window row exist —
            # a value newly appearing in the top-50 has no prior row to compare against,
            # and that absence must read as "no comparison available," never a fabricated 0.
            "clicks_change": (clicks - prior_clicks) if clicks is not None and prior_clicks is not None else None,
        })

    return {"date": latest_date.isoformat(), "compared_to_date": prior_date.isoformat(), "rows": rows}


@router.get("/dashboard/{client_id}/page-query/{dimension_type}")
async def get_page_query_top_movers(
    dimension_type: str,
    client: Client = Depends(get_active_client), session: AsyncSession = Depends(get_session),
) -> dict:
    if dimension_type not in ("page", "query"):
        raise HTTPException(status_code=404, detail="dimension_type must be 'page' or 'query'.")
    data = await get_page_query_top_movers_data(session, client.id, dimension_type)
    return {"client": {"id": client.id, "name": client.name}, "dimension_type": dimension_type, **data}


@router.get("/dashboard/{client_id}/page-query/{dimension_type}/{value:path}")
async def get_page_query_trend(
    dimension_type: str, value: str,
    client: Client = Depends(get_active_client), session: AsyncSession = Depends(get_session),
) -> dict:
    """Full stored trend for one specific page URL or query string — every
    day it was actually in the ingested top-50 (never gap-filled/
    interpolated for days it wasn't), oldest first."""
    if dimension_type not in ("page", "query"):
        raise HTTPException(status_code=404, detail="dimension_type must be 'page' or 'query'.")

    rows = (
        await session.execute(
            select(PageQueryObservation).where(
                PageQueryObservation.client_id == client.id, PageQueryObservation.dimension_type == dimension_type,
                PageQueryObservation.dimension_value == value,
            ).order_by(PageQueryObservation.period_start.asc())
        )
    ).scalars().all()

    return {
        "client": {"id": client.id, "name": client.name}, "dimension_type": dimension_type, "dimension_value": value,
        "trend": [
            {
                "date": r.period_start.isoformat(),
                "clicks": float(r.clicks) if r.clicks is not None else None,
                "impressions": float(r.impressions) if r.impressions is not None else None,
                "ctr": float(r.ctr) if r.ctr is not None else None,
                "position": float(r.position) if r.position is not None else None,
            }
            for r in rows
        ],
    }
