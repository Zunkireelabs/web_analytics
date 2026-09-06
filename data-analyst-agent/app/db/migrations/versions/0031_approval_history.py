"""Phase 3 Step 8 — approval_history for investigation-level approvals.

Revision ID: 0031
Revises: 0030
Create Date: 2026-08-04

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "0031"
down_revision: Union[str, None] = "0030"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "approval_history",
        sa.Column("id", sa.BigInteger, primary_key=True, autoincrement=True),
        sa.Column(
            "investigation_id", sa.BigInteger, sa.ForeignKey("investigations.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("decision", sa.Text, nullable=False),
        sa.Column("reviewer", sa.Text, nullable=True),
        sa.Column("reason", sa.Text, nullable=True),
        sa.Column("created_at", sa.TIMESTAMP(timezone=True), server_default=sa.text("now()")),
        sa.CheckConstraint("decision IN ('approved','rejected','revision_requested')", name="approval_history_decision_check"),
    )
    op.create_index("idx_approval_history_lookup", "approval_history", ["investigation_id", "created_at"])


def downgrade() -> None:
    op.drop_index("idx_approval_history_lookup", table_name="approval_history")
    op.drop_table("approval_history")
