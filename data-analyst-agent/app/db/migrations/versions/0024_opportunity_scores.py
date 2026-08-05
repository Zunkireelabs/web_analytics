"""Opportunity Scoring Engine (Phase 2 plan Stage 6) — opportunity_scores,
one row per recommendation. See app/intelligence/opportunity_scoring.py.

Revision ID: 0024
Revises: 0023
Create Date: 2026-08-03

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB

revision: str = "0024"
down_revision: Union[str, None] = "0023"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "opportunity_scores",
        sa.Column("id", sa.BigInteger, primary_key=True, autoincrement=True),
        sa.Column("client_id", sa.Integer, sa.ForeignKey("clients.id", ondelete="CASCADE"), nullable=False),
        sa.Column(
            "recommendation_id", sa.BigInteger, sa.ForeignKey("analyst_recommendations.id", ondelete="CASCADE"),
            nullable=False, unique=True,
        ),
        sa.Column("status", sa.Text, nullable=False),
        sa.Column("error", sa.Text, nullable=True),
        sa.Column("opportunity_score", sa.Numeric, nullable=True),
        sa.Column("factors", JSONB, nullable=False),
        sa.Column("method_detail", JSONB, nullable=False),
        sa.Column("confidence_score_id", sa.BigInteger, sa.ForeignKey("confidence_scores.id"), nullable=True),
        sa.Column("confidence", sa.Numeric, nullable=True),
        sa.Column("generated_at", sa.TIMESTAMP(timezone=True), server_default=sa.text("now()")),
        sa.CheckConstraint("status IN ('ok','insufficient-data')", name="opportunity_scores_status_check"),
    )
    op.create_index("idx_opportunity_scores_lookup", "opportunity_scores", ["client_id", "recommendation_id"])


def downgrade() -> None:
    op.drop_index("idx_opportunity_scores_lookup", table_name="opportunity_scores")
    op.drop_table("opportunity_scores")
