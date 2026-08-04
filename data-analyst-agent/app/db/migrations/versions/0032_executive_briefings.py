"""Phase 3 Step 10 — executive_briefings. See app/briefings/generator.py.

Revision ID: 0032
Revises: 0031
Create Date: 2026-08-04

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB

revision: str = "0032"
down_revision: Union[str, None] = "0031"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "executive_briefings",
        sa.Column("id", sa.BigInteger, primary_key=True, autoincrement=True),
        sa.Column("client_id", sa.Integer, sa.ForeignKey("clients.id", ondelete="CASCADE"), nullable=False),
        sa.Column("cadence", sa.Text, nullable=False),
        sa.Column("period_start", sa.Date, nullable=False),
        sa.Column("period_end", sa.Date, nullable=False),
        sa.Column("biggest_wins", JSONB, nullable=False),
        sa.Column("biggest_risks", JSONB, nullable=False),
        sa.Column("forecast_summary", JSONB, nullable=False),
        sa.Column("recommendations_summary", JSONB, nullable=False),
        sa.Column("opportunity_score", sa.Numeric, nullable=True),
        sa.Column("website_health_score", sa.Numeric, nullable=True),
        sa.Column("trend_summary", JSONB, nullable=False),
        sa.Column("narrative", sa.Text, nullable=True),
        sa.Column("generated_at", sa.TIMESTAMP(timezone=True), server_default=sa.text("now()")),
        sa.CheckConstraint("cadence IN ('morning','weekly','monthly')", name="executive_briefings_cadence_check"),
    )
    op.create_index("idx_executive_briefings_lookup", "executive_briefings", ["client_id", "cadence", "generated_at"])


def downgrade() -> None:
    op.drop_index("idx_executive_briefings_lookup", table_name="executive_briefings")
    op.drop_table("executive_briefings")
