"""Phase 2 Stage 1 — feature_importance_runs + feature_importance_scores.
Mirrors the forecast_runs/forecast_points split: one parent row per nightly
(client, target metric) run, with per-feature child rows. See
app/ml/feature_importance.py.

Revision ID: 0015
Revises: 0014
Create Date: 2026-08-02

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "0015"
down_revision: Union[str, None] = "0014"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "feature_importance_runs",
        sa.Column("id", sa.BigInteger, primary_key=True, autoincrement=True),
        sa.Column("client_id", sa.Integer, sa.ForeignKey("clients.id", ondelete="CASCADE"), nullable=False),
        sa.Column("target_metric_key", sa.Text, sa.ForeignKey("metrics_catalog.metric_key"), nullable=False),
        sa.Column("method", sa.Text, nullable=False),
        sa.Column("model_type", sa.Text, nullable=False),
        sa.Column("n_observations", sa.Integer, nullable=False),
        sa.Column("model_score", sa.Numeric, nullable=True),
        sa.Column("status", sa.Text, nullable=False, server_default="ok"),
        sa.Column("error", sa.Text, nullable=True),
        sa.Column("confidence_score_id", sa.BigInteger, sa.ForeignKey("confidence_scores.id"), nullable=True),
        sa.Column("confidence", sa.Numeric, nullable=True),
        sa.Column("generated_at", sa.TIMESTAMP(timezone=True), server_default=sa.text("now()")),
        sa.CheckConstraint("method IN ('permutation_importance','shap')", name="feature_importance_runs_method_check"),
        sa.CheckConstraint("status IN ('ok','insufficient-data','error')", name="feature_importance_runs_status_check"),
    )
    op.create_index(
        "idx_feature_importance_runs_lookup", "feature_importance_runs", ["client_id", "target_metric_key", "generated_at"],
    )

    op.create_table(
        "feature_importance_scores",
        sa.Column("id", sa.BigInteger, primary_key=True, autoincrement=True),
        sa.Column("run_id", sa.BigInteger, sa.ForeignKey("feature_importance_runs.id", ondelete="CASCADE"), nullable=False),
        sa.Column("feature_metric_key", sa.Text, sa.ForeignKey("metrics_catalog.metric_key"), nullable=False),
        sa.Column("importance_pct", sa.Numeric, nullable=False),
        sa.Column("importance_raw", sa.Numeric, nullable=False),
        sa.Column("rank", sa.Integer, nullable=False),
        sa.UniqueConstraint("run_id", "feature_metric_key", name="feature_importance_scores_unique"),
    )


def downgrade() -> None:
    op.drop_table("feature_importance_scores")
    op.drop_index("idx_feature_importance_runs_lookup", table_name="feature_importance_runs")
    op.drop_table("feature_importance_runs")
