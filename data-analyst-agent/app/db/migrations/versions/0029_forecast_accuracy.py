"""Phase 3 AI memory — forecast_accuracy. See app/forecast/accuracy.py.

Revision ID: 0029
Revises: 0028
Create Date: 2026-08-04

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "0029"
down_revision: Union[str, None] = "0028"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "forecast_accuracy",
        sa.Column("id", sa.BigInteger, primary_key=True, autoincrement=True),
        sa.Column("client_id", sa.Integer, sa.ForeignKey("clients.id", ondelete="CASCADE"), nullable=False),
        sa.Column("metric_key", sa.Text, sa.ForeignKey("metrics_catalog.metric_key"), nullable=False),
        sa.Column(
            "forecast_point_id", sa.BigInteger, sa.ForeignKey("forecast_points.id", ondelete="CASCADE"),
            nullable=False, unique=True,
        ),
        sa.Column("predicted_value", sa.Numeric, nullable=False),
        sa.Column("actual_value", sa.Numeric, nullable=False),
        sa.Column("abs_pct_error", sa.Numeric, nullable=True),
        sa.Column("evaluated_at", sa.TIMESTAMP(timezone=True), server_default=sa.text("now()")),
    )
    op.create_index("idx_forecast_accuracy_lookup", "forecast_accuracy", ["client_id", "metric_key", "evaluated_at"])


def downgrade() -> None:
    op.drop_index("idx_forecast_accuracy_lookup", table_name="forecast_accuracy")
    op.drop_table("forecast_accuracy")
