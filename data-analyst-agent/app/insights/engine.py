"""Insight Engine — pure logic over Statistics/Forecast/Anomaly Engine
output. Never calls an LLM, never invents a number: every insight's
`evidence` is copied straight from the anomaly/stats/forecast row that
triggered it. Re-running for the same (client, metric, dimension, period,
insight_type) replaces that insight (delete-then-insert, mirroring the
sibling Node app's own breakdown-table convention) rather than piling up
duplicates — recommendations cascade-delete with their insight and get
regenerated fresh."""
from datetime import date, timedelta

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import Anomaly, Client, Insight, MetricCatalog, MetricObservation, MetricPeriodStats, AnalystRecommendations

# Prompt 8 (content decay): metrics where a decline actually represents lost
# organic value, as opposed to gsc_ctr/gsc_position which can move for
# reasons unrelated to content quality (e.g. a SERP feature grabbing the
# click). Page-dimension only — content decay is a per-page concept.
CONTENT_DECAY_METRICS = ("gsc_clicks", "gsc_impressions")
from app.db.session import SessionLocal

TREND_SHIFT_THRESHOLD_PCT = {"wow": 15.0, "mom": 20.0}
FORECAST_RISK_DECLINE_PCT = 10.0
CORRELATION_WINDOW_DAYS = 1
MAX_CORRELATED_ANOMALIES = 5


async def run_insight_engine() -> None:
    async with SessionLocal() as session:
        clients = (await session.execute(select(Client).where(Client.status == "active"))).scalars().all()

    for client in clients:
        async with SessionLocal() as session:
            await _anomaly_insights(session, client.id)
            await _trend_shift_insights(session, client.id)
            await _forecast_risk_insights(session, client.id)
            await _content_decay_insights(session, client.id)
            await _milestone_insights(session, client.id)
            await session.commit()


async def _replace_insight(session: AsyncSession, *, client_id, metric_key, dimension_type, dimension_value,
                            period_start, insight_type, severity, evidence) -> None:
    existing = (
        await session.execute(
            select(Insight).where(
                Insight.client_id == client_id, Insight.metric_key == metric_key,
                Insight.dimension_type == dimension_type, Insight.dimension_value == dimension_value,
                Insight.period_start == period_start, Insight.insight_type == insight_type,
            )
        )
    ).scalar_one_or_none()

    if existing is not None:
        rec = (
            await session.execute(select(AnalystRecommendations).where(AnalystRecommendations.insight_id == existing.id))
        ).scalar_one_or_none()
        if rec is not None and rec.status == "resolved":
            # Same (client, metric, dimension, period, insight_type) identity as
            # last night, and staff already marked it solved — leave it in place
            # rather than deleting+reinserting, which would cascade-delete the
            # resolved Recommendation and silently un-resolve it. A genuinely
            # new occurrence has a different period_start, so it's a different
            # identity here and will still insert fresh, unresolved, as normal.
            return
        await session.delete(existing)

    session.add(Insight(
        client_id=client_id, metric_key=metric_key, dimension_type=dimension_type, dimension_value=dimension_value,
        period_start=period_start, insight_type=insight_type, severity=severity, evidence=evidence,
    ))


async def _anomaly_insights(session: AsyncSession, client_id: int) -> None:
    today_anomalies = await _latest_anomalies(session, client_id)

    for a in today_anomalies:
        magnitude = abs(a.score) if a.score is not None else 0
        threshold = a.threshold_used or 1
        severity = "high" if magnitude > 2 * threshold else ("medium" if magnitude > threshold else "low")
        correlated = await _correlated_anomalies(session, client_id, a.metric_key, a.period_start)
        await _replace_insight(
            session, client_id=client_id, metric_key=a.metric_key, dimension_type=a.dimension_type,
            dimension_value=a.dimension_value, period_start=a.period_start, insight_type="anomaly",
            severity=severity,
            evidence={"method": a.method, "score": float(a.score) if a.score is not None else None,
                      "direction": a.direction, "value": float(a.value) if a.value is not None else None,
                      "threshold_used": float(a.threshold_used) if a.threshold_used is not None else None,
                      "correlated_anomalies": correlated},
        )


