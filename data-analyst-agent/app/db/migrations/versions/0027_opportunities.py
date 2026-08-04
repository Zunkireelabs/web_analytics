"""Phase 3 — opportunities, one row per investigation. See
app/opportunities/rollup.py.

Revision ID: 0027
Revises: 0026
Create Date: 2026-08-04

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB

revision: str = "0027"
down_revision: Union[str, None] = "0026"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "opportunities",
        sa.Column("id", sa.BigInteger, primary_key=True, autoincrement=True),
        sa.Column("client_id", sa.Integer, sa.ForeignKey("clients.id", ondelete="CASCADE"), nullable=False),
        sa.Column(
            "investigation_id", sa.BigInteger, sa.ForeignKey("investigations.id", ondelete="CASCADE"),
            nullable=False, unique=True,
        ),
        sa.Column("opportunity_score", sa.Numeric, nullable=True),
        sa.Column("priority", sa.Text, nullable=True),
        sa.Column("forecast_gain", JSONB, nullable=True),
        sa.Column("business_impact", sa.Numeric, nullable=True),
        sa.Column("business_impact_currency", sa.Text, nullable=True),
        sa.Column("confidence", sa.Numeric, nullable=True),
        sa.Column("recommendation_count", sa.Integer, nullable=False, server_default="0"),
        sa.Column("status", sa.Text, nullable=False, server_default="open"),
        sa.Column("created_at", sa.TIMESTAMP(timezone=True), server_default=sa.text("now()")),
        sa.Column("updated_at", sa.TIMESTAMP(timezone=True), server_default=sa.text("now()")),
        sa.CheckConstraint("status IN ('open','captured','expired')", name="opportunities_status_check"),
    )
    op.create_index("idx_opportunities_lookup", "opportunities", ["client_id", "status"])


def downgrade() -> None:
    op.drop_index("idx_opportunities_lookup", table_name="opportunities")
    op.drop_table("opportunities")
