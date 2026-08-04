"""Add dismissal tracking to recommendations, mirroring 0005's resolution
tracking (resolved_at/resolved_by). 'dismissed' has been a legal status
value since 0001, but no route ever set it or recorded who/when.

Revision ID: 0016
Revises: 0015
Create Date: 2026-08-02

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "0016"
down_revision: Union[str, None] = "0015"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("recommendations", sa.Column("dismissed_at", sa.TIMESTAMP(timezone=True), nullable=True))
    op.add_column("recommendations", sa.Column("dismissed_by", sa.Text, nullable=True))


def downgrade() -> None:
    op.drop_column("recommendations", "dismissed_by")
    op.drop_column("recommendations", "dismissed_at")
