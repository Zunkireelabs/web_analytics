"""fix_outcomes: what actually happened after a fix shipped, sent back by the app that measured it.

The Node app already measures every merged fix (31 days after the merge, real clicks before vs after) but that result never reached
this service, so impact predictions stayed a static lookup with no confidence (app/intelligence/impact_prediction.py: "no confidence
figure until there is measured evidence"). This table is that evidence: one row per measured fix, per client, never shared across clients.

Additive only: one new table, nothing existing is altered. `external_ref` makes the write idempotent (the sender may retry).

Revision ID: 0043
Revises: 0042
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0043"
down_revision: Union[str, None] = "0042"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "fix_outcomes",
        sa.Column("id", sa.BigInteger, primary_key=True, autoincrement=True),
        sa.Column("client_id", sa.Integer, sa.ForeignKey("clients.id", ondelete="CASCADE"), nullable=False),
        sa.Column("external_ref", sa.Text, nullable=False),
        sa.Column("generator_id", sa.Text, nullable=False),
        sa.Column("category", sa.Text),
        sa.Column("improved", sa.Boolean, nullable=False),
        sa.Column("clicks_delta", sa.Numeric),
        sa.Column("delta", postgresql.JSONB, nullable=False, server_default=sa.text("'{}'::jsonb")),
        sa.Column("measured_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("recorded_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.UniqueConstraint("client_id", "external_ref", name="fix_outcomes_unique_ref"),
        sa.CheckConstraint(
            "category IS NULL OR category IN ('metadata','content','technical','restructuring')", name="fix_outcomes_category_check",
        ),
    )
    op.create_index("idx_fix_outcomes_lookup", "fix_outcomes", ["client_id", "category"])


def downgrade() -> None:
    op.drop_index("idx_fix_outcomes_lookup", table_name="fix_outcomes")
    op.drop_table("fix_outcomes")
