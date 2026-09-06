"""ROI Estimation Engine (Phase 2 plan Stage 5) — this module's original
docstring called it "Phase 2 Stage 3" and scored its confidence rows under
subject_type='impact_prediction'; both were mislabeled (that subject_type
and stage number now correctly belong to app/intelligence/impact_prediction.py,
the separate Time-to-Impact engine) — fixed to 'roi_estimation', which was
forward-declared for exactly this purpose since migration 0012.

Translates a metric delta into a business-impact estimate using ONLY the
client's own observed relationships (its real conversions/sessions rate,
and for CTR/position, its own historical CTR at a given position) — never
an industry-average conversion rate or an industry CTR-by-rank curve.
Metrics with no defensible mapping report status='not-computable' rather
than a guessed number.

Two modes, chosen per call based on whether client_business_values is
configured — never a hard stop just because it isn't (the original version
of this engine returned 'not-configured' and produced nothing at all when
business values were missing; fixed so something useful is always
available):
- Mode 1 ('metric_unit', default): the metric-unit delta itself (sessions,
  or a sessions-equivalent for CTR/position's implied-clicks hop) — no
  currency figure, but always available once the metric has a defensible
  mapping at all.
- Mode 2 ('currency', only when client_business_values is configured):
  Mode 1's delta multiplied by the client's own configured business-value
  fields, for a currency estimate.

Scope, confirmed with the product owner: gsc_clicks and ga4_sessions map to
a sessions delta directly (gsc_clicks ~= sessions for organic traffic is a
documented approximation, not treated as exact). gsc_ctr and gsc_position
are approximated via an implied-clicks step grounded in the page/site's own
observed impressions and (for position) its own historical CTR-at-that-
position — one more inferential hop than the direct metrics, but still
self-referential, never a fabricated industry curve. Every other metric is
not-computable regardless of mode."""
from dataclasses import dataclass

import pandas as pd
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import ImpactProjectionRun, MetricObservation, PageQueryObservation
from app.scoring.business_values import BusinessValues, get_business_values
from app.scoring.confidence import compute_confidence

DIRECT_METRICS = {"gsc_clicks", "ga4_sessions"}
CTR_METRICS = {"gsc_ctr"}
POSITION_METRICS = {"gsc_position"}

CONVERSION_LOOKBACK_DAYS = 90
MIN_CONVERSION_RATE_DAYS = 14
POSITION_BUCKET_TOLERANCE = 0.5
MIN_POSITION_BUCKET_DAYS = 5


@dataclass
class _SessionsDelta:
    value: float | None
    detail: dict


async def project_impact(
    session: AsyncSession, *, client_id: int, metric_key: str,
    dimension_type: str = "site", dimension_value: str = "__site__",
    delta_value: float, delta_direction: str,
    current_value: float | None = None, prior_value: float | None = None,
) -> ImpactProjectionRun:
    """current_value/prior_value are only required for gsc_position (bucketing
    needs the absolute position, not just its delta) — optional otherwise."""
    sessions_delta = await _implied_sessions_delta(
        session, client_id, metric_key, dimension_type, dimension_value, delta_value, current_value, prior_value,
    )
    if sessions_delta.value is None:
        return await _persist(
            session, client_id, metric_key, dimension_type, dimension_value, delta_value, delta_direction,
            status="not-computable", detail=sessions_delta.detail,
        )

    business_values = await get_business_values(session, client_id)
    if business_values is None or not business_values.is_configured:
        return await _persist(
            session, client_id, metric_key, dimension_type, dimension_value, delta_value, delta_direction,
            status="ok", mode="metric_unit", projected_metric_unit_delta=sessions_delta.value, metric_unit="sessions",
            detail={
                **sessions_delta.detail,
                "note": "no dollar figure — business values not configured for this client (see scripts/set_business_values.py or PUT /clients/{id}/business-values)",
            },
            confidence_components={"data_completeness": 1.0},
        )

    conversion_rate, conv_detail = await _client_conversion_rate(session, client_id)
    if conversion_rate is None:
        return await _persist(
            session, client_id, metric_key, dimension_type, dimension_value, delta_value, delta_direction,
            status="ok", mode="metric_unit", projected_metric_unit_delta=sessions_delta.value, metric_unit="sessions",
            detail={**sessions_delta.detail, **conv_detail, "note": "no dollar figure — conversion rate not computable, see reason"},
            confidence_components={"data_completeness": 1.0},
        )

    dollar_value, dollar_source = _dollar_value(business_values)
    projected_conversions_delta = sessions_delta.value * conversion_rate
    magnitude = abs(projected_conversions_delta * dollar_value)
    projected_dollar_delta = -magnitude if delta_direction == "decline" else magnitude

    detail = {
        **sessions_delta.detail, **conv_detail,
        "conversion_rate": conversion_rate, "dollar_value": dollar_value, "dollar_value_source": dollar_source,
    }

    return await _persist(
        session, client_id, metric_key, dimension_type, dimension_value, delta_value, delta_direction,
        status="ok", mode="currency", projected_dollar_delta=projected_dollar_delta, currency=business_values.currency,
        projected_metric_unit_delta=sessions_delta.value, metric_unit="sessions", detail=detail,
        confidence_components={
            "data_completeness": conv_detail.get("data_completeness"),
            "historical_coverage": conv_detail.get("historical_coverage"),
            "statistical_significance": None,
            "model_certainty": None,
            "anomaly_strength": None,
        },
    )


