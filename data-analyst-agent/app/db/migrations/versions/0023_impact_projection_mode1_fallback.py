"""ROI Estimation Engine Mode-1 fallback (Phase 2 plan Stage 5 fix) — adds
mode/projected_metric_unit_delta/metric_unit to impact_projection_runs so a
client without client_business_values configured still gets a real metric-
unit delta instead of a hard 'not-configured' stop. See
app/scoring/impact_projection.py.

Revision ID: 0023
Revises: 0022
Create Date: 2026-08-03

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "0023"
down_revision: Union[str, None] = "0022"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("impact_projection_runs", sa.Column("mode", sa.Text, nullable=True))
    op.add_column("impact_projection_runs", sa.Column("projected_metric_unit_delta", sa.Numeric, nullable=True))
    op.add_column("impact_projection_runs", sa.Column("metric_unit", sa.Text, nullable=True))
    op.create_check_constraint(
        "impact_projection_runs_mode_check", "impact_projection_runs", "mode IS NULL OR mode IN ('metric_unit','currency')",
    )


def downgrade() -> None:
    op.drop_constraint("impact_projection_runs_mode_check", "impact_projection_runs", type_="check")
    op.drop_column("impact_projection_runs", "metric_unit")
    op.drop_column("impact_projection_runs", "projected_metric_unit_delta")
    op.drop_column("impact_projection_runs", "mode")
