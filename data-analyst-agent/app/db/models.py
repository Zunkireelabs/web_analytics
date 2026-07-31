from datetime import datetime, date
from sqlalchemy import (
    BigInteger, Boolean, CheckConstraint, Date, DateTime, ForeignKey, Numeric, String,
    Text, UniqueConstraint, LargeBinary, Index, func,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column


class Base(DeclarativeBase):
    pass


class Client(Base):
    __tablename__ = "clients"

    # Deliberately NOT autoincrementing — must equal the Node app's sites.id
    # (shared key by convention; no cross-DB FK is possible).
    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=False)
    name: Mapped[str] = mapped_column(Text, nullable=False)
    status: Mapped[str] = mapped_column(Text, nullable=False, default="active")
    timezone: Mapped[str] = mapped_column(Text, nullable=False, default="UTC")
    mcp_token_ciphertext: Mapped[bytes] = mapped_column(LargeBinary, nullable=False)
    mcp_token_prefix: Mapped[str] = mapped_column(Text, nullable=False)
    mcp_permission_level: Mapped[str] = mapped_column(Text, nullable=False, default="read_only")
    # No fixed enum — controlled vocabulary is a product/sales decision, not
    # an engineering one. Populated at onboarding or backfilled later; null
    # until then (see scripts/onboard_client.py --industry).
    industry: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(server_default=func.now())

    __table_args__ = (
        CheckConstraint("status IN ('active','paused','suspended')", name="clients_status_check"),
    )


class MetricCatalog(Base):
    __tablename__ = "metrics_catalog"

    metric_key: Mapped[str] = mapped_column(Text, primary_key=True)
    display_name: Mapped[str] = mapped_column(Text, nullable=False)
    category: Mapped[str] = mapped_column(Text, nullable=False)
    source: Mapped[str] = mapped_column(Text, nullable=False)
    unit: Mapped[str] = mapped_column(Text, nullable=False)
    cadence: Mapped[str] = mapped_column(Text, nullable=False)
    aggregation_strategy: Mapped[str] = mapped_column(Text, nullable=False)
    # Only meaningful when aggregation_strategy='weighted_avg' — the metric_key whose
    # per-period SUM is the weighting denominator (e.g. gsc_position weighted by
    # gsc_impressions: SUM(position*impressions)/SUM(impressions), never a raw AVG()).
    weight_metric_key: Mapped[str | None] = mapped_column(ForeignKey("metrics_catalog.metric_key"), nullable=True)
    visualization_type: Mapped[str] = mapped_column(Text, nullable=False, default="line")
    dashboard_group: Mapped[str | None] = mapped_column(Text, nullable=True)
    icon: Mapped[str | None] = mapped_column(Text, nullable=True)
    is_forecastable: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    supports_anomaly_detection: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    collector_id: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(server_default=func.now())

    __table_args__ = (
        CheckConstraint("cadence IN ('daily','weekly','monthly')", name="metrics_catalog_cadence_check"),
        CheckConstraint(
            "aggregation_strategy IN ('sum','weighted_avg','avg','last_value')",
            name="metrics_catalog_aggregation_check",
        ),
        CheckConstraint(
            "enabled = false OR collector_id IS NOT NULL",
            name="metrics_catalog_enabled_requires_collector",
        ),
    )


class MetricDimensionSupport(Base):
    __tablename__ = "metric_dimension_support"

    metric_key: Mapped[str] = mapped_column(ForeignKey("metrics_catalog.metric_key"), primary_key=True)
    dimension_type: Mapped[str] = mapped_column(Text, primary_key=True)
    collector_id: Mapped[str | None] = mapped_column(Text, nullable=True)
    enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)


class MetricObservation(Base):
    __tablename__ = "metric_observations"

    client_id: Mapped[int] = mapped_column(ForeignKey("clients.id", ondelete="CASCADE"), primary_key=True)
    metric_key: Mapped[str] = mapped_column(ForeignKey("metrics_catalog.metric_key"), primary_key=True)
    dimension_type: Mapped[str] = mapped_column(Text, primary_key=True, default="site")
    dimension_value: Mapped[str] = mapped_column(Text, primary_key=True, default="__site__")
    period_start: Mapped[date] = mapped_column(Date, primary_key=True)
    value: Mapped[float | None] = mapped_column(Numeric)