async def _correlated_anomalies(session: AsyncSession, client_id: int, metric_key: str, period_start: date) -> list[dict]:
    """Other metrics that also anomalied within +/- CORRELATION_WINDOW_DAYS
    of this one, for the same client — a real, defensible correlation
    signal ("X dropped the same day Y dropped"), explicitly NOT causal
    inference; callers/readers must word it as correlation, never as cause.
    Feeds the LLM recommendation pass's root-cause narrative
    (insights/recommendations.py::_generate_llm already passes this whole
    evidence dict to the LLM) without that pass needing any change itself."""
    rows = (
        await session.execute(
            select(Anomaly).where(
                Anomaly.client_id == client_id,
                Anomaly.metric_key != metric_key,
                Anomaly.period_start.between(
                    period_start - timedelta(days=CORRELATION_WINDOW_DAYS),
                    period_start + timedelta(days=CORRELATION_WINDOW_DAYS),
                ),
            )
        )
    ).scalars().all()

    # One entry per (metric, dimension) — a metric can carry both a zscore
    # and an iqr flag for the same day; keep whichever has the larger
    # magnitude rather than listing both.
    best: dict[tuple, Anomaly] = {}
    for r in rows:
        key = (r.metric_key, r.dimension_type, r.dimension_value)
        if key not in best or abs(r.score or 0) > abs(best[key].score or 0):
            best[key] = r

    ranked = sorted(best.values(), key=lambda r: abs(r.score or 0), reverse=True)[:MAX_CORRELATED_ANOMALIES]
    return [
        {"metric_key": r.metric_key, "dimension_type": r.dimension_type, "dimension_value": r.dimension_value,
         "period_start": r.period_start.isoformat(), "direction": r.direction}
        for r in ranked
    ]


async def _latest_anomalies(session: AsyncSession, client_id: int) -> list[Anomaly]:
    rows = (await session.execute(select(Anomaly).where(Anomaly.client_id == client_id))).scalars().all()
    if not rows:
        return []
    by_metric: dict[str, date] = {}
    for r in rows:
        if r.metric_key not in by_metric or r.period_start > by_metric[r.metric_key]:
            by_metric[r.metric_key] = r.period_start
    return [r for r in rows if r.period_start == by_metric[r.metric_key]]


async def _trend_shift_insights(session: AsyncSession, client_id: int) -> None:
    rows = (
        await session.execute(select(MetricPeriodStats).where(MetricPeriodStats.client_id == client_id))
    ).scalars().all()
    for r in rows:
        if r.pct_change is None:
            continue
        threshold = TREND_SHIFT_THRESHOLD_PCT.get(r.period_type)
        if threshold is None or abs(float(r.pct_change)) < threshold:
            continue
        magnitude = abs(float(r.pct_change))
        severity = "high" if magnitude > 2 * threshold else "medium"
        correlated = await _correlated_anomalies(session, client_id, r.metric_key, r.period_end)
        await _replace_insight(
            session, client_id=client_id, metric_key=r.metric_key, dimension_type=r.dimension_type,
            dimension_value=r.dimension_value, period_start=r.period_end, insight_type="trend_shift",
            severity=severity,
            evidence={"period_type": r.period_type,
                      "current_value": float(r.current_value) if r.current_value is not None else None,
                      "prior_value": float(r.prior_value) if r.prior_value is not None else None,
                      "pct_change": float(r.pct_change),
                      "correlated_anomalies": correlated},
        )


