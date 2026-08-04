"""Recommendation Prioritizer (Phase 2 plan Stage 7) —
recommendation_rankings, one row per recommendation. See
app/intelligence/prioritizer.py.

Revision ID: 0025
Revises: 0024
Create Date: 2026-08-03

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB

revision: str = "0025"
down_revision: Union[str, None] = "0024"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "recommendation_rankings",
        sa.Column("id", sa.BigInteger, primary_key=True, autoincrement=True),
        sa.Column("client_id", sa.Integer, sa.ForeignKey("clients.id", ondelete="CASCADE"), nullable=False),
        sa.Column(
            "recommendation_id", sa.BigInteger, sa.ForeignKey("recommendations.id", ondelete="CASCADE"),
            nullable=False, unique=True,
        ),
        sa.Column("status", sa.Text, nullable=False),
        sa.Column("error", sa.Text, nullable=True),
        sa.Column("priority_score", sa.Numeric, nullable=True),
        sa.Column("rank", sa.Integer, nullable=True),
        sa.Column("method_detail", JSONB, nullable=False),
        sa.Column("confidence_score_id", sa.BigInteger, sa.ForeignKey("confidence_scores.id"), nullable=True),
        sa.Column("confidence", sa.Numeric, nullable=True),
        sa.Column("generated_at", sa.TIMESTAMP(timezone=True), server_default=sa.text("now()")),
        sa.CheckConstraint("status IN ('ok','insufficient-data')", name="recommendation_rankings_status_check"),
    )
    op.create_index("idx_recommendation_rankings_lookup", "recommendation_rankings", ["client_id", "rank"])


def downgrade() -> None:
    op.drop_index("idx_recommendation_rankings_lookup", table_name="recommendation_rankings")
    op.drop_table("recommendation_rankings")
