"""Shared fix-category rules for the Effort Estimation Engine (this module)
and the Time-to-Impact Prediction Engine (not yet built — see the Phase 2
plan's Stage 4). Distinct from MetricCatalog.category (a *data* category —
search/engagement/conversion/...) — this is a *fix* category: what kind of
work would actually move this metric. Table-driven and hand-curated, not
derived, since no signal in this service can infer "what kind of fix" from
a metric's own observations.

Every metric_key currently in metrics_catalog (enabled or not) is mapped —
disabled/future metrics are included so enabling one later doesn't silently
fall through to insufficient-data for a reason unrelated to that night's
run. A metric_key that's genuinely unmapped (e.g. added to the catalog
without updating this table) has no entry here on purpose: callers must
treat that as insufficient-data, never guess a default category."""

CATEGORY_BY_METRIC: dict[str, str] = {
    # metadata — title/meta-description/structured-data level fixes.
    "gsc_ctr": "metadata",
    "ai_visibility_score": "metadata",
    "ai_recommendation_rate": "metadata",
    # content — content depth/relevance/topical-coverage level fixes.
    "gsc_clicks": "content",
    "gsc_impressions": "content",
    "gsc_position": "content",
    "query_count": "content",
    "ga4_sessions": "content",
    "ga4_users": "content",
    "ga4_new_users": "content",
    # technical — page speed / UX / Core Web Vitals / site-health fixes.
    "ga4_bounce_rate": "technical",
    "ga4_engaged_sessions": "technical",
    "ga4_avg_engagement_time": "technical",
    "engagement_rate": "technical",
    "health_score": "technical",
    # restructuring — funnel/CRO rework or off-page link-building campaigns.
    "ga4_conversions": "restructuring",
    "conversion_rate": "restructuring",
    "authority_score": "restructuring",
    "backlinks": "restructuring",
    "referring_domains": "restructuring",
    "competitor_structural_score": "restructuring",
}

# 1 (Very Low) .. 5 (Very High) — the plan's own scale.
BASE_EFFORT_BY_CATEGORY: dict[str, int] = {
    "metadata": 1,
    "content": 3,
    "technical": 4,
    "restructuring": 5,
}

EFFORT_LABELS: dict[int, str] = {
    1: "Very Low",
    2: "Low",
    3: "Medium",
    4: "High",
    5: "Very High",
}


def category_for_metric(metric_key: str) -> str | None:
    return CATEGORY_BY_METRIC.get(metric_key)
