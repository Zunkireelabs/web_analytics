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
    dim is 'device' or 'country'."""
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
