"""Pivots metric_observations from long (one row per metric per day) to wide
(one row per day, one column per metric) format for a single client — the
shape scikit-learn's regressors expect. Site-level only (dimension_type=
'site'); dimension-level feature importance isn't in scope for Stage 1."""
import pandas as pd
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import MetricObservation


async def build_feature_matrix(session: AsyncSession, client_id: int) -> pd.DataFrame:
    """One row per period_start, one column per metric_key. Reads every
    site-level observation for this client in a single query and pivots
    in-process, rather than one query per metric. Uses a plain pivot (not
    pivot_table) — metric_observations' primary key already guarantees at
    most one (metric_key, period_start) row per client at dimension_type=
    'site', so a duplicate here is a real bug worth surfacing as an error,
    never silently averaged away. A metric/day with no real observation is
    simply an absent cell — never filled or interpolated."""
    rows = (
        await session.execute(
            select(MetricObservation.period_start, MetricObservation.metric_key, MetricObservation.value)
            .where(MetricObservation.client_id == client_id, MetricObservation.dimension_type == "site")
        )
    ).all()
    if not rows:
        return pd.DataFrame()

    df = pd.DataFrame(rows, columns=["period_start", "metric_key", "value"])
    df["value"] = df["value"].astype(float)
    wide = df.pivot(index="period_start", columns="metric_key", values="value")
    return wide.sort_index()
