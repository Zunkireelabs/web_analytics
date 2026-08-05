"""Initial platform registry schema + v1 metric catalog seed

Revision ID: 0001
Revises:
Create Date: 2026-07-30

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB

revision: str = "0001"
down_revision: Union[str, None] = None
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "clients",
        sa.Column("id", sa.Integer, primary_key=True, autoincrement=False),
        sa.Column("name", sa.Text, nullable=False),
        sa.Column("status", sa.Text, nullable=False, server_default="active"),
        sa.Column("timezone", sa.Text, nullable=False, server_default="UTC"),
        sa.Column("mcp_token_ciphertext", sa.LargeBinary, nullable=False),
        sa.Column("mcp_token_prefix", sa.Text, nullable=False),
        sa.Column("mcp_permission_level", sa.Text, nullable=False, server_default="read_only"),
        sa.Column("created_at", sa.TIMESTAMP(timezone=True), server_default=sa.text("now()")),
        sa.Column("updated_at", sa.TIMESTAMP(timezone=True), server_default=sa.text("now()")),
        sa.CheckConstraint("status IN ('active','paused','suspended')", name="clients_status_check"),
    )

    op.create_table(
        "metrics_catalog",
        sa.Column("metric_key", sa.Text, primary_key=True),
        sa.Column("display_name", sa.Text, nullable=False),
        sa.Column("category", sa.Text, nullable=False),
        sa.Column("source", sa.Text, nullable=False),
        sa.Column("unit", sa.Text, nullable=False),
        sa.Column("cadence", sa.Text, nullable=False),
        sa.Column("aggregation_strategy", sa.Text, nullable=False),
        sa.Column("weight_metric_key", sa.Text, sa.ForeignKey("metrics_catalog.metric_key"), nullable=True),
        sa.Column("visualization_type", sa.Text, nullable=False, server_default="line"),
        sa.Column("dashboard_group", sa.Text, nullable=True),
        sa.Column("icon", sa.Text, nullable=True),
        sa.Column("is_forecastable", sa.Boolean, nullable=False, server_default=sa.true()),
        sa.Column("supports_anomaly_detection", sa.Boolean, nullable=False, server_default=sa.true()),
        sa.Column("enabled", sa.Boolean, nullable=False, server_default=sa.false()),
        sa.Column("collector_id", sa.Text, nullable=True),
        sa.Column("created_at", sa.TIMESTAMP(timezone=True), server_default=sa.text("now()")),
        sa.CheckConstraint("cadence IN ('daily','weekly','monthly')", name="metrics_catalog_cadence_check"),
        sa.CheckConstraint(
            "aggregation_strategy IN ('sum','weighted_avg','avg','last_value')",
            name="metrics_catalog_aggregation_check",
        ),
        sa.CheckConstraint(
            "enabled = false OR collector_id IS NOT NULL",
            name="metrics_catalog_enabled_requires_collector",
        ),
    )

    op.create_table(
        "metric_dimension_support",
        sa.Column("metric_key", sa.Text, sa.ForeignKey("metrics_catalog.metric_key"), primary_key=True),
        sa.Column("dimension_type", sa.Text, primary_key=True),
        sa.Column("collector_id", sa.Text, nullable=True),
        sa.Column("enabled", sa.Boolean, nullable=False, server_default=sa.false()),
    )

    op.create_table(
        "metric_observations",
        sa.Column("client_id", sa.Integer, sa.ForeignKey("clients.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("metric_key", sa.Text, sa.ForeignKey("metrics_catalog.metric_key"), primary_key=True),
        sa.Column("dimension_type", sa.Text, primary_key=True, server_default="site"),
        sa.Column("dimension_value", sa.Text, primary_key=True, server_default="__site__"),
        sa.Column("period_start", sa.Date, primary_key=True),
        sa.Column("value", sa.Numeric, nullable=True),
    )

    op.create_table(
        "metric_period_stats",
        sa.Column("id", sa.BigInteger, primary_key=True, autoincrement=True),
        sa.Column("client_id", sa.Integer, sa.ForeignKey("clients.id", ondelete="CASCADE"), nullable=False),
        sa.Column("metric_key", sa.Text, sa.ForeignKey("metrics_catalog.metric_key"), nullable=False),
        sa.Column("dimension_type", sa.Text, nullable=False, server_default="site"),
        sa.Column("dimension_value", sa.Text, nullable=False, server_default="__site__"),
        sa.Column("period_type", sa.Text, nullable=False),
        sa.Column("period_end", sa.Date, nullable=False),
        sa.Column("current_value", sa.Numeric, nullable=True),
        sa.Column("prior_value", sa.Numeric, nullable=True),
        sa.Column("abs_change", sa.Numeric, nullable=True),
        sa.Column("pct_change", sa.Numeric, nullable=True),
        sa.Column("created_at", sa.TIMESTAMP(timezone=True), server_default=sa.text("now()")),
        sa.CheckConstraint("period_type IN ('wow','mom')", name="metric_period_stats_type_check"),
        sa.UniqueConstraint(
            "client_id", "metric_key", "dimension_type", "dimension_value", "period_type", "period_end",
            name="metric_period_stats_unique",
        ),
    )

    op.create_table(
        "anomalies",
        sa.Column("id", sa.BigInteger, primary_key=True, autoincrement=True),
        sa.Column("client_id", sa.Integer, sa.ForeignKey("clients.id", ondelete="CASCADE"), nullable=False),
        sa.Column("metric_key", sa.Text, sa.ForeignKey("metrics_catalog.metric_key"), nullable=False),
        sa.Column("dimension_type", sa.Text, nullable=False, server_default="site"),
        sa.Column("dimension_value", sa.Text, nullable=False, server_default="__site__"),
        sa.Column("period_start", sa.Date, nullable=False),
        sa.Column("value", sa.Numeric, nullable=True),
        sa.Column("method", sa.Text, nullable=False),
        sa.Column("score", sa.Numeric, nullable=True),
        sa.Column("threshold_used", sa.Numeric, nullable=True),
        sa.Column("direction", sa.Text, nullable=False),
        sa.Column("created_at", sa.TIMESTAMP(timezone=True), server_default=sa.text("now()")),
        sa.CheckConstraint("method IN ('zscore','iqr')", name="anomalies_method_check"),
        sa.CheckConstraint("direction IN ('high','low')", name="anomalies_direction_check"),
        sa.UniqueConstraint(
            "client_id", "metric_key", "dimension_type", "dimension_value", "period_start", "method",
            name="anomalies_unique",
        ),
    )

    op.create_table(
        "forecast_runs",
        sa.Column("id", sa.BigInteger, primary_key=True, autoincrement=True),
        sa.Column("client_id", sa.Integer, sa.ForeignKey("clients.id", ondelete="CASCADE"), nullable=False),
        sa.Column("metric_key", sa.Text, sa.ForeignKey("metrics_catalog.metric_key"), nullable=False),
        sa.Column("dimension_type", sa.Text, nullable=False, server_default="site"),
        sa.Column("dimension_value", sa.Text, nullable=False, server_default="__site__"),
        sa.Column("cadence", sa.Text, nullable=False),
        sa.Column("model", sa.Text, nullable=False),
        sa.Column("horizon_periods", sa.Integer, nullable=False),
        sa.Column("status", sa.Text, nullable=False, server_default="ok"),
        sa.Column("params", JSONB, nullable=True),
        sa.Column("error", sa.Text, nullable=True),
        sa.Column("generated_at", sa.TIMESTAMP(timezone=True), server_default=sa.text("now()")),
        sa.CheckConstraint("cadence IN ('daily','weekly','monthly')", name="forecast_runs_cadence_check"),
        sa.CheckConstraint("status IN ('ok','insufficient-data','error')", name="forecast_runs_status_check"),
    )
    op.create_index(
        "idx_forecast_runs_lookup", "forecast_runs",
        ["client_id", "metric_key", "dimension_type", "dimension_value", "generated_at"],
    )

    op.create_table(
        "forecast_points",
        sa.Column("id", sa.BigInteger, primary_key=True, autoincrement=True),
        sa.Column("forecast_run_id", sa.BigInteger, sa.ForeignKey("forecast_runs.id", ondelete="CASCADE"), nullable=False),
        sa.Column("target_period", sa.Date, nullable=False),
        sa.Column("point_estimate", sa.Numeric, nullable=True),
        sa.Column("lower_bound", sa.Numeric, nullable=True),
        sa.Column("upper_bound", sa.Numeric, nullable=True),
        sa.UniqueConstraint("forecast_run_id", "target_period", name="forecast_points_unique"),
    )

    op.create_table(
        "insights",
        sa.Column("id", sa.BigInteger, primary_key=True, autoincrement=True),
        sa.Column("client_id", sa.Integer, sa.ForeignKey("clients.id", ondelete="CASCADE"), nullable=False),
        sa.Column("metric_key", sa.Text, sa.ForeignKey("metrics_catalog.metric_key"), nullable=False),
        sa.Column("dimension_type", sa.Text, nullable=False, server_default="site"),
        sa.Column("dimension_value", sa.Text, nullable=False, server_default="__site__"),
        sa.Column("period_start", sa.Date, nullable=False),
        sa.Column("insight_type", sa.Text, nullable=False),
        sa.Column("severity", sa.Text, nullable=False),
        sa.Column("evidence", JSONB, nullable=False),
        sa.Column("generated_at", sa.TIMESTAMP(timezone=True), server_default=sa.text("now()")),
        sa.CheckConstraint(
            "insight_type IN ('anomaly','trend_shift','forecast_risk','milestone')",
            name="insights_type_check",
        ),
        sa.CheckConstraint("severity IN ('high','medium','low')", name="insights_severity_check"),
    )
    op.create_index("idx_insights_lookup", "insights", ["client_id", "metric_key", "generated_at"])

    op.create_table(
        "analyst_recommendations",
        sa.Column("id", sa.BigInteger, primary_key=True, autoincrement=True),
        sa.Column("client_id", sa.Integer, sa.ForeignKey("clients.id", ondelete="CASCADE"), nullable=False),
        sa.Column("insight_id", sa.BigInteger, sa.ForeignKey("insights.id", ondelete="CASCADE"), nullable=False),
        sa.Column("priority", sa.Text, nullable=False),
        sa.Column("recommendation_text", sa.Text, nullable=False),
        sa.Column("status", sa.Text, nullable=False, server_default="new"),
        sa.Column("generated_at", sa.TIMESTAMP(timezone=True), server_default=sa.text("now()")),
        sa.CheckConstraint("priority IN ('high','medium','low')", name="recommendations_priority_check"),
        sa.CheckConstraint("status IN ('new','acknowledged','dismissed')", name="recommendations_status_check"),
    )

    op.create_table(
        "ingestion_runs",
        sa.Column("id", sa.BigInteger, primary_key=True, autoincrement=True),
        sa.Column("client_id", sa.Integer, sa.ForeignKey("clients.id", ondelete="CASCADE"), nullable=False),
        sa.Column("collector_id", sa.Text, nullable=False),
        sa.Column("run_date", sa.Date, nullable=False),
        sa.Column("status", sa.Text, nullable=False),
        sa.Column("error", sa.Text, nullable=True),
        sa.Column("took_ms", sa.Integer, nullable=True),
        sa.Column("created_at", sa.TIMESTAMP(timezone=True), server_default=sa.text("now()")),
        sa.CheckConstraint("status IN ('ok','insufficient-data','error')", name="ingestion_runs_status_check"),
    )
    op.create_index("idx_ingestion_runs_lookup", "ingestion_runs", ["client_id", "collector_id", "created_at"])

    _seed_metrics_catalog()


def _seed_metrics_catalog() -> None:
    metrics_catalog = sa.table(
        "metrics_catalog",
        sa.column("metric_key", sa.Text), sa.column("display_name", sa.Text),
        sa.column("category", sa.Text), sa.column("source", sa.Text), sa.column("unit", sa.Text),
        sa.column("cadence", sa.Text), sa.column("aggregation_strategy", sa.Text),
        sa.column("weight_metric_key", sa.Text), sa.column("visualization_type", sa.Text),
        sa.column("dashboard_group", sa.Text), sa.column("is_forecastable", sa.Boolean),
        sa.column("supports_anomaly_detection", sa.Boolean), sa.column("enabled", sa.Boolean),
        sa.column("collector_id", sa.Text),
    )
    dim_support = sa.table(
        "metric_dimension_support",
        sa.column("metric_key", sa.Text), sa.column("dimension_type", sa.Text),
        sa.column("collector_id", sa.Text), sa.column("enabled", sa.Boolean),
    )

    def row(key, name, category, source, unit, cadence, agg, weight, viz, group,
            enabled, collector, forecastable=True, anomaly=True):
        return {
            "metric_key": key, "display_name": name, "category": category, "source": source,
            "unit": unit, "cadence": cadence, "aggregation_strategy": agg, "weight_metric_key": weight,
            "visualization_type": viz, "dashboard_group": group, "is_forecastable": forecastable,
            "supports_anomaly_detection": anomaly, "enabled": enabled, "collector_id": collector,
        }

    v1_enabled = [
        row("gsc_clicks", "Clicks", "search", "gsc", "count", "daily", "sum", None, "line", "Search Performance", True, "gsc_daily"),
        row("gsc_impressions", "Impressions", "search", "gsc", "count", "daily", "sum", None, "line", "Search Performance", True, "gsc_daily"),
        row("gsc_ctr", "CTR", "search", "gsc", "ratio", "daily", "weighted_avg", "gsc_impressions", "line", "Search Performance", True, "gsc_daily"),
        row("gsc_position", "Average Position", "search", "gsc", "rank", "daily", "weighted_avg", "gsc_impressions", "line", "Search Performance", True, "gsc_daily"),
        row("ga4_sessions", "Sessions", "engagement", "ga4", "count", "daily", "sum", None, "line", "Engagement", True, "ga4_daily"),
        row("ga4_users", "Users", "engagement", "ga4", "count", "daily", "sum", None, "line", "Engagement", True, "ga4_daily"),
        row("ga4_new_users", "New Users", "engagement", "ga4", "count", "daily", "sum", None, "line", "Engagement", True, "ga4_daily"),
        row("ga4_engaged_sessions", "Engaged Sessions", "engagement", "ga4", "count", "daily", "sum", None, "line", "Engagement", True, "ga4_daily"),
        row("ga4_conversions", "Conversions", "conversion", "ga4", "count", "daily", "sum", None, "line", "Conversions", True, "ga4_daily"),
        row("ga4_avg_engagement_time", "Avg Engagement Time", "engagement", "ga4", "seconds", "daily", "avg", None, "line", "Engagement", True, "ga4_daily"),
        row("ga4_bounce_rate", "Bounce Rate", "engagement", "ga4", "ratio", "daily", "weighted_avg", "ga4_sessions", "line", "Engagement", True, "ga4_daily"),
        row("health_score", "Website Health Score", "health", "derived_external", "score_0_100", "daily", "last_value", None, "gauge", "Health & Authority", True, "health_score"),
        row("engagement_rate", "Engagement Rate", "engagement", "derived_internal", "ratio", "daily", "weighted_avg", "ga4_sessions", "line", "Engagement", True, "derived_ratios"),
        row("conversion_rate", "Conversion Rate", "conversion", "derived_internal", "ratio", "daily", "weighted_avg", "ga4_sessions", "line", "Conversions", True, "derived_ratios"),
    ]

    future_disabled = [
        row("ai_visibility_score", "AI Visibility Score", "ai", "agent:ai-visibility", "score_0_100", "daily", "last_value", None, "gauge", "AI Visibility", False, None),
        row("ai_recommendation_rate", "AI Recommendation Rate", "ai", "agent:ai-recommendation", "ratio", "monthly", "last_value", None, "gauge", "AI Visibility", False, None),
        row("authority_score", "Authority Score", "authority", "agent:authority", "score_0_100", "monthly", "last_value", None, "gauge", "Health & Authority", False, None),
        row("backlinks", "Total Backlinks", "authority", "agent:authority", "count", "monthly", "last_value", None, "line", "Health & Authority", False, None),
        row("referring_domains", "Referring Domains", "authority", "agent:authority", "count", "monthly", "last_value", None, "line", "Health & Authority", False, None),
        row("competitor_structural_score", "Competitor Structural Score", "competitor", "agent:competitor-intelligence", "score_0_100", "monthly", "last_value", None, "line", "Competitors", False, None),
        row("query_count", "Organic Keyword Count", "search", "derived_internal", "count", "daily", "last_value", None, "number", "Search Performance", False, None),
    ]

    op.bulk_insert(metrics_catalog, v1_enabled + future_disabled)

    dim_rows = []
    for m in v1_enabled:
        dim_rows.append({"metric_key": m["metric_key"], "dimension_type": "site", "collector_id": m["collector_id"], "enabled": True})
    for m in future_disabled:
        dim_rows.append({"metric_key": m["metric_key"], "dimension_type": "site", "collector_id": None, "enabled": False})

    for key in ("gsc_clicks", "gsc_impressions", "gsc_ctr", "gsc_position"):
        for dim in ("device", "country", "page", "query"):
            dim_rows.append({"metric_key": key, "dimension_type": dim, "collector_id": None, "enabled": False})
    for key in ("ga4_sessions", "ga4_users"):
        dim_rows.append({"metric_key": key, "dimension_type": "channel", "collector_id": None, "enabled": False})
    dim_rows.append({"metric_key": "competitor_structural_score", "dimension_type": "competitor_domain", "collector_id": None, "enabled": False})

    op.bulk_insert(dim_support, dim_rows)


def downgrade() -> None:
    op.drop_table("ingestion_runs")
    op.drop_table("analyst_recommendations")
    op.drop_table("insights")
    op.drop_table("forecast_points")
    op.drop_table("forecast_runs")
    op.drop_table("anomalies")
    op.drop_table("metric_period_stats")
    op.drop_table("metric_observations")
    op.drop_table("metric_dimension_support")
    op.drop_table("metrics_catalog")
    op.drop_table("clients")