async def _implied_sessions_delta(
    session: AsyncSession, client_id: int, metric_key: str, dimension_type: str, dimension_value: str,
    delta_value: float, current_value: float | None, prior_value: float | None,
) -> _SessionsDelta:
    if metric_key in DIRECT_METRICS:
        approx = "gsc_clicks treated ~1:1 as sessions for organic traffic — not exact" if metric_key == "gsc_clicks" else None
        return _SessionsDelta(value=delta_value, detail={"method": "direct", "approximation": approx})

    if metric_key in CTR_METRICS:
        impressions = await _current_impressions(session, client_id, dimension_type, dimension_value)
        if impressions is None:
            return _SessionsDelta(value=None, detail={"method": "ctr_implied_clicks", "reason": "no recent impressions data for this dimension"})
        implied_clicks = delta_value * impressions
        return _SessionsDelta(
            value=implied_clicks,
            detail={"method": "ctr_implied_clicks", "current_impressions": impressions, "approximation": "implied clicks treated ~1:1 as sessions"},
        )

    if metric_key in POSITION_METRICS:
        if current_value is None or prior_value is None:
            return _SessionsDelta(value=None, detail={"method": "position_bucket_ctr", "reason": "current_value/prior_value required for position projection"})
        history = await _position_ctr_history(session, client_id, dimension_type, dimension_value)
        if history.empty:
            return _SessionsDelta(value=None, detail={"method": "position_bucket_ctr", "reason": "no historical position/ctr data for this dimension"})

        current_bucket = history[(history["position"] - current_value).abs() <= POSITION_BUCKET_TOLERANCE]
        prior_bucket = history[(history["position"] - prior_value).abs() <= POSITION_BUCKET_TOLERANCE]
        if len(current_bucket) < MIN_POSITION_BUCKET_DAYS or len(prior_bucket) < MIN_POSITION_BUCKET_DAYS:
            return _SessionsDelta(
                value=None,
                detail={
                    "method": "position_bucket_ctr",
                    "reason": f"need >= {MIN_POSITION_BUCKET_DAYS} historical days at each position to derive this client's own CTR-by-position",
                    "n_days_at_current_position": len(current_bucket), "n_days_at_prior_position": len(prior_bucket),
                },
            )
        ctr_at_current = float(current_bucket["ctr"].mean())
        ctr_at_prior = float(prior_bucket["ctr"].mean())
        implied_delta_ctr = ctr_at_prior - ctr_at_current  # positive when position worsened (moved to a lower-CTR bucket)

        impressions = await _current_impressions(session, client_id, dimension_type, dimension_value)
        if impressions is None:
            return _SessionsDelta(value=None, detail={"method": "position_bucket_ctr", "reason": "no recent impressions data for this dimension"})
        implied_clicks = implied_delta_ctr * impressions
        return _SessionsDelta(
            value=-implied_clicks,  # a worsened position (ctr_at_prior > ctr_at_current) is a LOSS of clicks
            detail={
                "method": "position_bucket_ctr", "current_impressions": impressions,
                "ctr_at_current_position": ctr_at_current, "ctr_at_prior_position": ctr_at_prior,
                "approximation": "CTR-by-position derived from this client's own history, not an industry curve; implied clicks treated ~1:1 as sessions",
            },
        )

    return _SessionsDelta(value=None, detail={"reason": f"'{metric_key}' has no defensible dollar mapping"})


async def _current_impressions(session: AsyncSession, client_id: int, dimension_type: str, dimension_value: str) -> float | None:
    if dimension_type == "site":
        value = await session.scalar(
            select(MetricObservation.value).where(
                MetricObservation.client_id == client_id, MetricObservation.metric_key == "gsc_impressions",
                MetricObservation.dimension_type == "site", MetricObservation.dimension_value == "__site__",
            ).order_by(MetricObservation.period_start.desc()).limit(1)
        )
    else:
        value = await session.scalar(
            select(PageQueryObservation.impressions).where(
                PageQueryObservation.client_id == client_id, PageQueryObservation.dimension_type == dimension_type,
                PageQueryObservation.dimension_value == dimension_value,
            ).order_by(PageQueryObservation.period_start.desc()).limit(1)
        )
    return float(value) if value is not None else None


