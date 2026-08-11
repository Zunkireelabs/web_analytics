from app.mcp_client.client import McpClient


async def get_data_range(mcp: McpClient) -> dict:
    """{earliest, freshest, latest_visitor} — YYYY-MM-DD strings or null."""
    return await mcp.call_tool("get_data_range")


async def get_daily_series(mcp: McpClient, start: str, end: str) -> list[dict]:
    """One row per day: date, clicks, impressions, ctr, position, users,
    new_users, sessions, engaged_sessions, avg_engagement_time, conversions,
    bounce_rate (added by the Phase 0 GA4-ingest change)."""
    return await mcp.call_tool("get_daily_series", {"start": start, "end": end})


async def get_health_score_series(mcp: McpClient, start: str, end: str) -> list[dict]:
    """[{date, website_health_score}] — sparse, never interpolated."""
    return await mcp.call_tool("get_health_score_series", {"start": start, "end": end})


async def get_authority_score_series(mcp: McpClient, start: str, end: str) -> list[dict]:
    """[{snapshot_date, authority_score, referring_domains, total_backlinks}] —
    real monthly DataForSEO-backed snapshots. Empty if not configured for this site."""
    return await mcp.call_tool("get_authority_score_series", {"start": start, "end": end})


async def get_ai_recommendation_visibility_series(mcp: McpClient, start: str, end: str) -> list[dict]:
    """[{month, mentioned_count, total_count, visibility_pct}] — real AI-engine
    mention rate rolled up to calendar month. Empty if not enabled for this site."""
    return await mcp.call_tool("get_ai_recommendation_visibility_series", {"start": start, "end": end})


async def get_competitor_structural_score_series(mcp: McpClient, start: str, end: str) -> list[dict]:
    """[{snapshot_date, own_score}] — this site's own structural-readiness score,
    one value per real run, deduped across the competitor rows written in that run."""
    return await mcp.call_tool("get_competitor_structural_score_series", {"start": start, "end": end})


async def get_channels_daily_series(mcp: McpClient, start: str, end: str) -> list[dict]:
    """[{date, channel, sessions, users}] — one row per (day, channel),
    unaggregated. Distinct from a range-summed channel breakdown."""
    return await mcp.call_tool("get_channels_daily_series", {"start": start, "end": end})


async def get_gsc_breakdown_daily_series(mcp: McpClient, start: str, end: str, dim: str) -> list[dict]:
    """[{date, dim_value, clicks, impressions, ctr, position}] — one row per
    (day, dim_value). dim is 'device' or 'country'."""
    return await mcp.call_tool("get_gsc_breakdown_daily_series", {"start": start, "end": end, "dim": dim})


async def get_ga4_breakdown_daily_series(mcp: McpClient, start: str, end: str, dim: str) -> list[dict]:
    """[{date, dim_value, sessions, users}] — one row per (day, dim_value).
    dim is 'device', 'country', 'browser', or 'source_medium'."""
    return await mcp.call_tool("get_ga4_breakdown_daily_series", {"start": start, "end": end, "dim": dim})


async def get_gsc_breakdown_daily_top_n(mcp: McpClient, start: str, end: str, dim: str, limit: int = 50) -> list[dict]:
    """[{date, dim_value, clicks, impressions, ctr, position}] — top `limit`
    rows by clicks per day. dim is 'page' or 'query'. Bounded per day, unlike
    get_gsc_breakdown_daily_series, since page/query cardinality is unbounded."""
    return await mcp.call_tool("get_gsc_breakdown_daily_top_n", {"start": start, "end": end, "dim": dim, "limit": limit})


async def push_predictive_alert(mcp: McpClient, alerts: list[dict]) -> dict:
    """Pushes real alerts ([{severity, title, body}]) through the Node app's
    notification channels (in-app + email). Requires the calling MCP token
    to hold at least 'ai_actions' permission — a 'read_only' token never
    even has this tool registered server-side, so this raises McpToolError
    ("tool not found") rather than succeeding; callers must catch and skip
    gracefully, same as any other per-metric MCP failure."""
    return await mcp.call_tool("push_predictive_alert", {"alerts": alerts})


async def get_gsc_breakdown(mcp: McpClient, start: str, end: str, dim: str, limit: int = 10) -> list[dict]:
    """[{dim_value, clicks, impressions, ctr, avg_position}] — one row per
    dim_value, summed over the whole range and ordered by clicks desc.
    limit accepts up to 2000 for dim='query'/'page' (raised specifically for
    the keyword-clustering collector — see mcp-server/tools/read-only.js's
    own comment on this tool)."""
    return await mcp.call_tool("get_gsc_breakdown", {"start": start, "end": end, "dim": dim, "limit": limit})


async def get_site_profile(mcp: McpClient) -> dict | None:
    """{industry, main_topics, site_type, profiled_at} or null if this site
    has never been profiled yet."""
    return await mcp.call_tool("get_site_profile")


async def get_keyword_gaps(mcp: McpClient, status: str | None = None) -> list[dict]:
    """[{id, topic, reason, priority, status, source, created_at}], newest
    first. Optionally filtered by review status."""
    args = {"status": status} if status else {}
    return await mcp.call_tool("get_keyword_gaps", args)


async def save_site_profile(mcp: McpClient, *, industry: str, main_topics: list[str], site_type: str | None) -> dict:
    """Upserts the current-state site profile row. Requires 'ai_actions'."""
    return await mcp.call_tool("save_site_profile", {"industry": industry, "mainTopics": main_topics, "siteType": site_type})


async def save_keyword_clusters(mcp: McpClient, clusters: list[dict]) -> dict:
    """clusters: [{clusterName, clusterType, keywords: [{keyword, impressions,
    avgPosition}], avgImpressions, avgPosition, gapScore}]. Append-only per
    run. Requires 'ai_actions'."""
    return await mcp.call_tool("save_keyword_clusters", {"clusters": clusters})


async def save_keyword_gaps(mcp: McpClient, gaps: list[dict], source: str = "internal_analysis") -> dict:
    """gaps: [{topic, reason, priority}]. Requires 'ai_actions'."""
    return await mcp.call_tool("save_keyword_gaps", {"gaps": gaps, "source": source})


async def generate_draft(mcp: McpClient, *, generator_id: str, params: dict, finding_id: str) -> dict:
    """Runs one Action Center generator and persists the result as a new
    draft (mcp-server/tools/ai-actions.js — the same tool the manual
    "Generate Content Draft" button ultimately reaches via generateDraft()).
    Idempotent per finding_id — a repeat call for the same finding returns
    the existing draft instead of creating a duplicate. Same 'ai_actions'
    permission requirement and McpToolError-on-missing-permission caveat as
    push_predictive_alert above."""
    return await mcp.call_tool("generate_draft", {
        "generatorId": generator_id, "params": params, "source": "analyst-auto", "findingId": finding_id,
    })
