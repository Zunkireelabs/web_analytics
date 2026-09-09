"""Direct-database implementations of the read-only MCP tools.

The MCP endpoint is this service's PREFERRED source and stays that way — it
is the Node app's own supported read contract, and it is the only source for
anything Node computes on the fly. But it is a second process reached over
HTTP, and when it is down or its token is revoked every collector fails and
`metric_observations` stops moving. That is not hypothetical: it happened for
twelve days from 2026-08-23 (see run_nightly.py::_describe), and because the
freshness gate keys off those very tables, the whole prediction -> recommendation
-> execution chain silently produced nothing.

Since the schema merge this service's DATABASE_URL points at the SAME Postgres
that the Node app writes its GSC/GA4 ingest into, and `clients.id` is by
convention the same integer as Node's `sites.id`. So the underlying rows are
right there. These functions read them directly, returning the exact same
shapes the corresponding MCP tools return, so a collector cannot tell which
source served it.

Scope is deliberately limited to tools backed by a real Node-side table. A
tool with no such table has no entry here and simply has no fallback — the
caller then records insufficient-data, which stays honest rather than
inventing a number.
"""
from datetime import date

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

# gsc_daily and ga4_daily are independently sparse — a day can exist in one
# and not the other — so this is a FULL OUTER JOIN, not an inner one. Missing
# metrics come back as NULL (-> None), never coerced to 0: a day with no GA4
# row must stay absent, exactly as the MCP tool leaves it.
_DAILY_SERIES = text("""
    SELECT COALESCE(g.date, a.date)   AS date,
           g.clicks, g.impressions, g.ctr, g.position,
           a.users, a.new_users, a.sessions, a.engaged_sessions,
           a.avg_engagement_time, a.conversions, a.bounce_rate
      FROM (SELECT * FROM gsc_daily WHERE site_id = :site_id AND date BETWEEN :start AND :end) g
      FULL OUTER JOIN
           (SELECT * FROM ga4_daily WHERE site_id = :site_id AND date BETWEEN :start AND :end) a
        ON g.date = a.date
     ORDER BY 1
""")

_HEALTH_SCORE_SERIES = text("""
    SELECT date, website_health_score
      FROM daily_reports
     WHERE site_id = :site_id AND date BETWEEN :start AND :end
       AND website_health_score IS NOT NULL
     ORDER BY date
""")

_CHANNELS_DAILY = text("""
    SELECT date, channel, sessions, users
      FROM ga4_channels
     WHERE site_id = :site_id AND date BETWEEN :start AND :end
     ORDER BY date, channel
""")

_GSC_BREAKDOWN_DAILY = text("""
    SELECT date, dim_value, clicks, impressions, ctr, position
      FROM gsc_breakdown
     WHERE site_id = :site_id AND dim_type = :dim AND date BETWEEN :start AND :end
     ORDER BY date, dim_value
""")

_GA4_BREAKDOWN_DAILY = text("""
    SELECT date, dim_value, sessions, users
      FROM ga4_breakdown
     WHERE site_id = :site_id AND dim_type = :dim AND date BETWEEN :start AND :end
     ORDER BY date, dim_value
""")

# Mirrors the MCP tool's own per-day bound: page/query cardinality is
# unbounded, so rank within each day and keep the top `limit` by clicks.
_GSC_BREAKDOWN_TOP_N = text("""
    SELECT date, dim_value, clicks, impressions, ctr, position
      FROM (
        SELECT date, dim_value, clicks, impressions, ctr, position,
               ROW_NUMBER() OVER (PARTITION BY date ORDER BY clicks DESC, dim_value) AS rn
          FROM gsc_breakdown
         WHERE site_id = :site_id AND dim_type = :dim AND date BETWEEN :start AND :end
      ) ranked
     WHERE rn <= :limit
     ORDER BY date, clicks DESC
""")

_GSC_BREAKDOWN_RANGE = text("""
    SELECT dim_value,
           SUM(clicks)::float       AS clicks,
           SUM(impressions)::float  AS impressions,
           CASE WHEN SUM(impressions) > 0
                THEN SUM(clicks)::float / SUM(impressions)::float END AS ctr,
           CASE WHEN SUM(impressions) > 0
                THEN SUM(position * impressions)::float / SUM(impressions)::float END AS avg_position
      FROM gsc_breakdown
     WHERE site_id = :site_id AND dim_type = :dim AND date BETWEEN :start AND :end
     GROUP BY dim_value
     ORDER BY clicks DESC
     LIMIT :limit
""")

_DATA_RANGE = text("""
    SELECT (SELECT MIN(date) FROM gsc_daily WHERE site_id = :site_id) AS earliest,
           (SELECT MAX(date) FROM gsc_daily WHERE site_id = :site_id) AS freshest,
           (SELECT MAX(date) FROM ga4_daily WHERE site_id = :site_id) AS latest_visitor
""")

