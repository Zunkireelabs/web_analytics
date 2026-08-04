"""Root Cause Analysis Engine v2 (Phase 2 Stage 2, extended) — for each
anomaly/trend_shift insight (site-level OR per-dimension), ranks every
enabled dimension_type's top dimension_value by its share of the site-level
change, reusing MetricPeriodStats rows the Statistics Engine already
computed nightly (app/stats/deltas.py) — zero new MCP calls. Reported as
PARALLEL SIBLINGS under a synthetic root: each is independently ranked
against the same site-level baseline, never against each other, and the
shares are not expected to sum to 100% (a real, honest property of
independent single-dimension shares, not a bug). For GSC metrics, adds one
more terminal leaf reusing the page/query top-movers logic already built
for the dashboard (app/api/routes/breakdown.py) — that data has no
MetricPeriodStats equivalent to rank against, so it's presented separately
rather than folded into the ranking.

v1 only ran for site-level insights. v2 also runs for a per-dimension
insight (e.g. a trend_shift on dimension_type='device', dimension_value=
'mobile') — the root of the tree is still always the site-level baseline
(unchanged), but the sibling node for the insight's OWN dimension_type is
pinned to its own dimension_value (_dimension_value_stats) instead of
picked by "whichever value moved most" (_top_contributor), so the tree
always accurately explains the exact finding that fired rather than a
coincidentally-larger sibling in the same dimension_type.

A true nested/combined-dimension drill-down (e.g. "Organic AND Mobile AND
India" as one filtered query) remains out of scope — it needs a
multi-dimension MCP query this service doesn't have yet."""
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.routes.breakdown import get_page_query_top_movers_data
from app.db.dimension_lookup import iter_enabled_metric_dimensions
from app.db.models import Client, Insight, MetricCatalog, MetricPeriodStats, RootCauseAnalysisNode, RootCauseAnalysisRun
from app.db.session import SessionLocal
from app.insights.engine import TREND_SHIFT_THRESHOLD_PCT
from app.scoring.confidence import compute_confidence

METHOD = "independent_dimension_share"
TRIGGER_INSIGHT_TYPES = ("anomaly", "trend_shift")
GSC_METRIC_KEYS = ("gsc_clicks", "gsc_impressions", "gsc_ctr", "gsc_position")


async def run_root_cause_analysis() -> None:
    async with SessionLocal() as session:
        clients = (await session.execute(select(Client).where(Client.status == "active"))).scalars().all()

    for client in clients:
        async with SessionLocal() as session:
            insights = (
                await session.execute(
                    select(Insight).where(
                        Insight.client_id == client.id,
                        Insight.insight_type.in_(TRIGGER_INSIGHT_TYPES),
                    )
                )
            ).scalars().all()
            # Same idempotency pattern as the Recommendation Engine: the
            # Insight Engine replaces (delete+reinsert) an insight's row
            # rather than updating it, so a genuinely new occurrence always
            # has a fresh id and naturally re-triggers RCA; an unchanged
            # insight from a prior night is skipped rather than re-analyzed.
            already_analyzed = {
                r[0] for r in (
                    await session.execute(
                        select(RootCauseAnalysisRun.insight_id).where(RootCauseAnalysisRun.client_id == client.id)
                    )
                ).all()
            }
            for insight in insights:
                if insight.id in already_analyzed:
                    continue
                await _analyze(session, client.id, insight)
            await session.commit()


