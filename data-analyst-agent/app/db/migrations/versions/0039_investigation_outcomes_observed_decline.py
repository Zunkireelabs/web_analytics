"""Extends investigation_outcomes (0034) beyond forecast_risk investigations.

Phase 4's prediction -> outcome -> learning loop was scoped to forecast_risk
only, because that is the one insight_type with a real "prediction" to check
(a specific future date + projected value, captured in forecast_outlook).
trend_shift/anomaly/milestone investigations have no such prediction — they
observe a decline that already happened — so evaluating their outcome asks a
different, still-honest question: did the metric recover after a human
approved the investigation, or keep declining? See
app/investigations/outcome.py's _evaluate_observed_decline_one.

predicted_value/pct_projected_change have no honest value for this new path
(there was no prediction to compare against), so both become nullable rather
than writing a fabricated number into a NOT NULL column. Existing
forecast_risk rows are unaffected — they keep writing both columns exactly as
before.

Revision ID: 0039
Revises: 0038
Create Date: 2026-08-24

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "0039"
down_revision: Union[str, None] = "0038"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.alter_column("investigation_outcomes", "predicted_value", existing_type=sa.Numeric, nullable=True)
    op.alter_column("investigation_outcomes", "pct_projected_change", existing_type=sa.Numeric, nullable=True)
    op.drop_constraint("investigation_outcomes_status_check", "investigation_outcomes", type_="check")
    op.create_check_constraint(
        "investigation_outcomes_status_check", "investigation_outcomes",
        "outcome_status IN ('no_decline_occurred','decline_smaller_than_predicted','decline_as_predicted_or_worse',"
        "'improved','unchanged','worsened')",
    )


def downgrade() -> None:
    op.drop_constraint("investigation_outcomes_status_check", "investigation_outcomes", type_="check")
    op.create_check_constraint(
        "investigation_outcomes_status_check", "investigation_outcomes",
        "outcome_status IN ('no_decline_occurred','decline_smaller_than_predicted','decline_as_predicted_or_worse')",
    )
    op.alter_column("investigation_outcomes", "pct_projected_change", existing_type=sa.Numeric, nullable=False)
    op.alter_column("investigation_outcomes", "predicted_value", existing_type=sa.Numeric, nullable=False)
