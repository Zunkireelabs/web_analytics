"""Correlation Explorer engine — Phase 2 Stage 3. A real Pearson correlation
matrix across the client's enabled dashboard metrics, distinct from
app/insights/engine.py's `_correlated_anomalies` (an anomaly co-occurrence
heuristic, explicitly not a coefficient — see that function's own
docstring). Reuses app/ml/feature_matrix.py's existing wide DataFrame
unmodified. On-demand, no persistence: pandas.DataFrame.corr() over a
handful of enabled metrics is a trivial CPU cost, the same request-cost
class as /ask, not a model fit worth a nightly run and an audit table."""
from dataclasses import dataclass, field

import pandas as pd
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import MetricCatalog
from app.ml.feature_matrix import build_feature_matrix

DEFAULT_MIN_OVERLAP_DAYS = 30
TOP_PAIRS_LIMIT = 10


@dataclass
class CorrelationResult:
    status: str  # 'ok' | 'insufficient-data'
    metric_keys: list[str] = field(default_factory=list)
    matrix: dict[str, dict[str, float | None]] = field(default_factory=dict)
    top_pairs: list[dict] = field(default_factory=list)
    detail: dict = field(default_factory=dict)


async def compute_correlation_matrix(
    session: AsyncSession, *, client_id: int, min_overlap_days: int = DEFAULT_MIN_OVERLAP_DAYS,
) -> CorrelationResult:
    matrix = await build_feature_matrix(session, client_id)
    if matrix.empty:
        return CorrelationResult(status="insufficient-data", detail={"reason": "no observations for this client"})

    enabled_keys = set((
        await session.execute(select(MetricCatalog.metric_key).where(MetricCatalog.enabled.is_(True)))
    ).scalars().all())
    columns = [c for c in matrix.columns if c in enabled_keys]
    if len(columns) < 2:
        return CorrelationResult(status="insufficient-data", detail={"reason": "fewer than 2 enabled metrics with observations"})
    df = matrix[columns].astype(float)

    # pandas' own pairwise-complete-observations behavior — exactly what's
    # wanted here, since different metrics can have different history
    # lengths/gaps. min_periods marks a pair NaN (never a fabricated r from
    # too few overlapping days) rather than silently computing on 2-3 points.
    corr = df.corr(min_periods=min_overlap_days)
    overlap_counts = df.notna().astype(int).T.dot(df.notna().astype(int))

    matrix_out: dict[str, dict[str, float | None]] = {}
    pairs = []
    for i, a in enumerate(columns):
        matrix_out[a] = {}
        for j, b in enumerate(columns):
            r = corr.loc[a, b]
            r_value = None if pd.isna(r) else float(r)
            matrix_out[a][b] = r_value
            if i < j:
                pairs.append({
                    "metric_a": a, "metric_b": b, "r": r_value,
                    "n_overlapping_days": int(overlap_counts.loc[a, b]),
                })

    top_pairs = sorted((p for p in pairs if p["r"] is not None), key=lambda p: abs(p["r"]), reverse=True)[:TOP_PAIRS_LIMIT]

    return CorrelationResult(
        status="ok", metric_keys=columns, matrix=matrix_out, top_pairs=top_pairs,
        detail={"min_overlap_days": min_overlap_days},
    )
