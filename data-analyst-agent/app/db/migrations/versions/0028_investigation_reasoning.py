"""Phase 3 — five persisted reasoning fields on investigations. See
app/investigations/reasoning.py.

Revision ID: 0028
Revises: 0027
Create Date: 2026-08-04

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB

revision: str = "0028"
down_revision: Union[str, None] = "0027"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("investigations", sa.Column("executive_summary", sa.Text, nullable=True))
    op.add_column("investigations", sa.Column("technical_summary", sa.Text, nullable=True))
    op.add_column("investigations", sa.Column("business_summary", sa.Text, nullable=True))
    op.add_column("investigations", sa.Column("risk_assessment", sa.Text, nullable=True))
    op.add_column("investigations", sa.Column("missing_evidence", JSONB, nullable=True))


def downgrade() -> None:
    op.drop_column("investigations", "missing_evidence")
    op.drop_column("investigations", "risk_assessment")
    op.drop_column("investigations", "business_summary")
    op.drop_column("investigations", "technical_summary")
    op.drop_column("investigations", "executive_summary")
