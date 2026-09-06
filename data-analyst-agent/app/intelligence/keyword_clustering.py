"""Keyword clustering + gap analysis — ported from the retired standalone
agents/clustering.py script (Node repo root) into this service, the single
intelligence layer per the platform's "one Analyst brain" principle. Pure
functions over data already fetched via MCP; no direct Postgres/GSC access
(see app/collectors/keyword_clustering.py for the orchestrating collector,
which is the only caller and the only place MCP calls happen).

Semantic clustering (sentence-transformers + AgglomerativeClustering) is
100% deterministic — the LLM never decides cluster membership, only names
and types groups that already exist, exactly as the original script did.
Every LLM call fails open (returns None/[] and logs, never raises) so one
bad response never aborts a whole site's run — same discipline as
app/llm/simple.py's call_json and the retired script's own call_llm().
"""
import logging

from app.llm.simple import call_json

logger = logging.getLogger(__name__)

DEFAULT_EMBEDDING_MODEL = "all-MiniLM-L6-v2"
DEFAULT_DISTANCE_THRESHOLD = 0.35  # cosine distance; lower = tighter/more clusters.
MIN_CLUSTER_SIZE = 2  # a single keyword isn't a "cluster" — excluded from output, not lost.
MIN_IMPRESSIONS = 1  # drop true-zero-impression rows before clustering; noise, not opportunity.
GAP_SCORE_POSITION_THRESHOLD = 20
GAP_SCORE_IMPRESSIONS_THRESHOLD = 30  # gap_score fires when position > 20 AND impressions > 30.

TOP_N_FOR_PROFILE = 50
TOP_N_PER_CLUSTER_FOR_NAMING = 8

VALID_SITE_TYPES = {"service", "product", "ecommerce", "education"}
VALID_CLUSTER_TYPES = {"service", "product", "general"}
VALID_PRIORITIES = {"high", "medium", "low"}

RESEARCH_KEYWORDS_PER_TOPIC = 20
VALID_SEARCH_INTENTS = {"informational", "commercial", "transactional"}
VALID_DIFFICULTIES = {"low", "medium", "high"}
EXTERNAL_RESEARCH_RANKING_THRESHOLD = 20  # avg_position < this = already ranking well, skip.
DIFFICULTY_TO_PRIORITY = {"low": "high", "medium": "medium", "high": "low"}

_embed_model = None


def _get_embed_model():
    """Lazy singleton — loaded once per process and reused across every
    client's run, unlike the retired script which paid this cost on every
    fresh process invocation."""
    global _embed_model
    if _embed_model is None:
        from sentence_transformers import SentenceTransformer
        _embed_model = SentenceTransformer(DEFAULT_EMBEDDING_MODEL)
    return _embed_model


# ---------------------------------------------------------------------------
# Step 1: site profile
# ---------------------------------------------------------------------------

async def profile_site(keywords: list[dict]) -> dict | None:
    top = sorted(keywords, key=lambda k: k["impressions"], reverse=True)[:TOP_N_FOR_PROFILE]
    keyword_list = "\n".join(f"- {k['keyword']} ({k['impressions']} impressions)" for k in top)
    system = (
        "You are an SEO analyst. Given a website's real top search queries, infer what the "
        "site is genuinely about. Never invent a topic, product, or industry not evidenced by "
        "the real queries given. Respond with ONLY a JSON object: "
        '{"industry": "...", "main_topics": ["...", ...], '
        '"site_type": "service"|"product"|"ecommerce"|"education"}.'
    )
    user = f"Real search queries for this site, top {len(top)} by impressions:\n{keyword_list}"
    parsed = await call_json(system, user, max_tokens=500)
    if not parsed or not parsed.get("industry"):
        return None
    site_type = parsed.get("site_type")
    main_topics = parsed.get("main_topics")
    return {
        "industry": parsed["industry"],
        "main_topics": main_topics if isinstance(main_topics, list) else [],
        "site_type": site_type if site_type in VALID_SITE_TYPES else None,
    }


# ---------------------------------------------------------------------------
# Step 2: cluster + name/type
# ---------------------------------------------------------------------------