class PageQueryObservation(Base):
    """Deliberately separate from metric_observations — page/query
    cardinality (thousands of distinct URLs/queries per client) makes the
    per-dimension-value loop the stats/anomaly/forecast engines use for
    site/channel/device/country dimensions performance-prohibitive here.
    Top-N per day only (matches the GSC breakdown MCP tool's own cap), not
    every real page/query — read live at request time, never run through
    metric_period_stats/anomalies/forecast_runs. See
    app/collectors/page_query.py."""

    __tablename__ = "page_query_observations"

    client_id: Mapped[int] = mapped_column(ForeignKey("clients.id", ondelete="CASCADE"), primary_key=True)
    dimension_type: Mapped[str] = mapped_column(Text, primary_key=True)
    dimension_value: Mapped[str] = mapped_column(Text, primary_key=True)
    period_start: Mapped[date] = mapped_column(Date, primary_key=True)
    clicks: Mapped[float | None] = mapped_column(Numeric)
    impressions: Mapped[float | None] = mapped_column(Numeric)
    ctr: Mapped[float | None] = mapped_column(Numeric)
    position: Mapped[float | None] = mapped_column(Numeric)

    __table_args__ = (
        CheckConstraint("dimension_type IN ('page','query')", name="page_query_observations_dimension_type_check"),
    )


class MetricPeriodStats(Base):
    __tablename__ = "metric_period_stats"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    client_id: Mapped[int] = mapped_column(ForeignKey("clients.id", ondelete="CASCADE"), nullable=False)
    metric_key: Mapped[str] = mapped_column(ForeignKey("metrics_catalog.metric_key"), nullable=False)
    dimension_type: Mapped[str] = mapped_column(Text, nullable=False, default="site")
    dimension_value: Mapped[str] = mapped_column(Text, nullable=False, default="__site__")
    period_type: Mapped[str] = mapped_column(Text, nullable=False)
    period_end: Mapped[date] = mapped_column(Date, nullable=False)
    current_value: Mapped[float | None] = mapped_column(Numeric)
    prior_value: Mapped[float | None] = mapped_column(Numeric)
    abs_change: Mapped[float | None] = mapped_column(Numeric)
    pct_change: Mapped[float | None] = mapped_column(Numeric)
    created_at: Mapped[datetime] = mapped_column(server_default=func.now())

    __table_args__ = (
        CheckConstraint("period_type IN ('wow','mom')", name="metric_period_stats_type_check"),
        UniqueConstraint(
            "client_id", "metric_key", "dimension_type", "dimension_value", "period_type", "period_end",
            name="metric_period_stats_unique",
        ),
    )


class Anomaly(Base):
    __tablename__ = "anomalies"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    client_id: Mapped[int] = mapped_column(ForeignKey("clients.id", ondelete="CASCADE"), nullable=False)
    metric_key: Mapped[str] = mapped_column(ForeignKey("metrics_catalog.metric_key"), nullable=False)
    dimension_type: Mapped[str] = mapped_column(Text, nullable=False, default="site")
    dimension_value: Mapped[str] = mapped_column(Text, nullable=False, default="__site__")
    period_start: Mapped[date] = mapped_column(Date, nullable=False)
    value: Mapped[float | None] = mapped_column(Numeric)
    method: Mapped[str] = mapped_column(Text, nullable=False)
    score: Mapped[float | None] = mapped_column(Numeric)
    threshold_used: Mapped[float | None] = mapped_column(Numeric)
    direction: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[datetime] = mapped_column(server_default=func.now())

    __table_args__ = (
        CheckConstraint("method IN ('zscore','iqr')", name="anomalies_method_check"),
        CheckConstraint("direction IN ('high','low')", name="anomalies_direction_check"),
        UniqueConstraint(
            "client_id", "metric_key", "dimension_type", "dimension_value", "period_start", "method",
            name="anomalies_unique",
        ),
    )


class ForecastRun(Base):
    __tablename__ = "forecast_runs"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    client_id: Mapped[int] = mapped_column(ForeignKey("clients.id", ondelete="CASCADE"), nullable=False)
    metric_key: Mapped[str] = mapped_column(ForeignKey("metrics_catalog.metric_key"), nullable=False)
    dimension_type: Mapped[str] = mapped_column(Text, nullable=False, default="site")
    dimension_value: Mapped[str] = mapped_column(Text, nullable=False, default="__site__")
    cadence: Mapped[str] = mapped_column(Text, nullable=False)
    model: Mapped[str] = mapped_column(Text, nullable=False)
    horizon_periods: Mapped[int] = mapped_column(nullable=False)
    status: Mapped[str] = mapped_column(Text, nullable=False, default="ok")
    params: Mapped[dict | None] = mapped_column(JSONB)
    error: Mapped[str | None] = mapped_column(Text)
    generated_at: Mapped[datetime] = mapped_column(server_default=func.now())

    __table_args__ = (
        CheckConstraint("cadence IN ('daily','weekly','monthly')", name="forecast_runs_cadence_check"),
        CheckConstraint("status IN ('ok','insufficient-data','error')", name="forecast_runs_status_check"),
        Index(
            "idx_forecast_runs_lookup",
            "client_id", "metric_key", "dimension_type", "dimension_value", "generated_at",
        ),
    )


