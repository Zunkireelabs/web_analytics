"""Keyword clustering + gap analysis collector — the in-service replacement
for the retired standalone agents/clustering.py script (Node repo root).
Runs as an ordinary nightly collector (registry.py), but internally skips
real work unless it's actually due: clustering is expensive (embeddings +
several LLM calls) and only meaningful once a week, unlike the metric
collectors around it which genuinely have new data every day. Due-ness is
"has this site already had a discovery pass in the CURRENT calendar week"
(_week_start), read from the site's own profiled_at via MCP
(get_site_profile) rather than any local state, so it survives this service
restarting or a client being re-added.

That check is also what makes this collector safe to run more than once a
day. It has to be: the nightly pipeline is not guaranteed to fire exactly
once (staging runs it twice — an in-process APScheduler at 03:00 UTC and a
host crontab at 22:00 UTC, both calling the same run_nightly(), with no lock
between them), and this collector's writes are the pipeline's only
non-idempotent ones. The week gate here is the first of two defenses; the
second is migration 143's last_observed_week, which gates the
observation_count increment itself inside saveKeywordGaps. Both are needed:
this one stops the expensive LLM work from repeating, that one keeps the
count honest if it does.

All data in and out goes through MCP (get_gsc_breakdown for real GSC query
data, save_site_profile/save_keyword_clusters/save_keyword_gaps for output)
— same "only interface this service ever calls for production data" rule
every other collector follows (see app/mcp_client/client.py's own docstring
and app/collectors/base.py's Collector contract)."""
import logging
from datetime import date, timedelta

from app.collectors.base import Collector, Observation
from app.intelligence import keyword_clustering as ic
from app.mcp_client.tools import (
    get_gsc_breakdown, get_keyword_gaps, get_site_profile,
    save_keyword_clusters, save_keyword_gaps, save_site_profile,
)

logger = logging.getLogger(__name__)

WINDOW_DAYS = 90  # matches the retired script's own DEFAULT_DAYS
# Discovery is once per CALENDAR week, not once per rolling 7 days.
#
# Content-gap autonomous shipping (Node
# server/agents/lib/analyst-seo-mapping.js's qualifyAndShipContentGaps) needs a
# fresh weekly discovery pass to accumulate the 2+ observations it requires
# before a gap is eligible to ship. A rolling "7 days since profiled_at" window
# delivered roughly that, but each site's boundary landed on whatever weekday it
# was first connected, and drifted further every time a run was skipped or
# failed. The Monday ship cycle has to be able to ask "which opportunities
# belong to LAST week" and get the same answer for every tenant, and must never
# ship one discovered by that same Monday's run — neither question is answerable
# against a per-site rolling window. See migration 143.
#
# _week_start() is the single definition of a week boundary on this side;
# migration 143's date_trunc('week', ...) is its SQL counterpart. Both are
# ISO weeks (Monday start) in UTC — keep them in agreement.
KEYWORD_FETCH_LIMIT = 2000  # see mcp-server/tools/read-only.js's get_gsc_breakdown cap


def _week_start(d: date) -> date:
    """Monday of the ISO week containing d. Mirrors Postgres
    date_trunc('week', ...)::date, which is also Monday-based."""
    return d - timedelta(days=d.weekday())