# Monday-start weekly rollup of real per-run AI mention data, matching the
# shape of the MCP tool (which buckets the same ai_prompt_runs rows).
_AI_VISIBILITY_WEEKLY = text("""
    SELECT to_char(date_trunc('week', run_date), 'YYYY-MM-DD') AS week,
           COUNT(*) FILTER (WHERE mentioned)::int              AS mentioned_count,
           COUNT(*)::int                                       AS total_count
      FROM ai_prompt_runs
     WHERE site_id = :site_id AND run_date BETWEEN :start AND :end
     GROUP BY 1
     ORDER BY 1
""")


def _iso(value):
    return value.isoformat() if isinstance(value, date) else value


def _as_date(value):
    """The MCP tools speak ISO strings; the DATE columns behind them do not.
    asyncpg binds parameters by real type and rejects a str for a DATE
    ('str' object has no attribute 'toordinal'), so every window bound is
    parsed here rather than at each call site."""
    if isinstance(value, date) or value is None:
        return value
    return date.fromisoformat(str(value)[:10])


def _window(site_id: int, start, end, **extra) -> dict:
    return {"site_id": site_id, "start": _as_date(start), "end": _as_date(end), **extra}


def _rows(result) -> list[dict]:
    return [dict(r) for r in result.mappings().all()]


async def get_daily_series(session: AsyncSession, site_id: int, start: str, end: str) -> list[dict]:
    result = await session.execute(_DAILY_SERIES, _window(site_id, start, end))
    return [{**row, "date": _iso(row["date"])} for row in _rows(result)]


async def get_health_score_series(session: AsyncSession, site_id: int, start: str, end: str) -> list[dict]:
    result = await session.execute(_HEALTH_SCORE_SERIES, _window(site_id, start, end))
    return [{"date": _iso(row["date"]), "website_health_score": row["website_health_score"]} for row in _rows(result)]


async def get_channels_daily_series(session: AsyncSession, site_id: int, start: str, end: str) -> list[dict]:
    result = await session.execute(_CHANNELS_DAILY, _window(site_id, start, end))
    return [{**row, "date": _iso(row["date"])} for row in _rows(result)]


async def get_gsc_breakdown_daily_series(session: AsyncSession, site_id: int, start: str, end: str, dim: str) -> list[dict]:
    result = await session.execute(_GSC_BREAKDOWN_DAILY, _window(site_id, start, end, dim=dim))
    return [{**row, "date": _iso(row["date"])} for row in _rows(result)]


async def get_ga4_breakdown_daily_series(session: AsyncSession, site_id: int, start: str, end: str, dim: str) -> list[dict]:
    result = await session.execute(_GA4_BREAKDOWN_DAILY, _window(site_id, start, end, dim=dim))
    return [{**row, "date": _iso(row["date"])} for row in _rows(result)]


async def get_gsc_breakdown_daily_top_n(
    session: AsyncSession, site_id: int, start: str, end: str, dim: str, limit: int = 50,
) -> list[dict]:
    result = await session.execute(
        _GSC_BREAKDOWN_TOP_N, _window(site_id, start, end, dim=dim, limit=limit),
    )
    return [{**row, "date": _iso(row["date"])} for row in _rows(result)]


async def get_gsc_breakdown(
    session: AsyncSession, site_id: int, start: str, end: str, dim: str, limit: int = 10,
) -> list[dict]:
    result = await session.execute(
        _GSC_BREAKDOWN_RANGE, _window(site_id, start, end, dim=dim, limit=limit),
    )
    return _rows(result)


async def get_data_range(session: AsyncSession, site_id: int) -> dict:
    result = await session.execute(_DATA_RANGE, {"site_id": site_id})
    row = result.mappings().first() or {}
    return {k: _iso(row.get(k)) for k in ("earliest", "freshest", "latest_visitor")}


async def get_ai_recommendation_visibility_weekly_series(
    session: AsyncSession, site_id: int, start: str, end: str,
) -> list[dict]:
    result = await session.execute(_AI_VISIBILITY_WEEKLY, _window(site_id, start, end))
    rows = []
    for row in _rows(result):
        total = row["total_count"] or 0
        rows.append({
            **row,
            # Percent, matching the MCP tool's scale. Guarded rather than
            # defaulted: a week with no runs has no rate, it is not 0%.
            "visibility_pct": (row["mentioned_count"] / total * 100) if total else None,
        })
    return rows


# Tool name -> direct-DB implementation. A tool absent from this map has no
# database equivalent and therefore no fallback; DataSource treats that as
# "MCP-only" and lets the failure surface as insufficient-data.
FALLBACKS = {
    "get_daily_series": get_daily_series,
    "get_health_score_series": get_health_score_series,
    "get_channels_daily_series": get_channels_daily_series,
    "get_gsc_breakdown_daily_series": get_gsc_breakdown_daily_series,
    "get_ga4_breakdown_daily_series": get_ga4_breakdown_daily_series,
    "get_gsc_breakdown_daily_top_n": get_gsc_breakdown_daily_top_n,
    "get_gsc_breakdown": get_gsc_breakdown,
    "get_data_range": get_data_range,
    "get_ai_recommendation_visibility_weekly_series": get_ai_recommendation_visibility_weekly_series,
}