async def _position_ctr_history(session: AsyncSession, client_id: int, dimension_type: str, dimension_value: str) -> pd.DataFrame:
    """(position, ctr) pairs from this exact dimension_value's own history —
    self-referential, never an industry CTR-by-rank table."""
    if dimension_type == "site":
        rows = (
            await session.execute(
                select(MetricObservation.period_start, MetricObservation.metric_key, MetricObservation.value).where(
                    MetricObservation.client_id == client_id, MetricObservation.metric_key.in_(["gsc_position", "gsc_ctr"]),
                    MetricObservation.dimension_type == "site", MetricObservation.dimension_value == "__site__",
                )
            )
        ).all()
        df = pd.DataFrame(rows, columns=["period_start", "metric_key", "value"]).dropna()
        if df.empty:
            return pd.DataFrame(columns=["position", "ctr"])
        df["value"] = df["value"].astype(float)
        wide = df.pivot(index="period_start", columns="metric_key", values="value").dropna()
        return wide.rename(columns={"gsc_position": "position", "gsc_ctr": "ctr"})[["position", "ctr"]]

    rows = (
        await session.execute(
            select(PageQueryObservation.position, PageQueryObservation.ctr).where(
                PageQueryObservation.client_id == client_id, PageQueryObservation.dimension_type == dimension_type,
                PageQueryObservation.dimension_value == dimension_value,
            )
        )
    ).all()
    df = pd.DataFrame(rows, columns=["position", "ctr"]).dropna()
    return df.astype(float)


async def _client_conversion_rate(session: AsyncSession, client_id: int) -> tuple[float | None, dict]:
    """A real, client-specific conversions-per-session rate over the
    trailing lookback window — never an assumed industry rate."""
    rows = (
        await session.execute(
            select(MetricObservation.period_start, MetricObservation.metric_key, MetricObservation.value).where(
                MetricObservation.client_id == client_id, MetricObservation.metric_key.in_(["ga4_conversions", "ga4_sessions"]),
                MetricObservation.dimension_type == "site", MetricObservation.dimension_value == "__site__",
            ).order_by(MetricObservation.period_start.desc())
        )
    ).all()
    df = pd.DataFrame(rows, columns=["period_start", "metric_key", "value"]).dropna()
    if df.empty:
        return None, {"reason": "no ga4_conversions/ga4_sessions history for this client"}
    df["value"] = df["value"].astype(float)
    wide = df.pivot(index="period_start", columns="metric_key", values="value").dropna()
    if "ga4_conversions" not in wide.columns or "ga4_sessions" not in wide.columns:
        return None, {"reason": "no overlapping ga4_conversions/ga4_sessions days for this client"}

    window = wide.sort_index().tail(CONVERSION_LOOKBACK_DAYS)
    n = len(window)
    if n < MIN_CONVERSION_RATE_DAYS:
        return None, {"reason": f"only {n} overlapping days, need >= {MIN_CONVERSION_RATE_DAYS}"}

    total_sessions = float(window["ga4_sessions"].sum())
    if total_sessions <= 0:
        return None, {"reason": "zero total sessions in lookback window"}
    rate = float(window["ga4_conversions"].sum()) / total_sessions
    return rate, {"data_completeness": n / CONVERSION_LOOKBACK_DAYS, "historical_coverage": min(n / MIN_CONVERSION_RATE_DAYS, 1.0), "conversion_rate_window_days": n}


def _dollar_value(business_values: BusinessValues) -> tuple[float, str]:
    """Precedence, confirmed with the product owner: average
    conversion_value and revenue_per_conversion when both are configured
    (never silently ignore one), use whichever is set if only one is, and
    fall back to lead_value / avg_order_value (in that order) for clients
    whose only configured field is one of those — is_configured already
    guarantees at least one of the four is set."""
    primary = [v for v in (business_values.conversion_value, business_values.revenue_per_conversion) if v]
    if primary:
        return sum(primary) / len(primary), "avg(conversion_value, revenue_per_conversion)" if len(primary) == 2 else (
            "conversion_value" if business_values.conversion_value else "revenue_per_conversion"
        )
    if business_values.lead_value:
        return business_values.lead_value, "lead_value"
    return business_values.avg_order_value, "avg_order_value"


async def _persist(
    session: AsyncSession, client_id: int, metric_key: str, dimension_type: str, dimension_value: str,
    delta_value: float, delta_direction: str, *, status: str, detail: dict,
    mode: str | None = None, projected_dollar_delta: float | None = None, currency: str | None = None,
    projected_metric_unit_delta: float | None = None, metric_unit: str | None = None,
    confidence_components: dict | None = None,
) -> ImpactProjectionRun:
    run = ImpactProjectionRun(
        client_id=client_id, metric_key=metric_key, dimension_type=dimension_type, dimension_value=dimension_value,
        delta_value=delta_value, delta_direction=delta_direction, status=status, mode=mode,
        projected_dollar_delta=projected_dollar_delta, currency=currency,
        projected_metric_unit_delta=projected_metric_unit_delta, metric_unit=metric_unit, method_detail=detail,
    )
    session.add(run)
    await session.flush()  # need run.id before scoring confidence

    if confidence_components is not None:
        confidence_id, confidence = await compute_confidence(
            session, client_id=client_id, subject_type="roi_estimation", subject_id=run.id,
            components=confidence_components,
        )
        run.confidence_score_id = confidence_id
        run.confidence = confidence.score
    return run
