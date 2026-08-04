"""Phase 2 Stage 3 — forecast confidence + impact projection. Extends
confidence_scores' subject_type CHECK constraint with 'forecast_confidence'
(a new confidence subject that didn't exist when migration 0012 wrote that
list up front); adds confidence_score_id/confidence columns to forecast_runs,
mirroring RootCauseAnalysisRun/FeatureImportanceRun's existing pattern; and
creates impact_projection_runs, the first real table for the 'impact_
prediction' subject_type migration 0012 already forward-declared. Persisted
(not computed purely in-memory) since this produces a client-facing dollar
figure worth an audit trail, and gives compute_confidence a real subject_id
to point at. See app/scoring/impact_projection.py.

Revision ID: 0019
Revises: 0018
Create Date: 2026-08-02

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB

revision: str = "0019"
down_revision: Union[str, None] = "0018"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Postgres CHECK constraints have no ALTER — drop and recreate with the
    # added value, same idiom migration 0012 itself documents as forward-
    # declared-but-incomplete.
    op.drop_constraint("confidence_scores_subject_type_check", "confidence_scores", type_="check")
    op.create_check_constraint(
        "confidence_scores_subject_type_check",
        "confidence_scores",
        "subject_type IN ('feature_importance','root_cause_analysis','opportunity_score',"
        "'roi_estimation','effort_estimation','impact_prediction','recommendation_ranking',"
        "'forecast_confidence')",
    )

    op.add_column("forecast_runs", sa.Column("confidence_score_id", sa.BigInteger, sa.ForeignKey("confidence_scores.id"), nullable=True))
    op.add_column("forecast_runs", sa.Column("confidence", sa.Numeric, nullable=True))

    op.create_table(
        "impact_projection_runs",
        sa.Column("id", sa.BigInteger, primary_key=True, autoincrement=True),
        sa.Column("client_id", sa.Integer, sa.ForeignKey("clients.id", ondelete="CASCADE"), nullable=False),
        sa.Column("metric_key", sa.Text, sa.ForeignKey("metrics_catalog.metric_key"), nullable=False),
        sa.Column("dimension_type", sa.Text, nullable=False, server_default="site"),
        sa.Column("dimension_value", sa.Text, nullable=False, server_default="__site__"),
        sa.Column("delta_value", sa.Numeric, nullable=False),
        sa.Column("delta_direction", sa.Text, nullable=False),
        sa.Column("status", sa.Text, nullable=False),
        sa.Column("projected_dollar_delta", sa.Numeric, nullable=True),
        sa.Column("currency", sa.Text, nullable=True),
        sa.Column("method_detail", JSONB, nullable=False),
        sa.Column("confidence_score_id", sa.BigInteger, sa.ForeignKey("confidence_scores.id"), nullable=True),
        sa.Column("confidence", sa.Numeric, nullable=True),
        sa.Column("generated_at", sa.TIMESTAMP(timezone=True), server_default=sa.text("now()")),
        sa.CheckConstraint("delta_direction IN ('decline','increase')", name="impact_projection_runs_direction_check"),
        sa.CheckConstraint(
            "status IN ('ok','not-configured','not-computable','insufficient-data')",
            name="impact_projection_runs_status_check",
        ),
    )
    op.create_index(
        "idx_impact_projection_runs_lookup", "impact_projection_runs",
        ["client_id", "metric_key", "dimension_type", "dimension_value", "generated_at"],
    )


def downgrade() -> None:
    op.drop_index("idx_impact_projection_runs_lookup", table_name="impact_projection_runs")
    op.drop_table("impact_projection_runs")
    op.drop_column("forecast_runs", "confidence")
    op.drop_column("forecast_runs", "confidence_score_id")
    op.drop_constraint("confidence_scores_subject_type_check", "confidence_scores", type_="check")
    op.create_check_constraint(
        "confidence_scores_subject_type_check",
        "confidence_scores",
        "subject_type IN ('feature_importance','root_cause_analysis','opportunity_score',"
        "'roi_estimation','effort_estimation','impact_prediction','recommendation_ranking')",
    )
