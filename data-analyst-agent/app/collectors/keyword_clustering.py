"""Keyword clustering + gap analysis collector — the in-service replacement
for the retired standalone agents/clustering.py script (Node repo root).
Runs as an ordinary nightly collector (registry.py), but internally skips
real work unless it's actually due: clustering is expensive (embeddings +
several LLM calls) and only meaningful on a ~14-day cadence, unlike the
metric collectors around it which genuinely have new data every day. Cadence
is read from the site's own profiled_at via MCP (get_site_profile) rather
than any local state, so it survives this service restarting or a client
being re-added.

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
RECLUSTER_INTERVAL_DAYS = 14
KEYWORD_FETCH_LIMIT = 2000  # see mcp-server/tools/read-only.js's get_gsc_breakdown cap


class KeywordClusteringCollector(Collector):
    collector_id = "keyword_clustering"
    metric_keys: list[str] = []  # doesn't feed metric_observations at all
    writes_own_storage = True

    async def collect(self, *, session, client, mcp, window_start: date, window_end: date) -> list[Observation]:
        profile = await get_site_profile(mcp)
        if profile and profile.get("profiled_at"):
            profiled_at = date.fromisoformat(profile["profiled_at"][:10])
            if (window_end - profiled_at).days < RECLUSTER_INTERVAL_DAYS:
                logger.info("client %s: keyword clustering not due yet (last run %s)", client.id, profiled_at)
                return []

        since = window_end - timedelta(days=WINDOW_DAYS)
        rows = await get_gsc_breakdown(mcp, since.isoformat(), window_end.isoformat(), "query", KEYWORD_FETCH_LIMIT)
        keywords = [
            {"keyword": r["dim_value"], "impressions": r["impressions"], "avg_position": r.get("avg_position")}
            for r in rows
            if r.get("impressions") is not None and r["impressions"] >= ic.MIN_IMPRESSIONS
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
            await self._run_external_research(mcp, client, new_profile, keywords, gaps)

        return []

    async def _run_external_research(self, mcp, client, profile: dict, keywords: list[dict], step3_gaps: list[dict]) -> None:
        """Step 4 — independent of Steps 1-3 above beyond reusing the
        profile just produced and this run's own already-fetched keyword
        set (in place of the retired script's second DB round-trip for
        position lookups — see the module docstring)."""
        existing = await get_keyword_gaps(mcp)
        existing_topics = {g["topic"].lower() for g in existing} | {g["topic"].lower() for g in step3_gaps}
        observed_positions = {k["keyword"].lower(): k["avg_position"] for k in keywords if k.get("avg_position") is not None}

        keywords_researched = 0
        new_gaps: list[dict] = []
        for topic in profile["main_topics"]:
            researched = await ic.research_topic_keywords(profile["site_type"], profile["industry"], topic)
            keywords_researched += len(researched)
            if not researched:
                continue
            new_gaps.extend(ic.gaps_from_research(topic, researched, observed_positions, existing_topics))

        if new_gaps:
            await save_keyword_gaps(mcp, new_gaps, source="claude_research")
        logger.info(
            "client %s: external research complete — %d keyword(s) researched, %d new gap(s) found",
            client.id, keywords_researched, len(new_gaps),
        )
