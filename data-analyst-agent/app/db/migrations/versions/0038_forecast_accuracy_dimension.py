"""Add dimension_type/dimension_value to forecast_accuracy so
get_rolling_accuracy (app/forecast/accuracy.py) can be scoped to the same
dimension as the forecast it backs — closing a gap from the dimension-aware
forecast confidence work (app/forecast/confidence.py): that module now
backtests a page/channel/device forecast against its own series via
compute_prediction_error, but historical_forecast_accuracy still averaged
across every dimension the client has ever forecasted for a metric, because
forecast_accuracy had nowhere to record which dimension a row belonged to.

Existing rows predate per-dimension forecasting and were all written for
dimension_type == 'site' runs (see app/forecast/run.py's prior site-only
gate on this scoring path), so they backfill as ('site', '__site__') — the
same site-dimension convention used elsewhere in this schema
(metric_period_stats, page_query_observations use 'page'/'query'; a bare
site-level row elsewhere in this codebase is dimension_value = '__site__').

Revision ID: 0038
Revises: 0037
Create Date: 2026-08-23

"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0038"
down_revision: Union[str, None] = "0037"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "forecast_accuracy",
        sa.Column("dimension_type", sa.Text(), nullable=False, server_default="site"),
    )
    op.add_column(
        "forecast_accuracy",
        sa.Column("dimension_value", sa.Text(), nullable=False, server_default="__site__"),
    )


def downgrade() -> None:
    op.drop_column("forecast_accuracy", "dimension_value")
    op.drop_column("forecast_accuracy", "dimension_type")