class ForecastPoint(Base):
    __tablename__ = "forecast_points"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    forecast_run_id: Mapped[int] = mapped_column(ForeignKey("forecast_runs.id", ondelete="CASCADE"), nullable=False)
    target_period: Mapped[date] = mapped_column(Date, nullable=False)
    point_estimate: Mapped[float | None] = mapped_column(Numeric)
    lower_bound: Mapped[float | None] = mapped_column(Numeric)
    upper_bound: Mapped[float | None] = mapped_column(Numeric)

    __table_args__ = (
        UniqueConstraint("forecast_run_id", "target_period", name="forecast_points_unique"),
    )


class Insight(Base):
    __tablename__ = "insights"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    client_id: Mapped[int] = mapped_column(ForeignKey("clients.id", ondelete="CASCADE"), nullable=False)
    metric_key: Mapped[str] = mapped_column(ForeignKey("metrics_catalog.metric_key"), nullable=False)
    dimension_type: Mapped[str] = mapped_column(Text, nullable=False, default="site")
    dimension_value: Mapped[str] = mapped_column(Text, nullable=False, default="__site__")
    period_start: Mapped[date] = mapped_column(Date, nullable=False)
    insight_type: Mapped[str] = mapped_column(Text, nullable=False)
    severity: Mapped[str] = mapped_column(Text, nullable=False)
    evidence: Mapped[dict] = mapped_column(JSONB, nullable=False)
    generated_at: Mapped[datetime] = mapped_column(server_default=func.now())

    __table_args__ = (
        CheckConstraint(
            "insight_type IN ('anomaly','trend_shift','forecast_risk','milestone')",
            name="insights_type_check",
        ),
        CheckConstraint("severity IN ('high','medium','low')", name="insights_severity_check"),
        Index("idx_insights_lookup", "client_id", "metric_key", "generated_at"),
    )


class Recommendation(Base):
    __tablename__ = "recommendations"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    client_id: Mapped[int] = mapped_column(ForeignKey("clients.id", ondelete="CASCADE"), nullable=False)
    insight_id: Mapped[int] = mapped_column(ForeignKey("insights.id", ondelete="CASCADE"), nullable=False)
    priority: Mapped[str] = mapped_column(Text, nullable=False)
    recommendation_text: Mapped[str] = mapped_column(Text, nullable=False)
    # Populated by the LLM enrichment path (falls back to null under the
    # static-template path) — kept separate from recommendation_text so a
    # UI can always render "why" and "fix" as two distinct lines.
    root_cause_text: Mapped[str | None] = mapped_column(Text, nullable=True)
    status: Mapped[str] = mapped_column(Text, nullable=False, default="new")
    # Explicit timezone=True — this is the one column in this model that the
    # app actually assigns a Python datetime.now(timezone.utc) to (every
    # other timestamp column here is server_default=func.now()-only), and
    # without it SQLAlchemy binds as TIMESTAMP WITHOUT TIME ZONE and asyncpg
    # rejects the tz-aware value at write time.
    resolved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    # Free text, not a user FK — this service only has one static admin key
    # (see security/auth.py), no per-admin identity to reference yet.
    resolved_by: Mapped[str | None] = mapped_column(Text, nullable=True)
    generated_at: Mapped[datetime] = mapped_column(server_default=func.now())

    __table_args__ = (
        CheckConstraint("priority IN ('high','medium','low')", name="recommendations_priority_check"),
        CheckConstraint("status IN ('new','acknowledged','dismissed','resolved')", name="recommendations_status_check"),
    )


class IngestionRun(Base):
    __tablename__ = "ingestion_runs"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    client_id: Mapped[int] = mapped_column(ForeignKey("clients.id", ondelete="CASCADE"), nullable=False)
    collector_id: Mapped[str] = mapped_column(Text, nullable=False)
    run_date: Mapped[date] = mapped_column(Date, nullable=False)
    status: Mapped[str] = mapped_column(Text, nullable=False)
    error: Mapped[str | None] = mapped_column(Text)
    took_ms: Mapped[int | None] = mapped_column()
    created_at: Mapped[datetime] = mapped_column(server_default=func.now())

    __table_args__ = (
        CheckConstraint("status IN ('ok','insufficient-data','error')", name="ingestion_runs_status_check"),
        Index("idx_ingestion_runs_lookup", "client_id", "collector_id", "created_at"),
    )
