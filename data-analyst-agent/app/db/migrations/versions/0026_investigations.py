"""Phase 3 — investigations, investigation_events, and
recommendations.investigation_id. See app/investigations/engine.py.

Revision ID: 0026
Revises: 0025
Create Date: 2026-08-04

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB

revision: str = "0026"
down_revision: Union[str, None] = "0025"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "investigations",
        sa.Column("id", sa.BigInteger, primary_key=True, autoincrement=True),
        sa.Column("client_id", sa.Integer, sa.ForeignKey("clients.id", ondelete="CASCADE"), nullable=False),
        sa.Column("metric_key", sa.Text, sa.ForeignKey("metrics_catalog.metric_key"), nullable=False),
        sa.Column("dimension_type", sa.Text, nullable=False, server_default="site"),
        sa.Column("dimension_value", sa.Text, nullable=False, server_default="__site__"),
        sa.Column("insight_type", sa.Text, nullable=False),
        sa.Column("severity", sa.Text, nullable=False),
        sa.Column("priority", sa.Text, nullable=True),
        sa.Column("status", sa.Text, nullable=False, server_default="detected"),
        sa.Column("affected_metrics", JSONB, nullable=False),
        sa.Column("summary", sa.Text, nullable=True),
        sa.Column("evidence", JSONB, nullable=False),
        sa.Column("forecast_outlook", JSONB, nullable=True),
        sa.Column("root_cause_text", sa.Text, nullable=True),
        sa.Column("confidence", sa.Numeric, nullable=True),
        sa.Column("owner", sa.Text, nullable=True),
        sa.Column("source_insight_id", sa.BigInteger, sa.ForeignKey("insights.id", ondelete="SET NULL"), nullable=True),
        sa.Column("source_anomaly_id", sa.BigInteger, sa.ForeignKey("anomalies.id", ondelete="SET NULL"), nullable=True),
        sa.Column("created_at", sa.TIMESTAMP(timezone=True), server_default=sa.text("now()")),
        sa.Column("updated_at", sa.TIMESTAMP(timezone=True), server_default=sa.text("now()")),
        sa.CheckConstraint(
            "status IN ('detected','investigating','evidence_collected','recommendation_generated',"
            "'draft_prepared','waiting_human_review','approved','completed','archived')",
            name="investigations_status_check",
        ),
        sa.CheckConstraint("severity IN ('high','medium','low')", name="investigations_severity_check"),
        sa.CheckConstraint("priority IS NULL OR priority IN ('high','medium','low')", name="investigations_priority_check"),
    )
    op.create_index(
        "idx_investigations_open_lookup", "investigations",
        ["client_id", "metric_key", "dimension_type", "dimension_value", "insight_type"],
    )
    op.create_index("idx_investigations_status", "investigations", ["client_id", "status"])

    op.create_table(
        "investigation_events",
        sa.Column("id", sa.BigInteger, primary_key=True, autoincrement=True),
        sa.Column(
            "investigation_id", sa.BigInteger, sa.ForeignKey("investigations.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("from_status", sa.Text, nullable=True),
        sa.Column("to_status", sa.Text, nullable=False),
        sa.Column("actor", sa.Text, nullable=False, server_default="system"),
        sa.Column("detail", JSONB, nullable=True),
        sa.Column("created_at", sa.TIMESTAMP(timezone=True), server_default=sa.text("now()")),
    )
    op.create_index("idx_investigation_events_lookup", "investigation_events", ["investigation_id", "created_at"])

    op.add_column(
        "recommendations",
        sa.Column(
            "investigation_id", sa.BigInteger, sa.ForeignKey("investigations.id", ondelete="SET NULL"),
            nullable=True,
        ),
    )


def downgrade() -> None:
    op.drop_column("recommendations", "investigation_id")
    op.drop_index("idx_investigation_events_lookup", table_name="investigation_events")
    op.drop_table("investigation_events")
    op.drop_index("idx_investigations_status", table_name="investigations")
    op.drop_index("idx_investigations_open_lookup", table_name="investigations")
    op.drop_table("investigations")