async def _analyze(session: AsyncSession, client_id: int, insight: Insight) -> None:
    metric = await session.get(MetricCatalog, insight.metric_key)
    if metric is None:
        await _record_insufficient(session, client_id, insight.id, "unknown target metric")
        return

    # Smallest granularity MetricPeriodStats actually computes for this
    # metric's cadence — 'wow' for daily/weekly metrics, 'mom' for monthly
    # ones (see app/stats/deltas.py). Used uniformly for both trigger types:
    # a 'trend_shift' insight already carries this in its own evidence, but
    # an 'anomaly' insight is a single-day z-score/IQR flag with no period
    # comparison of its own — this is the same rolling-window comparison
    # the Insight Engine's milestone/trend-shift checks already use as the
    # standard "current vs. previous period" lens for this metric.
    period_type = "mom" if metric.cadence == "monthly" else "wow"

    site_stats = (
        await session.execute(
            select(MetricPeriodStats).where(
                MetricPeriodStats.client_id == client_id, MetricPeriodStats.metric_key == metric.metric_key,
                MetricPeriodStats.dimension_type == "site", MetricPeriodStats.dimension_value == "__site__",
                MetricPeriodStats.period_type == period_type,
            ).order_by(MetricPeriodStats.period_end.desc()).limit(1)
        )
    ).scalar_one_or_none()
    if site_stats is None or site_stats.abs_change is None or float(site_stats.abs_change) == 0:
        await _record_insufficient(session, client_id, insight.id, "no site-level abs_change to attribute for this period")
        return
    baseline_change = float(site_stats.abs_change)
    period_end = site_stats.period_end

    metric_dims = await iter_enabled_metric_dimensions(session)
    candidate_dim_types = sorted({md.dimension_type for md in metric_dims if md.metric.metric_key == metric.metric_key})

    run = RootCauseAnalysisRun(client_id=client_id, insight_id=insight.id, method=METHOD, status="ok", max_depth_reached=0)
    session.add(run)
    await session.flush()  # need run.id before inserting nodes

    root = RootCauseAnalysisNode(
        run_id=run.id, parent_node_id=None, depth=0, dimension_type="site", dimension_value="__site__",
        current_value=_f(site_stats.current_value), prior_value=_f(site_stats.prior_value),
        abs_change=baseline_change, pct_change=_f(site_stats.pct_change), share_of_baseline_change_pct=100.0,
    )
    session.add(root)
    await session.flush()  # need root.id as parent_node_id below

    dims_with_data = 0
    max_depth = 0
    for dim_type in candidate_dim_types:
        if insight.dimension_type not in (None, "site") and dim_type == insight.dimension_type:
            # This is the dimension_type the insight itself fired on — pin
            # to its own dimension_value rather than "whichever value moved
            # most", so the tree always contains an accurate node for the
            # exact finding under investigation.
            top = await _dimension_value_stats(
                session, client_id, metric.metric_key, dim_type, insight.dimension_value,
                period_type, period_end, baseline_change,
            )
        else:
            top = await _top_contributor(session, client_id, metric.metric_key, dim_type, period_type, period_end, baseline_change)
        if top is None:
            continue
        dims_with_data += 1
        max_depth = max(max_depth, 1)
        dim_value, stats, share = top
        session.add(RootCauseAnalysisNode(
            run_id=run.id, parent_node_id=root.id, depth=1, dimension_type=dim_type, dimension_value=dim_value,
            current_value=_f(stats.current_value), prior_value=_f(stats.prior_value),
            abs_change=_f(stats.abs_change), pct_change=_f(stats.pct_change), share_of_baseline_change_pct=share,
        ))

    if metric.metric_key in GSC_METRIC_KEYS:
        if await _add_page_query_leaf(session, client_id, run.id, root.id):
            max_depth = max(max_depth, 2)

    run.max_depth_reached = max_depth

    confidence_id, confidence = await compute_confidence(
        session, client_id=client_id, subject_type="root_cause_analysis", subject_id=run.id,
        components={
            "data_completeness": (dims_with_data / len(candidate_dim_types)) if candidate_dim_types else None,
            "historical_coverage": None,
            **_significance_components(insight),
        },
    )
    run.confidence_score_id = confidence_id
    run.confidence = confidence.score


