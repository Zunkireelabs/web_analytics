"""Phase 3 Step 9 — ai_activity_log. See app/activity/log.py.

Revision ID: 0030
Revises: 0029
Create Date: 2026-08-04

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB

revision: str = "0030"
down_revision: Union[str, None] = "0029"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "ai_activity_log",
        sa.Column("id", sa.BigInteger, primary_key=True, autoincrement=True),
        sa.Column("client_id", sa.Integer, sa.ForeignKey("clients.id", ondelete="CASCADE"), nullable=True),
        sa.Column("task_type", sa.Text, nullable=False),
        sa.Column("status", sa.Text, nullable=False, server_default="running"),
        sa.Column("detail", JSONB, nullable=True),
        sa.Column("error", sa.Text, nullable=True),
        sa.Column("started_at", sa.TIMESTAMP(timezone=True), server_default=sa.text("now()")),
        sa.Column("finished_at", sa.TIMESTAMP(timezone=True), nullable=True),
        sa.Column("took_ms", sa.Integer, nullable=True),
        sa.CheckConstraint(
            "task_type IN ('monitoring','forecasting','investigating','generating_recommendations','preparing_drafts')",
            name="ai_activity_log_task_type_check",
        ),
        sa.CheckConstraint("status IN ('queued','running','completed','failed')", name="ai_activity_log_status_check"),
    )
    op.create_index("idx_ai_activity_log_lookup", "ai_activity_log", ["started_at"])


def downgrade() -> None:
    op.drop_index("idx_ai_activity_log_lookup", table_name="ai_activity_log")
    op.drop_table("ai_activity_log")
