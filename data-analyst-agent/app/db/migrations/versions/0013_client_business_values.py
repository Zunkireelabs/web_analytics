"""Phase 2 Stage 0 — client_business_values. Per-client monetary inputs
(conversion value, AOV, lead value, revenue per conversion) gating ROI
Estimation Mode 2 (a later Phase 2 stage). All nullable — no row, or an
all-null row, is the explicit "Mode 2 not configured" signal; ROI falls back
to Mode 1's metric-unit-only estimate. Backend-only for now: set via
scripts/set_business_values.py, no settings UI yet.

Revision ID: 0013
Revises: 0012
Create Date: 2026-08-02

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "0013"
down_revision: Union[str, None] = "0012"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "client_business_values",
        sa.Column("client_id", sa.Integer, sa.ForeignKey("clients.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("conversion_value", sa.Numeric, nullable=True),
        sa.Column("avg_order_value", sa.Numeric, nullable=True),
        sa.Column("lead_value", sa.Numeric, nullable=True),
        sa.Column("revenue_per_conversion", sa.Numeric, nullable=True),
        sa.Column("currency", sa.Text, nullable=False, server_default="USD"),
        sa.Column("updated_at", sa.TIMESTAMP(timezone=True), server_default=sa.text("now()")),
    )


def downgrade() -> None:
    op.drop_table("client_business_values")
