from app.mcp_client.client import McpClient
from app.mcp_client.datasource import DataSource


async def _call(mcp, tool_name: str, arguments: dict | None = None, **db_kwargs):
    """Single dispatch point for every tool below.

    A DataSource gets the MCP-preferred/database-fallback treatment; a bare
    McpClient (or any test fake exposing call_tool) keeps the original
    behaviour, so nothing that already holds one needs to change.
    """
    if isinstance(mcp, DataSource):
        return await mcp.call(tool_name, arguments, **db_kwargs)
    return await mcp.call_tool(tool_name, arguments or {})


async def get_data_range(mcp: McpClient) -> dict:
    """{earliest, freshest, latest_visitor} — YYYY-MM-DD strings or null."""
    return await _call(mcp, "get_data_range")


async def get_daily_series(mcp: McpClient, start: str, end: str) -> list[dict]:
    """One row per day: date, clicks, impressions, ctr, position, users,
    new_users, sessions, engaged_sessions, avg_engagement_time, conversions,
    bounce_rate (added by the Phase 0 GA4-ingest change)."""
    return await _call(mcp, "get_daily_series", {"start": start, "end": end}, start=start, end=end)


async def get_health_score_series(mcp: McpClient, start: str, end: str) -> list[dict]:
    """[{date, website_health_score}] — sparse, never interpolated."""
    return await _call(mcp, "get_health_score_series", {"start": start, "end": end}, start=start, end=end)


async def get_authority_score_series(mcp: McpClient, start: str, end: str) -> list[dict]:
    """[{snapshot_date, authority_score, referring_domains, total_backlinks}] —
    real monthly DataForSEO-backed snapshots. Empty if not configured for this site."""
    return await _call(mcp, "get_authority_score_series", {"start": start, "end": end})


async def get_ai_recommendation_visibility_series(mcp: McpClient, start: str, end: str) -> list[dict]:
    """[{month, mentioned_count, total_count, visibility_pct}] — real AI-engine
    mention rate rolled up to calendar month. Empty if not enabled for this site."""
    return await _call(mcp, "get_ai_recommendation_visibility_series", {"start": start, "end": end})


async def get_ai_recommendation_visibility_weekly_series(mcp: McpClient, start: str, end: str) -> list[dict]:
    """[{week, mentioned_count, total_count, visibility_pct}] — real AI-engine
    mention rate rolled up to calendar week (Monday-start). Empty if not enabled
    for this site. The underlying ai_prompt_runs data was never actually
    monthly-only — this is the same real per-run data as
    get_ai_recommendation_visibility_series above, bucketed finer."""
    return await _call(
        mcp, "get_ai_recommendation_visibility_weekly_series", {"start": start, "end": end}, start=start, end=end,
    )


async def get_competitor_structural_score_series(mcp: McpClient, start: str, end: str) -> list[dict]:
    """[{snapshot_date, own_score}] — this site's own structural-readiness score,
    one value per real run, deduped across the competitor rows written in that run."""
    return await _call(mcp, "get_competitor_structural_score_series", {"start": start, "end": end})


async def get_channels_daily_series(mcp: McpClient, start: str, end: str) -> list[dict]:
    """[{date, channel, sessions, users}] — one row per (day, channel),
    unaggregated. Distinct from a range-summed channel breakdown."""
    return await _call(mcp, "get_channels_daily_series", {"start": start, "end": end}, start=start, end=end)


async def get_gsc_breakdown_daily_series(mcp: McpClient, start: str, end: str, dim: str) -> list[dict]:
    """[{date, dim_value, clicks, impressions, ctr, position}] — one row per
    (day, dim_value). dim is 'device' or 'country'."""
    return await _call(
        mcp, "get_gsc_breakdown_daily_series", {"start": start, "end": end, "dim": dim},
        start=start, end=end, dim=dim,
    )


async def get_ga4_breakdown_daily_series(mcp: McpClient, start: str, end: str, dim: str) -> list[dict]:
    """[{date, dim_value, sessions, users}] — one row per (day, dim_value).
    dim is 'device', 'country', 'browser', or 'source_medium'."""
    return await _call(
        mcp, "get_ga4_breakdown_daily_series", {"start": start, "end": end, "dim": dim},
        start=start, end=end, dim=dim,
    )


async def get_gsc_breakdown_daily_top_n(mcp: McpClient, start: str, end: str, dim: str, limit: int = 50) -> list[dict]:
    """[{date, dim_value, clicks, impressions, ctr, position}] — top `limit`
    rows by clicks per day. dim is 'page' or 'query'. Bounded per day, unlike
    get_gsc_breakdown_daily_series, since page/query cardinality is unbounded."""
    return await _call(
        mcp, "get_gsc_breakdown_daily_top_n", {"start": start, "end": end, "dim": dim, "limit": limit},
        start=start, end=end, dim=dim, limit=limit,
    )


async def push_predictive_alert(mcp: McpClient, alerts: list[dict]) -> dict:
    """Pushes real alerts ([{severity, title, body}]) through the Node app's
    notification channels (in-app + email). Requires the calling MCP token
    to hold at least 'ai_actions' permission — a 'read_only' token never
    even has this tool registered server-side, so this raises McpToolError
    ("tool not found") rather than succeeding; callers must catch and skip
    gracefully, same as any other per-metric MCP failure."""
    return await _call(mcp, "push_predictive_alert", {"alerts": alerts})