async def _content_decay_insights(session: AsyncSession, client_id: int) -> None:
    """Classifies an existing page-dimension decline as `content_decay` when
    it meets a stricter, SUSTAINED bar than a single trend_shift — reuses the
    exact same MetricPeriodStats rows _trend_shift_insights already computed
    (deltas.py's nightly WoW/MoM stats engine), never a new statistical
    method. Does not replace or remove the trend_shift/forecast_risk insights
    for the same page — this is an additional classification alongside them.

    Qualifies only if:
    - The 3 most recent WoW snapshots for (metric, page) are real,
      consecutive calendar weeks (exactly 7 days apart, no gap — a gap would
      mean the page dropped out of gsc_page_dimension's top-50 admission
      streak, i.e. missing data, not confirmed decline).
    - EVERY one of those 3 weeks independently clears TREND_SHIFT_THRESHOLD_
      PCT['wow'] on its own (the same bar a single trend_shift already uses)
      — "sustained" means 3-in-a-row, not a new arbitrary number.
    - The latest MoM snapshot for the same (metric, page) ALSO clears
      TREND_SHIFT_THRESHOLD_PCT['mom'] — corroboration that this is a real
      multi-week decline, not 3 volatile weeks that net out flat by month.
      Missing/non-qualifying MoM data means insufficient history/
      corroboration, and this deliberately does NOT fire."""
    for metric_key in CONTENT_DECAY_METRICS:
        rows = (
            await session.execute(
                select(MetricPeriodStats).where(
                    MetricPeriodStats.client_id == client_id, MetricPeriodStats.metric_key == metric_key,
                    MetricPeriodStats.dimension_type == "page", MetricPeriodStats.period_type == "wow",
                )
            )
        ).scalars().all()

        by_page: dict[str, list[MetricPeriodStats]] = {}
        for r in rows:
            by_page.setdefault(r.dimension_value, []).append(r)

        # Batch-fetch every page's MoM rows for this metric once, same as the
        # WoW query above, instead of a per-page round-trip inside the loop
        # below — keeps this an O(1)-query pass regardless of page count.
        mom_rows = (
            await session.execute(
                select(MetricPeriodStats).where(
                    MetricPeriodStats.client_id == client_id, MetricPeriodStats.metric_key == metric_key,
                    MetricPeriodStats.dimension_type == "page", MetricPeriodStats.period_type == "mom",
                )
            )
        ).scalars().all()
        latest_mom_by_page: dict[str, MetricPeriodStats] = {}
        for r in mom_rows:
            existing = latest_mom_by_page.get(r.dimension_value)
            if existing is None or r.period_end > existing.period_end:
                latest_mom_by_page[r.dimension_value] = r

        threshold_wow = TREND_SHIFT_THRESHOLD_PCT["wow"]
        threshold_mom = TREND_SHIFT_THRESHOLD_PCT["mom"]

        for page, page_rows in by_page.items():
            page_rows.sort(key=lambda r: r.period_end, reverse=True)
            if len(page_rows) < 3:
                continue
            recent3 = page_rows[:3]
            if any((recent3[i].period_end - recent3[i + 1].period_end).days != 7 for i in range(2)):
                continue  # a gap means missing weeks, not a confirmed 3-week decline
            wow_pct_changes = [float(r.pct_change) for r in recent3 if r.pct_change is not None]
            if len(wow_pct_changes) < 3 or any(pc > -threshold_wow for pc in wow_pct_changes):
                continue

            mom_row = latest_mom_by_page.get(page)
            if mom_row is None or mom_row.pct_change is None or float(mom_row.pct_change) > -threshold_mom:
                continue  # no MoM corroboration yet — insufficient history, not a false negative

            await _replace_insight(
                session, client_id=client_id, metric_key=metric_key, dimension_type="page",
                dimension_value=page, period_start=recent3[0].period_end, insight_type="content_decay",
                severity="high",
                evidence={
                    "consecutive_weeks": 3, "wow_pct_changes": wow_pct_changes,
                    "mom_pct_change": float(mom_row.pct_change),
                    "wow_threshold_pct": threshold_wow, "mom_threshold_pct": threshold_mom,
                },
            )