async def _top_contributor(
    session: AsyncSession, client_id: int, metric_key: str, dimension_type: str,
    period_type: str, period_end, baseline_change: float,
) -> tuple[str, MetricPeriodStats, float] | None:
    """The dimension_value with the largest |abs_change|, for the SAME
    period_type/period_end as the site-level baseline — an apples-to-apples
    comparison, not each dimension_value's own independently-latest row."""
    rows = (
        await session.execute(
            select(MetricPeriodStats).where(
                MetricPeriodStats.client_id == client_id, MetricPeriodStats.metric_key == metric_key,
                MetricPeriodStats.dimension_type == dimension_type, MetricPeriodStats.period_type == period_type,
                MetricPeriodStats.period_end == period_end,
            )
        )
    ).scalars().all()
    candidates = [r for r in rows if r.abs_change is not None]
    if not candidates:
        return None
    best = max(candidates, key=lambda r: abs(float(r.abs_change)))
    share = abs(float(best.abs_change)) / abs(baseline_change) * 100
    return best.dimension_value, best, share


async def _dimension_value_stats(
    session: AsyncSession, client_id: int, metric_key: str, dimension_type: str, dimension_value: str,
    period_type: str, period_end, baseline_change: float,
) -> tuple[str, MetricPeriodStats, float] | None:
    """Like _top_contributor, but pinned to one specific dimension_value —
    used only for the dimension_type that triggered this run's own insight,
    so the tree always surfaces THIS finding's own change rather than
    whichever value happens to have the largest |abs_change| this period."""
    row = (
        await session.execute(
            select(MetricPeriodStats).where(
                MetricPeriodStats.client_id == client_id, MetricPeriodStats.metric_key == metric_key,
                MetricPeriodStats.dimension_type == dimension_type, MetricPeriodStats.dimension_value == dimension_value,
                MetricPeriodStats.period_type == period_type, MetricPeriodStats.period_end == period_end,
            )
        )
    ).scalar_one_or_none()
    if row is None or row.abs_change is None:
        return None
    share = abs(float(row.abs_change)) / abs(baseline_change) * 100
    return dimension_value, row, share


async def _add_page_query_leaf(session: AsyncSession, client_id: int, run_id: int, root_id: int) -> bool:
    added = False
    for dim_type in ("page", "query"):
        data = await get_page_query_top_movers_data(session, client_id, dim_type)
        movers = [r for r in data["rows"] if r["clicks_change"] is not None]
        if not movers:
            continue
        top = max(movers, key=lambda r: abs(r["clicks_change"]))
        pct_change = (top["clicks_change"] / top["prior_clicks"] * 100) if top["prior_clicks"] else None
        session.add(RootCauseAnalysisNode(
            run_id=run_id, parent_node_id=root_id, depth=2, dimension_type=dim_type, dimension_value=top["dimension_value"],
            current_value=top["clicks"], prior_value=top["prior_clicks"], abs_change=top["clicks_change"],
            pct_change=pct_change, share_of_baseline_change_pct=None,
        ))
        added = True
    return added


def _significance_components(insight: Insight) -> dict:
    """Reuses whatever magnitude signal the triggering insight's own
    evidence already carries, rather than re-deriving a new one."""
    if insight.insight_type == "anomaly":
        score, threshold = insight.evidence.get("score"), insight.evidence.get("threshold_used")
        anomaly_strength = min(abs(score) / threshold, 1.0) if score is not None and threshold else None
        return {"statistical_significance": None, "model_certainty": None, "anomaly_strength": anomaly_strength}
    if insight.insight_type == "trend_shift":
        pct_change, period_type = insight.evidence.get("pct_change"), insight.evidence.get("period_type")
        threshold = TREND_SHIFT_THRESHOLD_PCT.get(period_type) if period_type else None
        stat_sig = min(abs(pct_change) / (2 * threshold), 1.0) if pct_change is not None and threshold else None
        return {"statistical_significance": stat_sig, "model_certainty": None, "anomaly_strength": None}
    return {"statistical_significance": None, "model_certainty": None, "anomaly_strength": None}


async def _record_insufficient(session: AsyncSession, client_id: int, insight_id: int, reason: str) -> None:
    session.add(RootCauseAnalysisRun(
        client_id=client_id, insight_id=insight_id, method=METHOD,
        status="insufficient-data", error=reason, max_depth_reached=0,
    ))


def _f(value) -> float | None:
    return float(value) if value is not None else None
