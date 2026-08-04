"""Time-to-Impact Prediction Engine (Phase 2 plan Stage 4) —
impact_predictions, one row per recommendation. See
app/intelligence/impact_prediction.py.

Revision ID: 0022
Revises: 0021
Create Date: 2026-08-03

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB

revision: str = "0022"
down_revision: Union[str, None] = "0021"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "impact_predictions",
        sa.Column("id", sa.BigInteger, primary_key=True, autoincrement=True),
        sa.Column("client_id", sa.Integer, sa.ForeignKey("clients.id", ondelete="CASCADE"), nullable=False),
        sa.Column(
            "recommendation_id", sa.BigInteger, sa.ForeignKey("recommendations.id", ondelete="CASCADE"),
            nullable=False, unique=True,
        ),
        sa.Column("status", sa.Text, nullable=False),
        sa.Column("error", sa.Text, nullable=True),
        sa.Column("category", sa.Text, nullable=True),
        sa.Column("duration_min_weeks", sa.Integer, nullable=True),
        sa.Column("duration_max_weeks", sa.Integer, nullable=True),
        sa.Column("expected_impact_magnitude", sa.Text, nullable=True),
        sa.Column("method_detail", JSONB, nullable=False),
        sa.Column("confidence_score_id", sa.BigInteger, sa.ForeignKey("confidence_scores.id"), nullable=True),
        sa.Column("confidence", sa.Numeric, nullable=True),
        sa.Column("generated_at", sa.TIMESTAMP(timezone=True), server_default=sa.text("now()")),
        sa.CheckConstraint("status IN ('ok','insufficient-data')", name="impact_predictions_status_check"),
        sa.CheckConstraint(
            "category IS NULL OR category IN ('metadata','content','technical','restructuring')",
            name="impact_predictions_category_check",
        ),
        sa.CheckConstraint(
            "expected_impact_magnitude IS NULL OR expected_impact_magnitude IN ('low','medium','high')",
            name="impact_predictions_magnitude_check",
        ),
    )
    op.create_index("idx_impact_predictions_lookup", "impact_predictions", ["client_id", "recommendation_id"])


def downgrade() -> None:
    op.drop_index("idx_impact_predictions_lookup", table_name="impact_predictions")
    op.drop_table("impact_predictions")