async def get_gsc_breakdown(mcp: McpClient, start: str, end: str, dim: str, limit: int = 10) -> list[dict]:
    """[{dim_value, clicks, impressions, ctr, avg_position}] — one row per
    dim_value, summed over the whole range and ordered by clicks desc.
    limit accepts up to 2000 for dim='query'/'page' (raised specifically for
    the keyword-clustering collector — see mcp-server/tools/read-only.js's
    own comment on this tool)."""
    return await _call(
        mcp, "get_gsc_breakdown", {"start": start, "end": end, "dim": dim, "limit": limit},
        start=start, end=end, dim=dim, limit=limit,
    )


async def get_site_profile(mcp: McpClient) -> dict | None:
    """{industry, main_topics, site_type, profiled_at} or null if this site
    has never been profiled yet."""
    return await _call(mcp, "get_site_profile")


async def get_keyword_gaps(mcp: McpClient, status: str | None = None) -> list[dict]:
    """[{id, topic, reason, priority, status, source, created_at}], newest
    first. Optionally filtered by review status."""
    args = {"status": status} if status else {}
    return await _call(mcp, "get_keyword_gaps", args)


async def get_page_inventory(mcp: McpClient, limit: int | None = None) -> list[dict]:
    """[{page, discovered_via, orphaned, first_seen_at, last_seen_at}] — every
    real URL known for this site (sitemap + a real crawl + GSC), how it was
    first discovered ('sitemap'/'crawl'/'gsc'), and whether it's orphaned
    (in the sitemap but unreachable via any real internal link found during
    the last crawl). This is website STRUCTURE only — page CONTENT
    (titles/headings/body/schema) is not persisted anywhere Node-side and so
    has no equivalent read here yet."""
    args = {"limit": limit} if limit else {}
    return await _call(mcp, "get_page_inventory", args)


async def get_technical_seo_signals(mcp: McpClient, pages: list[str] | None = None, limit: int | None = None) -> list[dict]:
    """[{page, checked_at, title, has_canonical, has_schema, schema_types,
    index_status, broken_links, last_impressions, word_count,
    meta_description, internal_link_count}] — already-persisted technical +
    content signals (migration 120). Only covers pages this site's
    technical-seo rotation has already checked; an absent page is "never
    checked", never a false "no issues"."""
    args = {}
    if pages:
        args["pages"] = pages
    if limit:
        args["limit"] = limit
    return await _call(mcp, "get_technical_seo_signals", args)


async def get_query_page_metrics(mcp: McpClient, start: str, end: str, min_impressions: int = 5) -> list[dict]:
    """[{query, page, clicks, impressions, avgPosition, ctr}] — one row per
    (query, page) pair actually observed together over the range. No
    estimated search volume anywhere in this data."""
    return await _call(mcp, "get_query_page_metrics", {"start": start, "end": end, "minImpressions": min_impressions})


async def get_cannibalized_queries(
    mcp: McpClient, start: str, end: str, min_impressions: int = 5, max_position: int = 20, limit: int = 20,
) -> list[dict]:
    """[{query, pages: [{page, clicks, impressions, avg_position}, ...]}] —
    real queries where 2+ of this site's own pages both rank within
    max_position over the range, sorted by combined clicks. Raw candidate
    evidence only — NOT itself a finding; requires further grading (demand,
    ownership stability) before use, per app/intelligence/cannibalization.py."""
    return await _call(mcp, "get_cannibalized_queries", {
        "start": start, "end": end, "minImpressions": min_impressions, "maxPosition": max_position, "limit": limit,
    })


async def save_site_profile(mcp: McpClient, *, industry: str, main_topics: list[str], site_type: str | None) -> dict:
    """Upserts the current-state site profile row. Requires 'ai_actions'."""
    return await _call(mcp, "save_site_profile", {"industry": industry, "mainTopics": main_topics, "siteType": site_type})


async def save_keyword_clusters(mcp: McpClient, clusters: list[dict]) -> dict:
    """clusters: [{clusterName, clusterType, keywords: [{keyword, impressions,
    avgPosition}], avgImpressions, avgPosition, gapScore}]. Append-only per
    run. Requires 'ai_actions'."""
    return await _call(mcp, "save_keyword_clusters", {"clusters": clusters})


async def save_keyword_gaps(mcp: McpClient, gaps: list[dict], source: str = "internal_analysis") -> dict:
    """gaps: [{topic, reason, priority}]. Requires 'ai_actions'."""
    return await _call(mcp, "save_keyword_gaps", {"gaps": gaps, "source": source})


async def generate_draft(mcp: McpClient, *, generator_id: str, params: dict, finding_id: str) -> dict:
    """Runs one Action Center generator and persists the result as a new
    draft (mcp-server/tools/ai-actions.js — the same tool the manual
    "Generate Content Draft" button ultimately reaches via generateDraft()).
    Idempotent per finding_id — a repeat call for the same finding returns
    the existing draft instead of creating a duplicate. Same 'ai_actions'
    permission requirement and McpToolError-on-missing-permission caveat as
    push_predictive_alert above."""
    return await _call(mcp, "generate_draft", {
        "generatorId": generator_id, "params": params, "source": "analyst-auto", "findingId": finding_id,
    })
