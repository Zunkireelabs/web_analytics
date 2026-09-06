"""Phase 4 (prediction -> outcome -> learning loop) — investigation_outcomes.
See app/investigations/outcome.py. Distinct from forecast_accuracy (0029):
that table tracks raw forecast-point accuracy for every forecast, acted on
or not; this one tracks the outcome specifically for a forecast_risk
Investigation a human approved and (presumably) acted on, so it answers
"did the fix work", not just "was the forecast accurate".

Revision ID: 0034
Revises: 0033
Create Date: 2026-08-11

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "0034"
down_revision: Union[str, None] = "0033"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "investigation_outcomes",
        sa.Column("id", sa.BigInteger, primary_key=True, autoincrement=True),
        sa.Column("client_id", sa.Integer, sa.ForeignKey("clients.id", ondelete="CASCADE"), nullable=False),
        sa.Column(
            "investigation_id", sa.BigInteger, sa.ForeignKey("investigations.id", ondelete="CASCADE"),
            nullable=False, unique=True,
        ),
        sa.Column("baseline_value", sa.Numeric, nullable=False),
        sa.Column("predicted_value", sa.Numeric, nullable=False),
        sa.Column("actual_value", sa.Numeric, nullable=False),
        sa.Column("pct_projected_change", sa.Numeric, nullable=False),
        sa.Column("pct_actual_change", sa.Numeric, nullable=False),
        sa.Column("outcome_status", sa.Text, nullable=False),
        sa.Column("evaluated_at", sa.TIMESTAMP(timezone=True), server_default=sa.text("now()")),
        sa.CheckConstraint(
            "outcome_status IN ('no_decline_occurred','decline_smaller_than_predicted','decline_as_predicted_or_worse')",
            name="investigation_outcomes_status_check",
        ),
    )
    op.create_index("idx_investigation_outcomes_client", "investigation_outcomes", ["client_id", "evaluated_at"])


def downgrade() -> None:
    op.drop_index("idx_investigation_outcomes_client", table_name="investigation_outcomes")
    op.drop_table("investigation_outcomes")
