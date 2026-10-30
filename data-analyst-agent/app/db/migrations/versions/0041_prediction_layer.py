"""Next-week prediction layer: the prediction log, predicted page issues, keyword growth
predictions, and the trained-model registry (pooled across clients on anonymous features).

Additive only: four new tables, nothing existing is altered.

prediction_log is the honest-accuracy record: every forecast is stored with its target week,
then the nightly pass fills in `actual` and `abs_pct_error` when that week has fully landed,
so "last predictions were within X%" is measured, never asserted.

prediction_models.artifact holds a pickled scikit-learn model trained ONLY on anonymous feature
rows (numbers; no domain, page, query text or client id), which is what lets one model learn from
every project without any project's data being readable from another's.

Revision ID: 0041
Revises: 0040
Create Date: 2026-10-27
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0041"
down_revision: Union[str, None] = "0040"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "prediction_log",
        sa.Column("id", sa.BigInteger, primary_key=True, autoincrement=True),
        sa.Column("client_id", sa.Integer, sa.ForeignKey("clients.id", ondelete="CASCADE"), nullable=False),
        sa.Column("metric_key", sa.Text, nullable=False),
        sa.Column("target_week", sa.Date, nullable=False),
        sa.Column("horizon", sa.Integer, nullable=False),
        sa.Column("predicted", sa.Numeric, nullable=False),
        sa.Column("low", sa.Numeric),
        sa.Column("high", sa.Numeric),
        sa.Column("model", sa.Text, nullable=False),
        sa.Column("made_on", sa.Date, nullable=False),
        sa.Column("actual", sa.Numeric),
        sa.Column("abs_pct_error", sa.Numeric),
        sa.Column("resolved_at", sa.DateTime(timezone=True)),
        sa.UniqueConstraint("client_id", "metric_key", "target_week", "horizon", "made_on", name="prediction_log_unique"),
    )
    op.create_index("idx_prediction_log_lookup", "prediction_log", ["client_id", "metric_key", "target_week"])

    op.create_table(
        "predicted_issues",
        sa.Column("id", sa.BigInteger, primary_key=True, autoincrement=True),
        sa.Column("client_id", sa.Integer, sa.ForeignKey("clients.id", ondelete="CASCADE"), nullable=False),
        sa.Column("kind", sa.Text, nullable=False),
        sa.Column("page", sa.Text, nullable=False),
        sa.Column("target_week", sa.Date, nullable=False),
        sa.Column("likelihood", sa.Numeric, nullable=False),
        sa.Column("expected_loss_clicks", sa.Numeric),
        sa.Column("reason", sa.Text, nullable=False),
        sa.Column("model", sa.Text, nullable=False),
        sa.Column("evidence", postgresql.JSONB),
        sa.Column("insight_id", sa.BigInteger, sa.ForeignKey("insights.id", ondelete="SET NULL")),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.Column("outcome", sa.Text),   # 'happened' | 'did_not_happen' once the week has landed
        sa.UniqueConstraint("client_id", "kind", "page", "target_week", name="predicted_issues_unique"),
    )

    op.create_table(
        "keyword_predictions",
        sa.Column("id", sa.BigInteger, primary_key=True, autoincrement=True),
        sa.Column("client_id", sa.Integer, sa.ForeignKey("clients.id", ondelete="CASCADE"), nullable=False),
        sa.Column("keyword", sa.Text, nullable=False),
        sa.Column("target_week", sa.Date, nullable=False),
        sa.Column("position", sa.Numeric, nullable=False),
        sa.Column("gain_clicks", sa.Integer, nullable=False),
        sa.Column("likelihood", sa.Numeric, nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.UniqueConstraint("client_id", "keyword", "target_week", name="keyword_predictions_unique"),
    )

    op.create_table(
        "prediction_models",
        sa.Column("id", sa.BigInteger, primary_key=True, autoincrement=True),
        sa.Column("task", sa.Text, nullable=False),           # 'page_decline'
        sa.Column("scope", sa.Text, nullable=False),          # 'pooled'
        sa.Column("champion", sa.Text, nullable=False),       # 'baseline' | 'gradient_boosting' | 'neural_network'
        sa.Column("metrics", postgresql.JSONB),
        sa.Column("artifact", sa.LargeBinary),                # null when the baseline is champion
        sa.Column("samples", sa.Integer, nullable=False),
        sa.Column("projects", sa.Integer, nullable=False),
        sa.Column("trained_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.Column("active", sa.Boolean, nullable=False, server_default=sa.true()),
    )
    op.create_index("idx_prediction_models_active", "prediction_models", ["task", "scope", "active", "trained_at"])


def downgrade() -> None:
    op.drop_index("idx_prediction_models_active", table_name="prediction_models")
    op.drop_table("prediction_models")
    op.drop_table("keyword_predictions")
    op.drop_table("predicted_issues")
    op.drop_index("idx_prediction_log_lookup", table_name="prediction_log")
    op.drop_table("prediction_log")
