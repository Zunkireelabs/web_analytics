"""Add NOT NULL to the 9 server_default-populated timestamp columns that
0001 created without the constraint (clients.created_at/updated_at,
metrics_catalog.created_at, metric_period_stats.created_at,
anomalies.created_at, forecast_runs.generated_at, insights.generated_at,
recommendations.generated_at, ingestion_runs.created_at). Every one of them
is populated by server_default=func.now() on insert and nothing in the app
ever writes NULL to them — models.py's Mapped[datetime] (no | None) already
assumed NOT NULL; this just closes the alembic-check drift between that
assumption and the real schema. No existing row can violate it.

Revision ID: 0009
Revises: 0008
Create Date: 2026-07-31

"""
from typing import Sequence, Union

from alembic import op

revision: str = "0009"
down_revision: Union[str, None] = "0008"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_COLUMNS = (
    ("clients", "created_at"),
    ("clients", "updated_at"),
    ("metrics_catalog", "created_at"),
    ("metric_period_stats", "created_at"),
    ("anomalies", "created_at"),
    ("forecast_runs", "generated_at"),
    ("insights", "generated_at"),
    ("recommendations", "generated_at"),
    ("ingestion_runs", "created_at"),
)


def upgrade() -> None:
    for table, column in _COLUMNS:
        op.alter_column(table, column, nullable=False)


def downgrade() -> None:
    for table, column in _COLUMNS:
        op.alter_column(table, column, nullable=True)