def cluster_keywords(keywords: list[dict], distance_threshold: float = DEFAULT_DISTANCE_THRESHOLD) -> list[list[dict]]:
    if len(keywords) < MIN_CLUSTER_SIZE:
        return []
    from sklearn.cluster import AgglomerativeClustering

    model = _get_embed_model()
    texts = [k["keyword"] for k in keywords]
    embeddings = model.encode(texts, normalize_embeddings=True, show_progress_bar=False)
    labels = AgglomerativeClustering(
        n_clusters=None, distance_threshold=distance_threshold, metric="cosine", linkage="average",
    ).fit_predict(embeddings)

    groups: dict[int, list[dict]] = {}
    for label, kw in zip(labels, keywords):
        groups.setdefault(int(label), []).append(kw)
    return [g for g in groups.values() if len(g) >= MIN_CLUSTER_SIZE]


def _fallback_cluster_name(group: list[dict]) -> str:
    return sorted(group, key=lambda k: k["impressions"], reverse=True)[0]["keyword"][:60]


async def name_and_type_clusters(groups: list[list[dict]]) -> dict[int, dict]:
    """One LLM call naming+typing every cluster at once. Cluster MEMBERSHIP
    is never touched here — cluster_keywords already decided it above; the
    LLM only labels groups that already exist, from the real keywords
    already in them. Falls back to a deterministic top-keyword name +
    type='general' per group on any failure, so every group is still saved."""
    if not groups:
        return {}
    summaries = [
        {
            "index": i,
            "keywords": [k["keyword"] for k in sorted(g, key=lambda k: k["impressions"], reverse=True)[:TOP_N_PER_CLUSTER_FOR_NAMING]],
        }
        for i, g in enumerate(groups)
    ]
    system = (
        "You are an SEO analyst naming groups of already-clustered real search queries — the "
        "grouping is already done; you are only labeling it. For each group, write a short "
        "human-readable topic name (2-4 words) capturing its real theme, and classify it as "
        'one of: "service" (the site offers this as a service), "product" (a specific named '
        'product/offering), or "general" (a broad informational topic, not a specific service '
        "or product). Never invent a theme not evidenced by the real keywords given. Respond "
        'with ONLY a JSON object: {"clusters": [{"index": 0, "name": "...", '
        '"type": "service"|"product"|"general"}, ...]}, one entry per group given.'
    )
    import json
    user = f"Groups:\n{json.dumps(summaries)}"
    parsed = await call_json(system, user, max_tokens=1500)

    result: dict[int, dict] = {}
    if parsed and isinstance(parsed.get("clusters"), list):
        for c in parsed["clusters"]:
            idx = c.get("index")
            if isinstance(idx, int) and 0 <= idx < len(groups):
                ctype = c.get("type")
                result[idx] = {
                    "name": c.get("name") or _fallback_cluster_name(groups[idx]),
                    "type": ctype if ctype in VALID_CLUSTER_TYPES else "general",
                }
    for i, g in enumerate(groups):
        if i not in result:
            result[i] = {"name": _fallback_cluster_name(g), "type": "general"}
    return result


def score_cluster(group: list[dict]) -> dict:
    impressions = [float(k["impressions"]) for k in group]
    positions = [float(k["avg_position"]) for k in group if k.get("avg_position") is not None]
    avg_impressions = sum(impressions) / len(impressions)
    avg_position = (
        sum(p * i for p, i in zip(positions, impressions)) / sum(impressions)
        if positions else None
    )
    is_gap = (
        avg_position is not None
        and avg_position > GAP_SCORE_POSITION_THRESHOLD
        and avg_impressions > GAP_SCORE_IMPRESSIONS_THRESHOLD
    )
    gap_score = avg_impressions if is_gap else 0.0
    return {"avg_impressions": avg_impressions, "avg_position": avg_position, "gap_score": gap_score}


def build_cluster_rows(groups: list[list[dict]], naming: dict[int, dict]) -> list[dict]:
    rows = []
    for i, g in enumerate(groups):
        rows.append({
            "cluster_name": naming[i]["name"],
            "cluster_type": naming[i]["type"],
            "keywords_json": [
                {
                    "keyword": k["keyword"],
                    "impressions": int(k["impressions"]),
                    "avg_position": round(float(k["avg_position"]), 2) if k.get("avg_position") is not None else None,
                }
                for k in g
            ],
            **score_cluster(g),
        })
    return rows


