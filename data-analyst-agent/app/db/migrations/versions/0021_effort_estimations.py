"""Effort Estimation Engine (Phase 2 plan Stage 3) — effort_estimations,
one row per recommendation. See app/intelligence/effort_estimation.py.

Revision ID: 0021
Revises: 0020
Create Date: 2026-08-03

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB

revision: str = "0021"
down_revision: Union[str, None] = "0020"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "effort_estimations",
        sa.Column("id", sa.BigInteger, primary_key=True, autoincrement=True),
        sa.Column("client_id", sa.Integer, sa.ForeignKey("clients.id", ondelete="CASCADE"), nullable=False),
        sa.Column(
            "recommendation_id", sa.BigInteger, sa.ForeignKey("recommendations.id", ondelete="CASCADE"),
            nullable=False, unique=True,
        ),
        sa.Column("status", sa.Text, nullable=False),
        sa.Column("error", sa.Text, nullable=True),
        sa.Column("category", sa.Text, nullable=True),
        sa.Column("effort_level", sa.Integer, nullable=True),
        sa.Column("effort_label", sa.Text, nullable=True),
        sa.Column("affected_page_count", sa.Integer, nullable=True),
        sa.Column("affected_page_count_status", sa.Text, nullable=True),
        sa.Column("method_detail", JSONB, nullable=False),
        sa.Column("confidence_score_id", sa.BigInteger, sa.ForeignKey("confidence_scores.id"), nullable=True),
        sa.Column("confidence", sa.Numeric, nullable=True),
        sa.Column("generated_at", sa.TIMESTAMP(timezone=True), server_default=sa.text("now()")),
        sa.CheckConstraint("status IN ('ok','insufficient-data')", name="effort_estimations_status_check"),
        sa.CheckConstraint(
            "category IS NULL OR category IN ('metadata','content','technical','restructuring')",
            name="effort_estimations_category_check",
        ),
        sa.CheckConstraint(
            "effort_level IS NULL OR effort_level BETWEEN 1 AND 5", name="effort_estimations_effort_level_check",
        ),
        sa.CheckConstraint(
            "affected_page_count_status IS NULL OR affected_page_count_status IN ('ok','insufficient-data','not-applicable')",
            name="effort_estimations_page_count_status_check",
        ),
    )
    op.create_index("idx_effort_estimations_lookup", "effort_estimations", ["client_id", "recommendation_id"])


def downgrade() -> None:
    op.drop_index("idx_effort_estimations_lookup", table_name="effort_estimations")
    op.drop_table("effort_estimations")
