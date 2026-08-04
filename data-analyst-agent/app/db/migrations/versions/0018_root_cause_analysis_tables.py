"""Phase 2 Stage 2 — root_cause_analysis_runs + root_cause_analysis_nodes.
Mirrors the forecast_runs/forecast_points parent/child split, plus a
self-referencing parent_node_id on the child table for the shallow (depth
0-2) tree RCA v1 produces. See app/intelligence/root_cause.py.

Revision ID: 0018
Revises: 0017
Create Date: 2026-08-02

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "0018"
down_revision: Union[str, None] = "0017"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "root_cause_analysis_runs",
        sa.Column("id", sa.BigInteger, primary_key=True, autoincrement=True),
        sa.Column("client_id", sa.Integer, sa.ForeignKey("clients.id", ondelete="CASCADE"), nullable=False),
        sa.Column("insight_id", sa.BigInteger, sa.ForeignKey("insights.id", ondelete="CASCADE"), nullable=False),
        sa.Column("method", sa.Text, nullable=False),
        sa.Column("status", sa.Text, nullable=False, server_default="ok"),
        sa.Column("error", sa.Text, nullable=True),
        sa.Column("max_depth_reached", sa.Integer, nullable=False, server_default="0"),
        sa.Column("confidence_score_id", sa.BigInteger, sa.ForeignKey("confidence_scores.id"), nullable=True),
        sa.Column("confidence", sa.Numeric, nullable=True),
        sa.Column("generated_at", sa.TIMESTAMP(timezone=True), server_default=sa.text("now()")),
        sa.CheckConstraint("method IN ('independent_dimension_share','combined_query')", name="root_cause_analysis_runs_method_check"),
        sa.CheckConstraint("status IN ('ok','insufficient-data','error')", name="root_cause_analysis_runs_status_check"),
    )
    op.create_index(
        "idx_root_cause_analysis_runs_lookup", "root_cause_analysis_runs", ["client_id", "insight_id"],
    )

    op.create_table(
        "root_cause_analysis_nodes",
        sa.Column("id", sa.BigInteger, primary_key=True, autoincrement=True),
        sa.Column("run_id", sa.BigInteger, sa.ForeignKey("root_cause_analysis_runs.id", ondelete="CASCADE"), nullable=False),
        sa.Column("parent_node_id", sa.BigInteger, sa.ForeignKey("root_cause_analysis_nodes.id", ondelete="CASCADE"), nullable=True),
        sa.Column("depth", sa.Integer, nullable=False),
        sa.Column("dimension_type", sa.Text, nullable=False),
        sa.Column("dimension_value", sa.Text, nullable=False),
        sa.Column("current_value", sa.Numeric, nullable=True),
        sa.Column("prior_value", sa.Numeric, nullable=True),
        sa.Column("abs_change", sa.Numeric, nullable=True),
        sa.Column("pct_change", sa.Numeric, nullable=True),
        sa.Column("share_of_baseline_change_pct", sa.Numeric, nullable=True),
    )
    op.create_index("idx_root_cause_analysis_nodes_run", "root_cause_analysis_nodes", ["run_id"])


def downgrade() -> None:
    op.drop_index("idx_root_cause_analysis_nodes_run", table_name="root_cause_analysis_nodes")
    op.drop_table("root_cause_analysis_nodes")
    op.drop_index("idx_root_cause_analysis_runs_lookup", table_name="root_cause_analysis_runs")
    op.drop_table("root_cause_analysis_runs")