class KeywordClusteringCollector(Collector):
    collector_id = "keyword_clustering"
    metric_keys: list[str] = []  # doesn't feed metric_observations at all
    writes_own_storage = True

    async def collect(self, *, session, client, mcp, window_start: date, window_end: date) -> list[Observation]:
        profile = await get_site_profile(mcp)
        if profile and profile.get("profiled_at"):
            profiled_at = date.fromisoformat(profile["profiled_at"][:10])
            if _week_start(profiled_at) >= _week_start(window_end):
                logger.info(
                    "client %s: keyword discovery already ran in the week of %s (last run %s)",
                    client.id, _week_start(window_end), profiled_at,
                )
                return []

        since = window_end - timedelta(days=WINDOW_DAYS)
        rows = await get_gsc_breakdown(mcp, since.isoformat(), window_end.isoformat(), "query", KEYWORD_FETCH_LIMIT)
        # get_gsc_breakdown's SUM(impressions)/SUM(clicks) are bigint/numeric
        # aggregates — node-postgres serializes those as strings over JSON
        # (precision, not a real int), never auto-cast to a JS number. Cast
        # here at the one place this MCP tool's numbers enter Python, rather
        # than at every downstream comparison.
        keywords = [
            {"keyword": r["dim_value"], "impressions": int(r["impressions"]), "avg_position": float(r["avg_position"]) if r.get("avg_position") is not None else None}
            for r in rows
            if r.get("impressions") is not None and int(r["impressions"]) >= ic.MIN_IMPRESSIONS
        ]
        if not keywords:
            logger.info("client %s: no keyword data in the last %d days, skipping", client.id, WINDOW_DAYS)
            return []

        new_profile = await ic.profile_site(keywords)
        if new_profile:
            await save_site_profile(
                mcp, industry=new_profile["industry"], main_topics=new_profile["main_topics"], site_type=new_profile["site_type"],
            )

        groups = ic.cluster_keywords(keywords)
        naming = await ic.name_and_type_clusters(groups)
        cluster_rows = ic.build_cluster_rows(groups, naming)
        if new_profile:
            cluster_rows = await ic.filter_noise_clusters(new_profile["industry"], new_profile["site_type"], cluster_rows)

        if cluster_rows:
            await save_keyword_clusters(mcp, [
                {
                    "clusterName": c["cluster_name"], "clusterType": c["cluster_type"],
                    "keywords": [{"keyword": k["keyword"], "impressions": k["impressions"], "avgPosition": k["avg_position"]} for k in c["keywords_json"]],
                    "avgImpressions": c["avg_impressions"], "avgPosition": c["avg_position"], "gapScore": c["gap_score"],
                }
                for c in cluster_rows
            ])

        gaps: list[dict] = []
        if new_profile and cluster_rows:
            gaps = await ic.find_gaps(new_profile, cluster_rows)
            if gaps:
                await save_keyword_gaps(mcp, gaps, source="internal_analysis")

        logger.info(
            "client %s: profile=%s, %d cluster(s) saved, %d gap(s) flagged for review",
            client.id, "ok" if new_profile else "failed", len(cluster_rows), len(gaps),
        )

        if new_profile and new_profile["main_topics"]:
            await self._run_external_research(mcp, client, new_profile, keywords, gaps, window_end)

        return []

    async def _run_external_research(self, mcp, client, profile: dict, keywords: list[dict], step3_gaps: list[dict], window_end: date) -> None:
        """Step 4 — independent of Steps 1-3 above beyond reusing the
        profile just produced and this run's own already-fetched keyword
        set (in place of the retired script's second DB round-trip for
        position lookups — see the module docstring)."""
        # Skip the LLM guess entirely when this site already has a real,
        # search-volume-backed keyword_gaps batch from THIS calendar month
        # (Node's server/agents/lib/keyword-demand.js, source=
        # 'dataforseo_demand' — see its own module docstring). That path only
        # runs once DataForSEO is configured; sites without it keep using
        # this LLM-guess step unchanged, so keyword-gap discovery is never
        # lost while waiting on credentials.
        existing_gaps = await get_keyword_gaps(mcp)
        this_month = window_end.replace(day=1)
        has_real_demand_batch = any(
            g.get("source") == "dataforseo_demand"
            and g.get("created_at")
            and date.fromisoformat(g["created_at"][:10]) >= this_month
            for g in existing_gaps
        )
        if has_real_demand_batch:
            logger.info(
                "client %s: real DataForSEO keyword-demand data already exists for this month — skipping LLM-guess research.",
                client.id,
            )
            return

        # Only this run's own emissions seed the dedupe set. Previously the
        # already-persisted gaps were folded in here too, which meant a topic
        # was researched, matched, and then dropped before save_keyword_gaps
        # ever saw it — so its observation_count stayed at 1 forever and it
        # could never reach qualifyAndShipContentGaps's >= 2 bar. Re-sights
        # are the mechanism by which an opportunity earns its way to shipping,
        # not a duplicate to be suppressed; the upsert on migration 129's
        # partial unique index is what prevents an actual duplicate row, and
        # migration 143's last_observed_week is what keeps a re-sight from
        # counting more than once per calendar week.
        seen_this_run = {g["topic"].lower() for g in step3_gaps}
        observed_positions = {k["keyword"].lower(): k["avg_position"] for k in keywords if k.get("avg_position") is not None}

        keywords_researched = 0
        new_gaps: list[dict] = []
        for topic in profile["main_topics"]:
            researched = await ic.research_topic_keywords(profile["site_type"], profile["industry"], topic)
            keywords_researched += len(researched)
            if not researched:
                continue
            new_gaps.extend(ic.gaps_from_research(topic, researched, observed_positions, seen_this_run))

        if new_gaps:
            await save_keyword_gaps(mcp, new_gaps, source="claude_research")
        logger.info(
            "client %s: external research complete — %d keyword(s) researched, %d new gap(s) found",
            client.id, keywords_researched, len(new_gaps),
        )
