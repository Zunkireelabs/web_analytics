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
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    __table_args__ = (
        CheckConstraint("status IN ('active','paused','suspended')", name="clients_status_check"),
        Index("idx_clients_industry", "industry"),
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
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

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
    every real page/query — read live at request time by default, never
    run through metric_period_stats/anomalies/forecast_runs directly. The
    one exception: app/collectors/gsc_page_dimension.py reads rows back out
    of this table and re-emits them as regular metric_observations, but
    only for the small, gated subset of pages ('query' dimension is not
    included) that held an unbroken top-50 streak — bounding cardinality
    back down to a handful of consistently-ranking pages before they ever
    reach the generic engines. See app/collectors/page_query.py."""

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
        Index("idx_page_query_observations_lookup", "client_id", "dimension_type", "period_start"),
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
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

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
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

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
    # Populated by app/forecast/confidence.py right after this run persists —
    # None for a run whose status isn't 'ok' (nothing to score confidence on).
    confidence_score_id: Mapped[int | None] = mapped_column(ForeignKey("confidence_scores.id"), nullable=True)
    confidence: Mapped[float | None] = mapped_column(Numeric)
    generated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

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
    generated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

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
    # Tracks the LLM-tailoring attempt (_generate_llm in recommendations.py)
    # separately from whether a Recommendation row exists at all — a row
    # existing used to mean "already tried, never retry", even when that one
    # attempt silently failed. narration_status lets the nightly job retry
    # pending/failed rows instead of being stuck on the static template
    # forever, and narration_error/narration_attempted_at give an audit
    # trail for why tailoring didn't produce text.
    narration_status: Mapped[str] = mapped_column(Text, nullable=False, default="pending")
    narration_error: Mapped[str | None] = mapped_column(Text, nullable=True)
    narration_attempted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
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
    dismissed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    dismissed_by: Mapped[str | None] = mapped_column(Text, nullable=True)
    generated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    # Nullable, set by app/investigations/engine.py the first time this
    # recommendation is synced into an Investigation — never set at
    # generation time itself, since Root Cause/Opportunity/Ranking (which
    # the Investigation row summarizes) haven't run yet at that point in
    # the nightly pipeline. See Investigation below.
    investigation_id: Mapped[int | None] = mapped_column(ForeignKey("investigations.id", ondelete="SET NULL"), nullable=True)

    __table_args__ = (
        CheckConstraint("priority IN ('high','medium','low')", name="recommendations_priority_check"),
        CheckConstraint("status IN ('new','acknowledged','dismissed','resolved')", name="recommendations_status_check"),
        CheckConstraint("narration_status IN ('pending','ok','failed')", name="recommendations_narration_status_check"),
    )


class Investigation(Base):
    """Phase 3 — the persistent, human-facing object the spec calls an
    "Investigation". Deliberately keyed by (client_id, metric_key,
    dimension_type, dimension_value, insight_type) — NOT period_start like
    Insight — so a recurring issue is tracked as one evolving investigation
    across nights rather than a fresh row every time the Insight Engine
    replaces its underlying Insight; see app/investigations/engine.py for
    the upsert/dedup logic that enforces this. Every field here is copied
    from a row an earlier nightly stage already computed (Insight,
    Recommendation, RootCauseAnalysisRun, OpportunityScore,
    RecommendationRanking) — this table never invents a value.
    status is the 9-state lifecycle from the Phase 3 spec. A brand-new
    investigation reaches 'recommendation_generated' automatically in the
    same nightly pass (this pipeline is a single deterministic run, not a
    multi-day process) — everything past that requires a human action or a
    later pipeline stage (draft generation, review)."""

    __tablename__ = "investigations"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    client_id: Mapped[int] = mapped_column(ForeignKey("clients.id", ondelete="CASCADE"), nullable=False)
    metric_key: Mapped[str] = mapped_column(ForeignKey("metrics_catalog.metric_key"), nullable=False)
    dimension_type: Mapped[str] = mapped_column(Text, nullable=False, default="site")
    dimension_value: Mapped[str] = mapped_column(Text, nullable=False, default="__site__")
    insight_type: Mapped[str] = mapped_column(Text, nullable=False)
    severity: Mapped[str] = mapped_column(Text, nullable=False)
    priority: Mapped[str | None] = mapped_column(Text, nullable=True)
    status: Mapped[str] = mapped_column(Text, nullable=False, default="detected")
    affected_metrics: Mapped[dict] = mapped_column(JSONB, nullable=False)
    summary: Mapped[str | None] = mapped_column(Text, nullable=True)
    evidence: Mapped[dict] = mapped_column(JSONB, nullable=False)
    forecast_outlook: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    root_cause_text: Mapped[str | None] = mapped_column(Text, nullable=True)
    confidence: Mapped[float | None] = mapped_column(Numeric)
    # Free text, not a user FK — same reasoning as Recommendation.resolved_by
    # above (no per-admin identity in this service yet). Unset until a
    # future assignment feature exists; the spec marks this optional.
    owner: Mapped[str | None] = mapped_column(Text, nullable=True)
    source_insight_id: Mapped[int | None] = mapped_column(ForeignKey("insights.id", ondelete="SET NULL"), nullable=True)
    source_anomaly_id: Mapped[int | None] = mapped_column(ForeignKey("anomalies.id", ondelete="SET NULL"), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    __table_args__ = (
        CheckConstraint(
            "status IN ('detected','investigating','evidence_collected','recommendation_generated',"
            "'draft_prepared','waiting_human_review','approved','completed','archived')",
            name="investigations_status_check",
        ),
        CheckConstraint("severity IN ('high','medium','low')", name="investigations_severity_check"),
        CheckConstraint("priority IS NULL OR priority IN ('high','medium','low')", name="investigations_priority_check"),
        Index(
            "idx_investigations_open_lookup",
            "client_id", "metric_key", "dimension_type", "dimension_value", "insight_type",
        ),
        Index("idx_investigations_status", "client_id", "status"),
    )


class InvestigationEvent(Base):
    """Append-only lifecycle history for Investigation.status — one row per
    transition, per the spec's "track timestamps for every transition"."""

    __tablename__ = "investigation_events"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    investigation_id: Mapped[int] = mapped_column(ForeignKey("investigations.id", ondelete="CASCADE"), nullable=False)
    from_status: Mapped[str | None] = mapped_column(Text, nullable=True)
    to_status: Mapped[str] = mapped_column(Text, nullable=False)
    actor: Mapped[str] = mapped_column(Text, nullable=False, default="system")
    detail: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    __table_args__ = (
        Index("idx_investigation_events_lookup", "investigation_id", "created_at"),
    )


class ConfidenceScore(Base):
    """Shared confidence-scoring table for every Phase 2 intelligence engine
    (feature importance, root cause, opportunity score, roi/effort/impact
    estimation, recommendation ranking) — one compute_confidence() call site
    (app/scoring/confidence.py) instead of duplicating the same weighted-
    average-with-fallback logic per engine. subject_id is NOT a DB foreign
    key — no single table it could point at (mirrors Recommendation.
    resolved_by being free text for the same reason)."""

    __tablename__ = "confidence_scores"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    client_id: Mapped[int] = mapped_column(ForeignKey("clients.id", ondelete="CASCADE"), nullable=False)
    subject_type: Mapped[str] = mapped_column(Text, nullable=False)
    subject_id: Mapped[int] = mapped_column(BigInteger, nullable=False)
    # 'insufficient-data' when every input factor was None (no signal at
    # all) — distinct from a real, low `score`, which means the engine did
    # have signal and it was confidently poor. See compute_confidence().
    status: Mapped[str] = mapped_column(Text, nullable=False)
    score: Mapped[float | None] = mapped_column(Numeric)
    components: Mapped[dict] = mapped_column(JSONB, nullable=False)
    generated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    __table_args__ = (
        CheckConstraint(
            "subject_type IN ('feature_importance','root_cause_analysis','opportunity_score',"
            "'roi_estimation','effort_estimation','impact_prediction','recommendation_ranking',"
            "'forecast_confidence')",
            name="confidence_scores_subject_type_check",
        ),
        CheckConstraint("status IN ('ok','insufficient-data')", name="confidence_scores_status_check"),
        Index("idx_confidence_scores_lookup", "client_id", "subject_type", "subject_id"),
    )


class FeatureImportanceRun(Base):
    """Phase 2 Stage 1 — one row per (client, target metric) nightly
    permutation-importance run (app/ml/feature_importance.py). status
    mirrors ForecastRun's 'ok'/'insufficient-data'/'error' convention —
    a target with too little overlapping history reports insufficient-data
    rather than a fabricated importance split."""

    __tablename__ = "feature_importance_runs"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    client_id: Mapped[int] = mapped_column(ForeignKey("clients.id", ondelete="CASCADE"), nullable=False)
    target_metric_key: Mapped[str] = mapped_column(ForeignKey("metrics_catalog.metric_key"), nullable=False)
    method: Mapped[str] = mapped_column(Text, nullable=False)
    model_type: Mapped[str] = mapped_column(Text, nullable=False)
    n_observations: Mapped[int] = mapped_column(nullable=False)
    # Held-out R^2 — can be negative for a genuinely bad fit; stored as-is,
    # clamped only when it's fed into the Confidence Engine as model_certainty.
    model_score: Mapped[float | None] = mapped_column(Numeric)
    status: Mapped[str] = mapped_column(Text, nullable=False, default="ok")
    error: Mapped[str | None] = mapped_column(Text)
    confidence_score_id: Mapped[int | None] = mapped_column(ForeignKey("confidence_scores.id"), nullable=True)
    confidence: Mapped[float | None] = mapped_column(Numeric)
    generated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    __table_args__ = (
        CheckConstraint("method IN ('permutation_importance','shap')", name="feature_importance_runs_method_check"),
        CheckConstraint("status IN ('ok','insufficient-data','error')", name="feature_importance_runs_status_check"),
        Index("idx_feature_importance_runs_lookup", "client_id", "target_metric_key", "generated_at"),
    )


class FeatureImportanceScore(Base):
    """One row per (run, contributing feature) — importance_pct values for
    a given run sum to ~100 across its feature_importance_scores rows."""

    __tablename__ = "feature_importance_scores"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    run_id: Mapped[int] = mapped_column(ForeignKey("feature_importance_runs.id", ondelete="CASCADE"), nullable=False)
    feature_metric_key: Mapped[str] = mapped_column(ForeignKey("metrics_catalog.metric_key"), nullable=False)
    importance_pct: Mapped[float] = mapped_column(Numeric, nullable=False)
    importance_raw: Mapped[float] = mapped_column(Numeric, nullable=False)
    rank: Mapped[int] = mapped_column(nullable=False)

    __table_args__ = (
        UniqueConstraint("run_id", "feature_metric_key", name="feature_importance_scores_unique"),
    )


class RootCauseAnalysisRun(Base):
    """Phase 2 Stage 2 — one row per (client, triggering insight) Root Cause
    Analysis v1 run (app/intelligence/root_cause.py). Only 'independent_
    dimension_share' is implemented today — each enabled dimension_type's
    top contributor is ranked independently against the same site-level
    baseline, not chained into a true nested drill-down (that needs a
    combined-dimension MCP query this service doesn't have yet — see the
    Phase 2 plan's RCA v2). insight_id has no unique constraint: a re-
    triggered insight (new id, since the Insight Engine replaces rows
    rather than updating them) gets its own fresh RCA run."""

    __tablename__ = "root_cause_analysis_runs"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    client_id: Mapped[int] = mapped_column(ForeignKey("clients.id", ondelete="CASCADE"), nullable=False)
    insight_id: Mapped[int] = mapped_column(ForeignKey("insights.id", ondelete="CASCADE"), nullable=False)
    method: Mapped[str] = mapped_column(Text, nullable=False)
    status: Mapped[str] = mapped_column(Text, nullable=False, default="ok")
    error: Mapped[str | None] = mapped_column(Text)
    max_depth_reached: Mapped[int] = mapped_column(nullable=False, default=0)
    confidence_score_id: Mapped[int | None] = mapped_column(ForeignKey("confidence_scores.id"), nullable=True)
    confidence: Mapped[float | None] = mapped_column(Numeric)
    generated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    __table_args__ = (
        CheckConstraint("method IN ('independent_dimension_share','combined_query')", name="root_cause_analysis_runs_method_check"),
        CheckConstraint("status IN ('ok','insufficient-data','error')", name="root_cause_analysis_runs_status_check"),
        Index("idx_root_cause_analysis_runs_lookup", "client_id", "insight_id"),
    )


class RootCauseAnalysisNode(Base):
    """One row per node in a Root Cause Analysis run's tree. depth=0 is the
    synthetic site-level root (the triggering insight's own metric change);
    depth=1 nodes are each enabled dimension_type's top contributor,
    reported as PARALLEL SIBLINGS of each other — each independently ranked
    against the same depth=0 baseline, not against one another, since
    that's the only comparison this service's data actually supports today
    (see RootCauseAnalysisRun's docstring). depth=2 is reserved for the
    page/query terminal leaf added for GSC metrics — a leaf, never a parent
    of further nodes."""

    __tablename__ = "root_cause_analysis_nodes"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    run_id: Mapped[int] = mapped_column(ForeignKey("root_cause_analysis_runs.id", ondelete="CASCADE"), nullable=False)
    parent_node_id: Mapped[int | None] = mapped_column(ForeignKey("root_cause_analysis_nodes.id", ondelete="CASCADE"), nullable=True)
    depth: Mapped[int] = mapped_column(nullable=False)
    dimension_type: Mapped[str] = mapped_column(Text, nullable=False)
    dimension_value: Mapped[str] = mapped_column(Text, nullable=False)
    current_value: Mapped[float | None] = mapped_column(Numeric)
    prior_value: Mapped[float | None] = mapped_column(Numeric)
    abs_change: Mapped[float | None] = mapped_column(Numeric)
    pct_change: Mapped[float | None] = mapped_column(Numeric)
    # Null for the depth=2 page/query leaf — its abs_change is in clicks,
    # which isn't a valid share-of-baseline comparison when the triggering
    # metric is e.g. gsc_position or gsc_ctr (different unit entirely).
    # Never fabricate a percentage across incompatible units.
    share_of_baseline_change_pct: Mapped[float | None] = mapped_column(Numeric)


class ClientBusinessValue(Base):
    """Per-client monetary inputs for ROI Estimation Mode 2 (a later Phase 2
    stage) — all nullable; an absent row, or a row with every field null, is
    the explicit signal that Mode 2 isn't configured for this client (ROI
    falls back to Mode 1's unit-only estimate, never a fabricated default
    like $1). Set via scripts/set_business_values.py — no settings UI yet."""

    __tablename__ = "client_business_values"

    client_id: Mapped[int] = mapped_column(ForeignKey("clients.id", ondelete="CASCADE"), primary_key=True)
    conversion_value: Mapped[float | None] = mapped_column(Numeric)
    avg_order_value: Mapped[float | None] = mapped_column(Numeric)
    lead_value: Mapped[float | None] = mapped_column(Numeric)
    revenue_per_conversion: Mapped[float | None] = mapped_column(Numeric)
    currency: Mapped[str] = mapped_column(Text, nullable=False, default="USD")
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class ImpactProjectionRun(Base):
    """ROI Estimation Engine (Phase 2 plan Stage 5 — see
    app/scoring/impact_projection.py). Persisted (unlike the on-demand
    diagnostics/correlation engines) since this produces a client-facing
    figure worth an audit trail, and gives compute_confidence a real
    subject_id. Two modes: 'metric_unit' (Mode 1, always available once the
    metric has a defensible mapping — projected_metric_unit_delta/
    metric_unit populated, projected_dollar_delta/currency null) and
    'currency' (Mode 2, only when client_business_values is configured —
    all four populated). mode is null only when status != 'ok'.
    'not-computable' (metric has no defensible mapping at all) is a
    legitimate non-error outcome — never a fabricated number. 'not-
    configured' is a legacy status from before the Mode 1 fallback existed —
    kept in the CHECK constraint for old rows, never produced by current
    code (see this module's own docstring)."""

    __tablename__ = "impact_projection_runs"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    client_id: Mapped[int] = mapped_column(ForeignKey("clients.id", ondelete="CASCADE"), nullable=False)
    metric_key: Mapped[str] = mapped_column(ForeignKey("metrics_catalog.metric_key"), nullable=False)
    dimension_type: Mapped[str] = mapped_column(Text, nullable=False, default="site")
    dimension_value: Mapped[str] = mapped_column(Text, nullable=False, default="__site__")
    delta_value: Mapped[float] = mapped_column(Numeric, nullable=False)
    delta_direction: Mapped[str] = mapped_column(Text, nullable=False)
    status: Mapped[str] = mapped_column(Text, nullable=False)
    mode: Mapped[str | None] = mapped_column(Text)
    projected_dollar_delta: Mapped[float | None] = mapped_column(Numeric)
    currency: Mapped[str | None] = mapped_column(Text)
    projected_metric_unit_delta: Mapped[float | None] = mapped_column(Numeric)
    metric_unit: Mapped[str | None] = mapped_column(Text)
    method_detail: Mapped[dict] = mapped_column(JSONB, nullable=False)
    confidence_score_id: Mapped[int | None] = mapped_column(ForeignKey("confidence_scores.id"), nullable=True)
    confidence: Mapped[float | None] = mapped_column(Numeric)
    generated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    __table_args__ = (
        CheckConstraint("delta_direction IN ('decline','increase')", name="impact_projection_runs_direction_check"),
        CheckConstraint(
            "status IN ('ok','not-configured','not-computable','insufficient-data')",
            name="impact_projection_runs_status_check",
        ),
        CheckConstraint("mode IS NULL OR mode IN ('metric_unit','currency')", name="impact_projection_runs_mode_check"),
        Index(
            "idx_impact_projection_runs_lookup", "client_id", "metric_key", "dimension_type", "dimension_value", "generated_at",
        ),
    )


class EffortEstimation(Base):
    """Effort Estimation Engine (Phase 2 plan Stage 3 — see
    app/intelligence/effort_estimation.py). One row per Recommendation
    (unique on recommendation_id): effort is a property of the recommended
    fix, not the underlying insight, matching the plan's Stage 7
    Prioritizer formula which sources its inputs "per recommendation".
    category/effort_level are null only when status='insufficient-data'
    (the recommendation's metric_key has no app/intelligence/
    category_rules.py entry) — never a guessed default category."""

    __tablename__ = "effort_estimations"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    client_id: Mapped[int] = mapped_column(ForeignKey("clients.id", ondelete="CASCADE"), nullable=False)
    recommendation_id: Mapped[int] = mapped_column(ForeignKey("recommendations.id", ondelete="CASCADE"), nullable=False, unique=True)
    status: Mapped[str] = mapped_column(Text, nullable=False)
    error: Mapped[str | None] = mapped_column(Text)
    category: Mapped[str | None] = mapped_column(Text)
    effort_level: Mapped[int | None] = mapped_column()
    effort_label: Mapped[str | None] = mapped_column(Text)
    affected_page_count: Mapped[int | None] = mapped_column()
    affected_page_count_status: Mapped[str | None] = mapped_column(Text)
    method_detail: Mapped[dict] = mapped_column(JSONB, nullable=False)
    confidence_score_id: Mapped[int | None] = mapped_column(ForeignKey("confidence_scores.id"), nullable=True)
    confidence: Mapped[float | None] = mapped_column(Numeric)
    generated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    __table_args__ = (
        CheckConstraint("status IN ('ok','insufficient-data')", name="effort_estimations_status_check"),
        CheckConstraint(
            "category IS NULL OR category IN ('metadata','content','technical','restructuring')",
            name="effort_estimations_category_check",
        ),
        CheckConstraint(
            "effort_level IS NULL OR effort_level BETWEEN 1 AND 5", name="effort_estimations_effort_level_check",
        ),
        CheckConstraint(
            "affected_page_count_status IS NULL OR affected_page_count_status IN ('ok','insufficient-data','not-applicable')",
            name="effort_estimations_page_count_status_check",
        ),
        Index("idx_effort_estimations_lookup", "client_id", "recommendation_id"),
    )


class ImpactPrediction(Base):
    """Time-to-Impact Prediction Engine (Phase 2 plan Stage 4 — see
    app/intelligence/impact_prediction.py). One row per Recommendation
    (unique on recommendation_id), same structural choice as
    EffortEstimation. duration_min_weeks/duration_max_weeks/
    expected_impact_magnitude are a static per-category lookup, not fit
    from data — null only when status='insufficient-data'."""

    __tablename__ = "impact_predictions"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    client_id: Mapped[int] = mapped_column(ForeignKey("clients.id", ondelete="CASCADE"), nullable=False)
    recommendation_id: Mapped[int] = mapped_column(ForeignKey("recommendations.id", ondelete="CASCADE"), nullable=False, unique=True)
    status: Mapped[str] = mapped_column(Text, nullable=False)
    error: Mapped[str | None] = mapped_column(Text)
    category: Mapped[str | None] = mapped_column(Text)
    duration_min_weeks: Mapped[int | None] = mapped_column()
    duration_max_weeks: Mapped[int | None] = mapped_column()
    expected_impact_magnitude: Mapped[str | None] = mapped_column(Text)
    method_detail: Mapped[dict] = mapped_column(JSONB, nullable=False)
    confidence_score_id: Mapped[int | None] = mapped_column(ForeignKey("confidence_scores.id"), nullable=True)
    confidence: Mapped[float | None] = mapped_column(Numeric)
    generated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    __table_args__ = (
        CheckConstraint("status IN ('ok','insufficient-data')", name="impact_predictions_status_check"),
        CheckConstraint(
            "category IS NULL OR category IN ('metadata','content','technical','restructuring')",
            name="impact_predictions_category_check",
        ),
        CheckConstraint(
            "expected_impact_magnitude IS NULL OR expected_impact_magnitude IN ('low','medium','high')",
            name="impact_predictions_magnitude_check",
        ),
        Index("idx_impact_predictions_lookup", "client_id", "recommendation_id"),
    )


class OpportunityScore(Base):
    """Opportunity Scoring Engine (Phase 2 plan Stage 6 — see
    app/intelligence/opportunity_scoring.py). One row per Recommendation
    (unique on recommendation_id). factors is the full {name: {value,
    weight, included, reason}} breakdown for all 8 plan-named factors —
    always present even for factors that end up excluded, so a missing
    signal is visible in the API response, never silently absent.
    opportunity_score is null only when status='insufficient-data' (every
    factor excluded — no signal at all, not a fabricated 0)."""

    __tablename__ = "opportunity_scores"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    client_id: Mapped[int] = mapped_column(ForeignKey("clients.id", ondelete="CASCADE"), nullable=False)
    recommendation_id: Mapped[int] = mapped_column(ForeignKey("recommendations.id", ondelete="CASCADE"), nullable=False, unique=True)
    status: Mapped[str] = mapped_column(Text, nullable=False)
    error: Mapped[str | None] = mapped_column(Text)
    opportunity_score: Mapped[float | None] = mapped_column(Numeric)
    factors: Mapped[dict] = mapped_column(JSONB, nullable=False)
    method_detail: Mapped[dict] = mapped_column(JSONB, nullable=False)
    confidence_score_id: Mapped[int | None] = mapped_column(ForeignKey("confidence_scores.id"), nullable=True)
    confidence: Mapped[float | None] = mapped_column(Numeric)
    generated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    __table_args__ = (
        CheckConstraint("status IN ('ok','insufficient-data')", name="opportunity_scores_status_check"),
        Index("idx_opportunity_scores_lookup", "client_id", "recommendation_id"),
    )


class RecommendationRanking(Base):
    """Recommendation Prioritizer (Phase 2 plan Stage 7 — see
    app/intelligence/prioritizer.py). One row per Recommendation (unique on
    recommendation_id). rank is a 1-based ordering among ONE nightly
    batch's newly-scored recommendations for a client — not re-derived
    client-wide every night (matches every other Stage 3-7 engine's
    idempotent-once-per-recommendation contract). priority_score/rank are
    null only when status='insufficient-data' (missing or non-ok upstream
    OpportunityScore/EffortEstimation row) — never a fabricated rank."""

    __tablename__ = "recommendation_rankings"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    client_id: Mapped[int] = mapped_column(ForeignKey("clients.id", ondelete="CASCADE"), nullable=False)
    recommendation_id: Mapped[int] = mapped_column(ForeignKey("recommendations.id", ondelete="CASCADE"), nullable=False, unique=True)
    status: Mapped[str] = mapped_column(Text, nullable=False)
    error: Mapped[str | None] = mapped_column(Text)
    priority_score: Mapped[float | None] = mapped_column(Numeric)
    rank: Mapped[int | None] = mapped_column()
    method_detail: Mapped[dict] = mapped_column(JSONB, nullable=False)
    confidence_score_id: Mapped[int | None] = mapped_column(ForeignKey("confidence_scores.id"), nullable=True)
    confidence: Mapped[float | None] = mapped_column(Numeric)
    generated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    __table_args__ = (
        CheckConstraint("status IN ('ok','insufficient-data')", name="recommendation_rankings_status_check"),
        Index("idx_recommendation_rankings_lookup", "client_id", "rank"),
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
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    __table_args__ = (
        CheckConstraint("status IN ('ok','insufficient-data','error')", name="ingestion_runs_status_check"),
        Index("idx_ingestion_runs_lookup", "client_id", "collector_id", "created_at"),
    )