async def filter_noise_clusters(industry: str, site_type: str | None, cluster_rows: list[dict]) -> list[dict]:
    """Flags already-built clusters clearly unrelated to the site's real
    industry/site_type via one LLM call over cluster names + real keywords.
    Fails open (returns cluster_rows unchanged) on any LLM/parse failure — a
    classification failure must never silently drop real data."""
    if not cluster_rows:
        return cluster_rows
    summaries = [
        {"cluster_name": c["cluster_name"], "keywords": [k["keyword"] for k in c["keywords_json"][:TOP_N_PER_CLUSTER_FOR_NAMING]]}
        for c in cluster_rows
    ]
    system = (
        "You are an SEO analyst reviewing already-clustered real search queries for a website. "
        f'The site\'s real industry is "{industry}" and its site_type is "{site_type}". Given the '
        "clusters below, identify which ones are clearly UNRELATED to the site's main industry — "
        "stray/irrelevant search traffic, not real topics this site is actually about. Do not flag "
        "a cluster just because it is a minor or adjacent topic; only flag ones with no real "
        'relation to the given industry. Respond with ONLY a JSON object: {"noise_clusters": '
        '["cluster_name", ...]}.'
    )
    import json
    user = f"Clusters:\n{json.dumps(summaries)}"
    parsed = await call_json(system, user, max_tokens=800)
    if not parsed or not isinstance(parsed.get("noise_clusters"), list):
        return cluster_rows

    noise_names = set(parsed["noise_clusters"])
    kept = [c for c in cluster_rows if c["cluster_name"] not in noise_names]
    if len(kept) != len(cluster_rows):
        logger.info("keyword-clustering: skipped %d noise cluster(s)", len(cluster_rows) - len(kept))
    return kept


# ---------------------------------------------------------------------------
# Step 3: keyword gap analysis
# ---------------------------------------------------------------------------

async def find_gaps(profile: dict, cluster_rows: list[dict]) -> list[dict]:
    system = (
        "You are an SEO strategist. Given a real website's inferred industry/site type and its "
        "REAL existing keyword clusters (from its actual search performance data), identify "
        "important keyword topics that are completely missing — topics a site in this real "
        "industry/category would be expected to have real coverage of but currently doesn't. "
        "Ground every suggestion in the real industry/site_type/main_topics given; never "
        "suggest a topic unrelated to this site's real category. Respond with ONLY a JSON "
        'object: {"gaps": [{"topic": "...", "reason": "...", "priority": "high"|"medium"|"low"}, ...]}.'
    )
    import json
    user = json.dumps({
        "industry": profile["industry"],
        "site_type": profile["site_type"],
        "main_topics": profile["main_topics"],
        "existing_clusters": [
            {"name": c["cluster_name"], "type": c["cluster_type"], "keyword_count": len(c["keywords_json"])}
            for c in cluster_rows
        ],
    })
    parsed = await call_json(system, user, max_tokens=1200)
    if not parsed or not isinstance(parsed.get("gaps"), list):
        return []

    gaps = []
    for g in parsed["gaps"]:
        topic = g.get("topic")
        if not topic:
            continue
        priority = g.get("priority")
        gaps.append({
            "topic": topic,
            "reason": g.get("reason"),
            "priority": priority if priority in VALID_PRIORITIES else "medium",
        })
    return gaps


# ---------------------------------------------------------------------------
# Step 4: external keyword research (runs after Steps 1-3; independent of
# them — the collector passes the profile Step 1 just produced, but never
# touches keyword_clusters or the gap rows Step 3 already saved).
# ---------------------------------------------------------------------------

