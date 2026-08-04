"""Recommendation narration status — makes LLM-enrichment failures visible
and retry-eligible. Before this migration, run_recommendation_engine()
treated "a Recommendation row exists" as "already tried the LLM tailoring
pass", forever, even when that one attempt silently failed (caught and
swallowed with no logging) — every recommendation in production has been
stuck on the static-template fallback with no way to tell. narration_status
distinguishes ok/failed/pending so the nightly job can retry failed/pending
rows, and narration_error/narration_attempted_at give an audit trail for
why a given attempt didn't produce tailored text.

Revision ID: 0020
Revises: 0019
Create Date: 2026-08-03

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "0020"
down_revision: Union[str, None] = "0019"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("recommendations", sa.Column("narration_status", sa.Text, nullable=False, server_default="pending"))
    op.add_column("recommendations", sa.Column("narration_error", sa.Text, nullable=True))
    op.add_column("recommendations", sa.Column("narration_attempted_at", sa.TIMESTAMP(timezone=True), nullable=True))
    op.create_check_constraint(
        "recommendations_narration_status_check", "recommendations",
        "narration_status IN ('pending','ok','failed')",
    )
    # Backfill from the only signal that already exists: a populated
    # root_cause_text means some prior LLM attempt succeeded.
    op.execute(
        "UPDATE recommendations SET narration_status = CASE WHEN root_cause_text IS NOT NULL THEN 'ok' ELSE 'failed' END"
    )


def downgrade() -> None:
    op.drop_constraint("recommendations_narration_status_check", "recommendations", type_="check")
    op.drop_column("recommendations", "narration_attempted_at")
    op.drop_column("recommendations", "narration_error")
    op.drop_column("recommendations", "narration_status")
