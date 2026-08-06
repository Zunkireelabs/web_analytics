"""Enable query-dimension anomaly/trend-shift/forecast detection for the 4
GSC metrics, via the new gsc_query_dimension collector. metric_dimension_
support rows for (gsc_*, 'query') were already pre-seeded disabled by 0001 —
this uses INSERT ... ON CONFLICT DO UPDATE rather than a bare UPDATE, same
convention as 0017's page-dimension rollout, so it's correct even if any
environment's rows drifted from that baseline.

Revision ID: 0033
Revises: 0032
Create Date: 2026-08-06

"""
from typing import Sequence, Union

from alembic import op
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy import table, column, Text, Boolean

revision: str = "0033"
down_revision: Union[str, None] = "0032"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_GSC_METRIC_KEYS = ("gsc_clicks", "gsc_impressions", "gsc_ctr", "gsc_position")

dim_support = table(
    "metric_dimension_support",
    column("metric_key", Text),
    column("dimension_type", Text),
    column("collector_id", Text),
    column("enabled", Boolean),
)


def upgrade() -> None:
    for key in _GSC_METRIC_KEYS:
        stmt = pg_insert(dim_support).values(
            metric_key=key, dimension_type="query", collector_id="gsc_query_dimension", enabled=True,
        )
        stmt = stmt.on_conflict_do_update(
            index_elements=["metric_key", "dimension_type"],
            set_={"collector_id": "gsc_query_dimension", "enabled": True},
        )
        op.execute(stmt)


def downgrade() -> None:
    keys = "'" + "','".join(_GSC_METRIC_KEYS) + "'"
    op.execute(
        f"UPDATE metric_dimension_support SET enabled = false, collector_id = NULL "
        f"WHERE dimension_type = 'query' AND metric_key IN ({keys})"
    )