async def research_topic_keywords(site_type: str | None, industry: str, topic: str) -> list[dict]:
    """Real keywords people search for one main_topic — external research,
    independent of Step 2's clustering of this site's own existing GSC
    data. Returns [] on any parse/shape failure, never raising, so one bad
    topic never stops the others."""
    system = (
        "You are a keyword research expert. Given a company's site type, industry, and one topic it "
        "offers, return the real keywords people actually search on Google when looking for this. "
        "Focus on: problem-based searches (e.g. 'how to automate bookings'), solution-based searches "
        "(e.g. 'AI booking engine software'), comparison searches (e.g. 'best booking software for "
        "clinics'), and location searches if relevant (e.g. 'booking software nepal'). Return only "
        'JSON, no other text: {"keywords": [{"keyword": "...", "search_intent": '
        '"informational"|"commercial"|"transactional", "estimated_difficulty": "low"|"medium"|"high"}, '
        f'...]}}, exactly {RESEARCH_KEYWORDS_PER_TOPIC} items.'
    )
    user = f"Company site_type: {site_type or 'unknown'}\nIndustry: {industry}\nTopic: {topic}"
    parsed = await call_json(system, user, max_tokens=1800)
    if not parsed or not isinstance(parsed.get("keywords"), list):
        logger.warning("keyword-clustering: external research got a bad/unparseable response for topic %r, skipping", topic)
        return []

    results = []
    for k in parsed["keywords"]:
        if not isinstance(k, dict):
            continue
        keyword, intent, difficulty = k.get("keyword"), k.get("search_intent"), k.get("estimated_difficulty")
        if not keyword or intent not in VALID_SEARCH_INTENTS or difficulty not in VALID_DIFFICULTIES:
            continue
        results.append({"keyword": keyword, "search_intent": intent, "estimated_difficulty": difficulty})
    return results


def _research_gap_reason(keyword: str, parent_topic: str, position: float | None, intent: str) -> str:
    """Every field used here is real evidence already on hand at the point
    this gap is written — the parent topic it was researched under, this
    site's OWN observed position for the keyword (gsc_breakdown, via
    observed_positions below) if any, and the search intent the research step
    itself classified. Replaces a single hardcoded sentence that was
    identical for all 88 claude_research-sourced gaps on Zunkiree Labs alone,
    which told the reader nothing about why THIS keyword was picked."""
    if position is None:
        return (
            f'A real {intent} search related to your "{parent_topic}" topic — no existing page currently '
            f'ranks for it at all.'
        )
    return (
        f'A real {intent} search related to your "{parent_topic}" topic — you already rank #{position:.0f}, '
        f'well outside striking distance, so this needs a stronger page rather than a first one.'
    )


def gaps_from_research(
    topic: str, researched: list[dict], observed_positions: dict[str, float], seen_this_run: set[str],
) -> list[dict]:
    """observed_positions: {lowercased keyword: avg_position} — this site's
    own real gsc_breakdown data for the researched keywords (see the
    collector's own MCP fetch). A keyword absent from that dict has no
    coverage at all.

    seen_this_run is mutated in place and guards ONLY against emitting the
    same keyword twice within a single run (Step 3's clustering gaps, plus
    earlier topics in this same loop). It deliberately does NOT include
    topics already persisted in previous runs.

    That distinction is the whole point. This function used to be handed the
    set of already-persisted gaps and skipped anything in it, on the reasoning
    that re-emitting a known topic would create a duplicate row. It doesn't —
    saveKeywordGaps (server/store/data-analyst.js) upserts on migration 129's
    partial unique index and treats a re-sight as a re-observation. Filtering
    here meant save_keyword_gaps was never called for a topic after its first
    week, so its observation_count could never leave 1, while
    qualifyAndShipContentGaps (server/agents/lib/analyst-seo-mapping.js)
    requires >= 2 before a gap may ship. Every research-sourced opportunity
    was therefore permanently unshippable — 111 of site 1's 118 rows sat at
    exactly 1 observation for this reason.

    Re-emitting a still-relevant researched topic is a genuine re-observation:
    the LLM surfaced it again this cycle AND it still fails the coverage test
    below. Repeats within one calendar week do not inflate the count —
    migration 143's last_observed_week gates the increment to one per week.
    """
    new_gaps = []
    for r in researched:
        keyword_lower = r["keyword"].lower()
        position = observed_positions.get(keyword_lower)
        if position is not None and position < EXTERNAL_RESEARCH_RANKING_THRESHOLD:
            continue  # already ranking well — no longer a gap, so not re-observed either
        if keyword_lower in seen_this_run:
            continue  # emitted already by this same run — one observation per run, not per topic-loop
        new_gaps.append({
            "topic": r["keyword"],
            "reason": _research_gap_reason(r["keyword"], topic, position, r["search_intent"]),
            "priority": DIFFICULTY_TO_PRIORITY[r["estimated_difficulty"]],
        })
        seen_this_run.add(keyword_lower)
    return new_gaps
