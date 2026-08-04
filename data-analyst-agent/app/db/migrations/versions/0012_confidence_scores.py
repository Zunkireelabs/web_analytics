"""Phase 2 Stage 0 — confidence_scores. Shared confidence table for every
upcoming intelligence engine (feature importance, root cause, opportunity
score, roi/effort/impact estimation, recommendation ranking) — one table,
one compute_confidence() call site (app/scoring/confidence.py), instead of
duplicating the same weighted-average logic per engine. subject_type's check
constraint lists every Phase 2 subject up front even though most of those
tables don't exist yet — this is a pure fact table with no FK to them.

Revision ID: 0012
Revises: 0009
Create Date: 2026-08-02

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB

revision: str = "0012"
down_revision: Union[str, None] = "0009"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "confidence_scores",
        sa.Column("id", sa.BigInteger, primary_key=True, autoincrement=True),
        sa.Column("client_id", sa.Integer, sa.ForeignKey("clients.id", ondelete="CASCADE"), nullable=False),
        sa.Column("subject_type", sa.Text, nullable=False),
        sa.Column("subject_id", sa.BigInteger, nullable=False),
        sa.Column("status", sa.Text, nullable=False),
        sa.Column("score", sa.Numeric, nullable=True),
        sa.Column("components", JSONB, nullable=False),
        sa.Column("generated_at", sa.TIMESTAMP(timezone=True), server_default=sa.text("now()")),
        sa.CheckConstraint(
            "subject_type IN ('feature_importance','root_cause_analysis','opportunity_score',"
            "'roi_estimation','effort_estimation','impact_prediction','recommendation_ranking')",
            name="confidence_scores_subject_type_check",
        ),
        sa.CheckConstraint("status IN ('ok','insufficient-data')", name="confidence_scores_status_check"),
    )
    op.create_index(
        "idx_confidence_scores_lookup", "confidence_scores", ["client_id", "subject_type", "subject_id"],
    )


def downgrade() -> None:
    op.drop_index("idx_confidence_scores_lookup", table_name="confidence_scores")
    op.drop_table("confidence_scores")
