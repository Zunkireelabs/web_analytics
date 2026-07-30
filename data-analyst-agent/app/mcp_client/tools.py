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