async def _forecast_risk_insights(session: AsyncSession, client_id: int) -> None:
    """Dimension-aware since Phase 3 (page/query risk surfacing) — was
    keyed by metric_key alone, so once ForecastRun started covering more
    than one dimension_value per metric (site + any admitted page/query —
    see app/forecast/run.py, which already iterates every enabled
    dimension), this silently kept only whichever run happened to have the
    latest generated_at and always wrote the resulting insight hardcoded as
    dimension_type='site'/dimension_value='__site__' — mislabeling a page's
    or query's own forecast as a site-level one, or dropping it outright if
    a same-run-timestamp site forecast won the tiebreak. Now keyed by
    (metric_key, dimension_type, dimension_value), matching how
    _anomaly_insights/_trend_shift_insights already treat their own source
    rows, and last_actual is looked up in that same real dimension."""
    from app.db.models import ForecastPoint, ForecastRun

    runs = (
        await session.execute(
            select(ForecastRun).where(ForecastRun.client_id == client_id, ForecastRun.status == "ok")
        )
    ).scalars().all()
    latest_per_dim: dict[tuple[str, str, str], ForecastRun] = {}
    for run in runs:
        key = (run.metric_key, run.dimension_type, run.dimension_value)
        if key not in latest_per_dim or run.generated_at > latest_per_dim[key].generated_at:
            latest_per_dim[key] = run

    for run in latest_per_dim.values():
        points = (
            await session.execute(
                select(ForecastPoint).where(ForecastPoint.forecast_run_id == run.id).order_by(ForecastPoint.target_period)
            )
        ).scalars().all()
        if not points:
            continue
        last_actual = await session.scalar(
            select(MetricObservation.value).where(
                MetricObservation.client_id == client_id, MetricObservation.metric_key == run.metric_key,
                MetricObservation.dimension_type == run.dimension_type, MetricObservation.dimension_value == run.dimension_value,
            ).order_by(MetricObservation.period_start.desc()).limit(1)
        )
        if last_actual is None or float(last_actual) == 0:
            continue

        # Scan every forecast point in order (they're already sorted by
        # target_period) and flag the EARLIEST one crossing the decline
        # threshold — not just the last day of the horizon. Checking only
        # points[-1] can miss a dip that shows up mid-horizon and, even when
        # it doesn't, only ever reports "declining by day N" instead of
        # giving staff an actual lead time to act before it happens.
        earliest_breach = None
        for point in points:
            pct_projected_change = (float(point.point_estimate) - float(last_actual)) / float(last_actual) * 100
            if pct_projected_change <= -FORECAST_RISK_DECLINE_PCT:
                earliest_breach = (point, pct_projected_change)
                break
        if earliest_breach is None:
            continue
        breach_point, pct_projected_change = earliest_breach
        days_until_drop = (breach_point.target_period - date.today()).days
        severity = "high" if pct_projected_change < -2 * FORECAST_RISK_DECLINE_PCT else "medium"
        await _replace_insight(
            session, client_id=client_id, metric_key=run.metric_key,
            dimension_type=run.dimension_type, dimension_value=run.dimension_value,
            period_start=breach_point.target_period, insight_type="forecast_risk", severity=severity,
            evidence={"model": run.model, "horizon_periods": run.horizon_periods,
                      "last_actual": float(last_actual), "projected_last_point": float(points[-1].point_estimate),
                      "predicted_date": breach_point.target_period.isoformat(), "days_until_drop": days_until_drop,
                      "pct_projected_change": pct_projected_change},
        )


MILESTONE_BANDS = (25.0, 50.0, 75.0)


async def _milestone_insights(session: AsyncSession, client_id: int) -> None:
    score_metrics = (
        await session.execute(select(MetricCatalog).where(MetricCatalog.enabled.is_(True), MetricCatalog.unit == "score_0_100"))
    ).scalars().all()

    for metric in score_metrics:
        stats = (
            await session.execute(
                select(MetricPeriodStats).where(
                    MetricPeriodStats.client_id == client_id, MetricPeriodStats.metric_key == metric.metric_key,
                    MetricPeriodStats.period_type == "wow",
                )
            )
        ).scalar_one_or_none()
        if stats is None or stats.current_value is None or stats.prior_value is None:
            continue
        current, prior = float(stats.current_value), float(stats.prior_value)
        crossed = next((b for b in MILESTONE_BANDS if min(prior, current) < b <= max(prior, current)), None)
        if crossed is None:
            continue
        severity = "high" if crossed in (25.0, 75.0) else "medium"
        await _replace_insight(
            session, client_id=client_id, metric_key=metric.metric_key, dimension_type="site", dimension_value="__site__",
            period_start=stats.period_end, insight_type="milestone", severity=severity,
            evidence={"crossed_band": crossed, "current_value": current, "prior_value": prior,
                      "direction": "up" if current > prior else "down"},
        )
