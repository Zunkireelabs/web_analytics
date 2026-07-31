"""Phase 6 — clients.industry column. A genuine schema addition (no existing
column represents this): cross-client benchmarking/industry-trends need a
vertical to group by. No fixed enum — a controlled taxonomy is a product/
sales decision, not an engineering one; nullable, populated at onboarding
(scripts/onboard_client.py --industry) or backfilled later. See
app/api/routes/benchmarks.py.

Revision ID: 0008
Revises: 0007
Create Date: 2026-07-31

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "0008"
down_revision: Union[str, None] = "0007"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("clients", sa.Column("industry", sa.Text, nullable=True))
    op.create_index("idx_clients_industry", "clients", ["industry"])


def downgrade() -> None:
    op.drop_index("idx_clients_industry", table_name="clients")
    op.drop_column("clients", "industry")
