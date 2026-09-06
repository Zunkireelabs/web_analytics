"""Phase 5 — page_query_observations cache table. A genuine schema addition
(the one case the project's "avoid schema changes" constraint allows): real
page/query cardinality (thousands of distinct URLs/queries per client) makes
reusing metric_observations' per-dimension-value engine loop performance-
prohibitive, and the source MCP tool itself caps at top-50 anyway. See
app/collectors/page_query.py and app/db/models.py::PageQueryObservation.
Deliberately NOT wired into metric_period_stats/anomalies/forecast_runs.

Revision ID: 0007
Revises: 0006
Create Date: 2026-07-31

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "0007"
down_revision: Union[str, None] = "0006"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "page_query_observations",
        sa.Column("client_id", sa.Integer, sa.ForeignKey("clients.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("dimension_type", sa.Text, primary_key=True),
        sa.Column("dimension_value", sa.Text, primary_key=True),
        sa.Column("period_start", sa.Date, primary_key=True),
        sa.Column("clicks", sa.Numeric, nullable=True),
        sa.Column("impressions", sa.Numeric, nullable=True),
        sa.Column("ctr", sa.Numeric, nullable=True),
        sa.Column("position", sa.Numeric, nullable=True),
        sa.CheckConstraint("dimension_type IN ('page','query')", name="page_query_observations_dimension_type_check"),
    )
    op.create_index(
        "idx_page_query_observations_lookup",
        "page_query_observations", ["client_id", "dimension_type", "period_start"],
    )


def downgrade() -> None:
    op.drop_index("idx_page_query_observations_lookup", table_name="page_query_observations")
    op.drop_table("page_query_observations")
