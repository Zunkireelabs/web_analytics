"""Add resolution tracking + root cause text to recommendations

Revision ID: 0005
Revises: 0004
Create Date: 2026-07-31

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "0005"
down_revision: Union[str, None] = "0004"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("analyst_recommendations", sa.Column("root_cause_text", sa.Text, nullable=True))
    op.add_column("analyst_recommendations", sa.Column("resolved_at", sa.TIMESTAMP(timezone=True), nullable=True))
    op.add_column("analyst_recommendations", sa.Column("resolved_by", sa.Text, nullable=True))
    op.drop_constraint("recommendations_status_check", "analyst_recommendations", type_="check")
    op.create_check_constraint(
        "recommendations_status_check", "analyst_recommendations",
        "status IN ('new','acknowledged','dismissed','resolved')",
    )


def downgrade() -> None:
    op.drop_constraint("recommendations_status_check", "analyst_recommendations", type_="check")
    op.create_check_constraint(
        "recommendations_status_check", "analyst_recommendations",
        "status IN ('new','acknowledged','dismissed')",
    )
    op.drop_column("analyst_recommendations", "resolved_by")
    op.drop_column("analyst_recommendations", "resolved_at")
    op.drop_column("analyst_recommendations", "root_cause_text")
