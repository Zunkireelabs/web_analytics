"""Standalone, multi-tenant, fully dynamic keyword intelligence agent.

No hardcoded client names, industries, or keyword taxonomies anywhere in this
file — every site is understood from its own real GSC data plus an LLM,
independent of which client it is. (An earlier version of this script had a
hand-written per-client product/service taxonomy; this replaces it entirely.)

For every active site (sites.status = 'active'):

  Step 1 — Understand the site
    Reads the last N days (default 90) of gsc_breakdown query data, sends its
    top 50 keywords by impressions to the LLM, and asks for industry / main
    topics / site_type. Saved to site_profiles (current-state row, upserted
    each run).

  Step 2 — Cluster existing keywords
    Groups ALL of the site's real keywords with sentence-transformers +
    AgglomerativeClustering (the semantic grouping is 100% deterministic —
    the LLM never decides cluster membership, only what to call the group
    and what type it is, given the real keywords already in it). Saved to
    keyword_clusters (append-only snapshot per run).

  Step 3 — Find missing keyword opportunities
    Sends the site profile + the clusters just computed to the LLM and asks
    what important topics have zero real coverage. Saved to keyword_gaps as
    status='pending_review' — a human-review queue, nothing here is
    auto-applied.

Multi-tenant isolation: every query is scoped to a single site_id, one site
is fully profiled/clustered/gapped/saved before the next one starts, and
every insert is tagged with that same site_id. No keyword list, embedding
batch, or LLM prompt ever mixes data from two sites.

Independent of server/agents/growth-queries.js, server/agents/opportunity.js,
and any MCP tool: no shared table, no shared code, connects to Postgres and
the LLM provider directly.

Usage:
    python agents/clustering.py                  # every active site
    python agents/clustering.py --site-id 3
    python agents/clustering.py --days 90 --distance-threshold 0.35

Intended cadence: every 14 days, run once per site (this script already
loops per-site internally). Not wired into any existing scheduler here — add
e.g. `0 3 */14 * *` to whichever cron / scheduled-job runner this ends up
deployed behind.

LLM provider: auto-selected exactly like server/llm.js's own pickProvider() —
a real OPENAI_API_KEY present -> OpenAI, else Anthropic. Force with
CLUSTERING_LLM_PROVIDER=openai|anthropic.

Env:
    DATABASE_URL          postgresql connection string — the same Neon DB
                           the rest of the app uses (sites/gsc_breakdown are
                           defined in server/migrations/001_init.sql).
    OPENAI_API_KEY         same key the Node app already uses; takes
                           precedence when present (see provider note above).
    ANTHROPIC_API_KEY      same key server/llm.js already uses for Anthropic.
    CLUSTERING_LLM_PROVIDER   optional override: openai | anthropic.
    CLUSTERING_LLM_MODEL      optional override of the resolved provider's
                           default model (gpt-4o-mini / claude-haiku-4-5 —
                           same "cheap/frequent task" tier server/llm.js
                           itself defaults to for its daily calls).
"""
import argparse
import json
import os
import re
import sys
from datetime import date, timedelta

import psycopg2
import psycopg2.extras
from anthropic import Anthropic
from openai import OpenAI
from sentence_transformers import SentenceTransformer
from sklearn.cluster import AgglomerativeClustering

DEFAULT_DAYS = 90
DEFAULT_EMBEDDING_MODEL = "all-MiniLM-L6-v2"
DEFAULT_DISTANCE_THRESHOLD = 0.35  # cosine distance; lower = tighter/more clusters. Primary tuning knob.
MIN_CLUSTER_SIZE = 2  # a single keyword isn't a "cluster" — excluded from output, not lost (still in gsc_breakdown).
MIN_IMPRESSIONS = 1  # drop true-zero-impression rows before clustering; they're noise, not opportunities.
GAP_SCORE_POSITION_THRESHOLD = 20
GAP_SCORE_IMPRESSIONS_THRESHOLD = 30  # gap_score fires when position > 20 OR impressions > 30.
TOP_N_FOR_PROFILE = 50
TOP_N_PER_CLUSTER_FOR_NAMING = 8  # keywords shown to the LLM per cluster when naming — bounds prompt size on large clusters.

VALID_SITE_TYPES = {"service", "product", "ecommerce", "education"}
VALID_CLUSTER_TYPES = {"service", "product", "general"}
VALID_PRIORITIES = {"high", "medium", "low"}

# Step 4 — external keyword research
RESEARCH_KEYWORDS_PER_TOPIC = 20
VALID_SEARCH_INTENTS = {"informational", "commercial", "transactional"}
VALID_DIFFICULTIES = {"low", "medium", "high"}
EXTERNAL_RESEARCH_RANKING_THRESHOLD = 20  # avg_position < this = already ranking well, skip; >= or missing = gap.
DIFFICULTY_TO_PRIORITY = {"low": "high", "medium": "medium", "high": "low"}  # easier keyword = higher priority to chase

# Same "daily" tier server/llm.js's own MODEL_DEFAULTS use for frequent,
# lower-stakes calls — this script's calls are exactly that (structured
# JSON extraction, not deep reasoning).
MODEL_DEFAULTS = {"openai": "gpt-4o-mini", "anthropic": "claude-haiku-4-5"}


def pick_provider():
    """Same precedence as server/llm.js's pickProvider(): a real
    OPENAI_API_KEY wins over Anthropic when both are set. Force with
    CLUSTERING_LLM_PROVIDER=openai|anthropic."""
    forced = os.environ.get("CLUSTERING_LLM_PROVIDER")
    if forced:
        return forced.lower()
    oa = os.environ.get("OPENAI_API_KEY")
    if oa and not oa.startswith("sk-xxxx"):
        return "openai"
    return "anthropic"


def make_llm_client(provider):
    if provider == "openai":
        return OpenAI(api_key=os.environ.get("OPENAI_API_KEY"))
    return Anthropic(api_key=os.environ.get("ANTHROPIC_API_KEY"))


def _parse_json_response(raw):
    if not raw:
        return None
    cleaned = re.sub(r"^```(?:json)?\s*|\s*```$", "", raw.strip())
    try:
        return json.loads(cleaned)
    except (json.JSONDecodeError, TypeError):
        return None


def call_llm(provider, client, system, user, max_tokens):
    """Every caller treats a None return as 'skip this step for this site' —
    same fail-honestly-not-fabricate discipline as server/agents' own
    callLLM().catch(() => null) call sites. One bad response must never
    crash the whole multi-site run."""
    model = os.environ.get("CLUSTERING_LLM_MODEL") or MODEL_DEFAULTS[provider]
    try:
        if provider == "openai":
            resp = client.chat.completions.create(
                model=model, max_tokens=max_tokens,
                messages=[{"role": "system", "content": system}, {"role": "user", "content": user}],
            )
            return (resp.choices[0].message.content or "").strip()
        resp = client.messages.create(
            model=model, max_tokens=max_tokens, system=system,
            messages=[{"role": "user", "content": user}],
        )
        return "".join(b.text for b in resp.content if getattr(b, "type", None) == "text").strip()
    except Exception as e:  # noqa: BLE001 — any SDK/network failure reports honestly, never fabricates a result
        print(f"  [warn] LLM call failed: {e}", file=sys.stderr)
        return None


# ---------------------------------------------------------------------------
# Step 1: site profile
# ---------------------------------------------------------------------------

def profile_site(provider, client, keywords):
    top = sorted(keywords, key=lambda k: k["impressions"], reverse=True)[:TOP_N_FOR_PROFILE]
    keyword_list = "\n".join(f"- {k['keyword']} ({k['impressions']} impressions)" for k in top)
    system = (
        "You are an SEO analyst. Given a website's real top search queries, infer what the "
        "site is genuinely about. Never invent a topic, product, or industry not evidenced by "
        "the real queries given. Respond with ONLY a JSON object: "
        '{"industry": "...", "main_topics": ["...", ...], '
        '"site_type": "service"|"product"|"ecommerce"|"education"}.'
    )
    user = f"Real search queries for this site, last {DEFAULT_DAYS} days, top {len(top)} by impressions:\n{keyword_list}"
    parsed = _parse_json_response(call_llm(provider, client, system, user, max_tokens=500))
    if not parsed or not parsed.get("industry"):
        return None
    site_type = parsed.get("site_type")
    main_topics = parsed.get("main_topics")
    return {
        "industry": parsed["industry"],
        "main_topics": main_topics if isinstance(main_topics, list) else [],
        "site_type": site_type if site_type in VALID_SITE_TYPES else None,
    }


def save_profile(conn, site_id, profile):
    with conn.cursor() as cur:
        cur.execute(
            """
            INSERT INTO site_profiles (site_id, industry, main_topics_json, site_type, profiled_at)
            VALUES (%s, %s, %s, %s, now())
            ON CONFLICT (site_id) DO UPDATE SET
                industry = EXCLUDED.industry,
                main_topics_json = EXCLUDED.main_topics_json,
                site_type = EXCLUDED.site_type,
                profiled_at = EXCLUDED.profiled_at
            """,
            (site_id, profile["industry"], json.dumps(profile["main_topics"]), profile["site_type"]),
        )
    conn.commit()


# ---------------------------------------------------------------------------
# Step 2: cluster + name/type
# ---------------------------------------------------------------------------

def fetch_keywords(conn, site_id, since):
    """Per-keyword aggregates over the window, scoped to exactly one site_id.
    Position is impression-weighted — same averaging convention
    data-analyst-agent's metrics_catalog already uses for gsc_position
    (weighted_avg against gsc_impressions; see 0001_initial_schema.py
    row("gsc_position", ...))."""
    with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
        cur.execute(
            """
            SELECT
                dim_value AS keyword,
                SUM(impressions) AS impressions,
                CASE WHEN SUM(impressions) > 0
                     THEN SUM(position * impressions) / SUM(impressions)
                     ELSE NULL END AS avg_position
            FROM gsc_breakdown
            WHERE site_id = %s AND dim_type = 'query' AND date >= %s
                AND impressions IS NOT NULL AND position IS NOT NULL
            GROUP BY dim_value
            HAVING SUM(impressions) >= %s
            """,
            (site_id, since, MIN_IMPRESSIONS),
        )
        return [dict(r) for r in cur.fetchall()]


def cluster_keywords(keywords, model, distance_threshold):
    if len(keywords) < MIN_CLUSTER_SIZE:
        return []
    texts = [k["keyword"] for k in keywords]
    embeddings = model.encode(texts, normalize_embeddings=True, show_progress_bar=False)
    labels = AgglomerativeClustering(
        n_clusters=None, distance_threshold=distance_threshold, metric="cosine", linkage="average",
    ).fit_predict(embeddings)

    groups = {}
    for label, kw in zip(labels, keywords):
        groups.setdefault(int(label), []).append(kw)
    return [g for g in groups.values() if len(g) >= MIN_CLUSTER_SIZE]


def _fallback_cluster_name(group):
    return sorted(group, key=lambda k: k["impressions"], reverse=True)[0]["keyword"][:60]


def name_and_type_clusters(provider, client, groups):
    """One LLM call naming+typing every cluster at once. Cluster MEMBERSHIP
    is never touched here — sentence-transformers/AgglomerativeClustering
    already decided it above; the LLM only labels groups that already exist,
    from the real keywords already in them. Falls back to a deterministic
    top-keyword name + type='general' per group on any failure or missing
    index, so every group is still saved."""
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
    user = f"Groups:\n{json.dumps(summaries)}"
    parsed = _parse_json_response(call_llm(provider, client, system, user, max_tokens=1500))

    result = {}
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


def score_cluster(group):
    impressions = [float(k["impressions"]) for k in group]
    positions = [float(k["avg_position"]) for k in group if k["avg_position"] is not None]
    avg_impressions = sum(impressions) / len(impressions)
    avg_position = (
        sum(p * i for p, i in zip(positions, impressions)) / sum(impressions)
        if positions else None
    )
    is_gap = (
        avg_position is not None
        and (avg_position > GAP_SCORE_POSITION_THRESHOLD or avg_impressions > GAP_SCORE_IMPRESSIONS_THRESHOLD)
    )
    gap_score = avg_impressions if is_gap else 0.0
    return {"avg_impressions": avg_impressions, "avg_position": avg_position, "gap_score": gap_score}


def build_cluster_rows(groups, naming):
    rows = []
    for i, g in enumerate(groups):
        rows.append({
            "cluster_name": naming[i]["name"],
            "cluster_type": naming[i]["type"],
            "keywords_json": [
                {
                    "keyword": k["keyword"],
                    "impressions": int(k["impressions"]),
                    "avg_position": round(float(k["avg_position"]), 2) if k["avg_position"] is not None else None,
                }
                for k in g
            ],
            **score_cluster(g),
        })
    return rows


def filter_noise_clusters(provider, client, industry, site_type, cluster_rows):
    """Flags already-built clusters that are clearly unrelated to the site's
    real industry/site_type (e.g. stray GSC traffic like an unrelated court
    system or age-inquiry query landing in the data) via a single LLM call
    over the cluster names + their real keywords. Cluster membership/naming
    above is never touched here — this only decides whether a whole
    already-built cluster gets saved at all. Fails open (returns cluster_rows
    unchanged) on any LLM/parse failure, same discipline as the rest of this
    script — a classification failure must never silently drop real data."""
    if not cluster_rows:
        return cluster_rows
    summaries = [
        {
            "cluster_name": c["cluster_name"],
            "keywords": [k["keyword"] for k in c["keywords_json"][:TOP_N_PER_CLUSTER_FOR_NAMING]],
        }
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
    user = f"Clusters:\n{json.dumps(summaries)}"
    parsed = _parse_json_response(call_llm(provider, client, system, user, max_tokens=800))
    if not parsed or not isinstance(parsed.get("noise_clusters"), list):
        return cluster_rows

    noise_names = set(parsed["noise_clusters"])
    kept = []
    for c in cluster_rows:
        if c["cluster_name"] in noise_names:
            print(f"  skipped_noise_cluster: {c['cluster_name']}")
        else:
            kept.append(c)
    return kept


def save_clusters(conn, site_id, clusters):
    with conn.cursor() as cur:
        for c in clusters:
            cur.execute(
                """
                INSERT INTO keyword_clusters
                    (site_id, cluster_name, cluster_type, keywords_json, avg_impressions, avg_position, gap_score)
                VALUES (%s, %s, %s, %s, %s, %s, %s)
                """,
                (
                    site_id, c["cluster_name"], c["cluster_type"], json.dumps(c["keywords_json"]),
                    c["avg_impressions"], c["avg_position"], c["gap_score"],
                ),
            )
    conn.commit()


# ---------------------------------------------------------------------------
# Step 3: keyword gap analysis
# ---------------------------------------------------------------------------

def find_gaps(provider, client, profile, cluster_rows):
    system = (
        "You are an SEO strategist. Given a real website's inferred industry/site type and its "
        "REAL existing keyword clusters (from its actual search performance data), identify "
        "important keyword topics that are completely missing — topics a site in this real "
        "industry/category would be expected to have real coverage of but currently doesn't. "
        "Ground every suggestion in the real industry/site_type/main_topics given; never "
        "suggest a topic unrelated to this site's real category. Respond with ONLY a JSON "
        'object: {"gaps": [{"topic": "...", "reason": "...", "priority": "high"|"medium"|"low"}, ...]}.'
    )
    user = json.dumps({
        "industry": profile["industry"],
        "site_type": profile["site_type"],
        "main_topics": profile["main_topics"],
        "existing_clusters": [
            {"name": c["cluster_name"], "type": c["cluster_type"], "keyword_count": len(c["keywords_json"])}
            for c in cluster_rows
        ],
    })
    parsed = _parse_json_response(call_llm(provider, client, system, user, max_tokens=1200))
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


def save_gaps(conn, site_id, gaps):
    with conn.cursor() as cur:
        for g in gaps:
            cur.execute(
                """
                INSERT INTO keyword_gaps (site_id, topic, reason, priority, status)
                VALUES (%s, %s, %s, %s, 'pending_review')
                """,
                (site_id, g["topic"], g["reason"], g["priority"]),
            )
    conn.commit()


# ---------------------------------------------------------------------------
# Step 4: external keyword research (runs after Steps 1-3 above; independent
# of them — reads site_profiles fresh from the DB rather than reusing the
# in-memory profile from Step 1, and never touches keyword_clusters or the
# gap rows Step 3 already saved).
# ---------------------------------------------------------------------------

def fetch_site_profile(conn, site_id):
    with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
        cur.execute(
            "SELECT industry, main_topics_json, site_type FROM site_profiles WHERE site_id = %s",
            (site_id,),
        )
        row = cur.fetchone()
    if not row or not row.get("industry"):
        return None
    main_topics = row.get("main_topics_json")
    return {
        "industry": row["industry"],
        "main_topics": main_topics if isinstance(main_topics, list) else [],
        "site_type": row.get("site_type"),
    }


def research_topic_keywords(provider, client, site_type, industry, topic):
    """Asks the LLM for real keywords people search for this one main_topic
    — external research, independent of Step 2's clustering of this site's
    own existing GSC data. Returns [] and logs a warning on any parse/shape
    failure, never raising, so one bad topic never stops the others."""
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
    parsed = _parse_json_response(call_llm(provider, client, system, user, max_tokens=1800))
    if not parsed or not isinstance(parsed.get("keywords"), list):
        print(f"  [warn] external research: bad/unparseable response for topic '{topic}', skipping", file=sys.stderr)
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


def fetch_gsc_positions(conn, site_id, since, keywords):
    """Batch-checks a topic's researched keywords against this site's own
    real gsc_breakdown data (case-insensitive, since LLM-generated keywords
    may not match GSC's own casing exactly). Returns {lowercased keyword:
    avg_position} only for keywords with real impression data — a keyword
    absent from the returned dict has no coverage at all."""
    if not keywords:
        return {}
    with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
        cur.execute(
            """
            SELECT lower(dim_value) AS keyword,
                   SUM(position * impressions) / SUM(impressions) AS avg_position
            FROM gsc_breakdown
            WHERE site_id = %s AND dim_type = 'query' AND date >= %s
                AND lower(dim_value) = ANY(%s) AND impressions IS NOT NULL AND position IS NOT NULL
            GROUP BY lower(dim_value)
            HAVING SUM(impressions) > 0
            """,
            (site_id, since, [k.lower() for k in keywords]),
        )
        return {r["keyword"]: float(r["avg_position"]) for r in cur.fetchall()}


def existing_gap_topics(conn, site_id):
    with conn.cursor() as cur:
        cur.execute("SELECT lower(topic) FROM keyword_gaps WHERE site_id = %s", (site_id,))
        return {row[0] for row in cur.fetchall()}


def save_external_gaps(conn, site_id, gaps):
    with conn.cursor() as cur:
        for g in gaps:
            cur.execute(
                """
                INSERT INTO keyword_gaps (site_id, topic, reason, priority, status, source)
                VALUES (%s, %s, %s, %s, 'pending_review', 'claude_research')
                """,
                (site_id, g["topic"], g["reason"], g["priority"]),
            )
    conn.commit()


def run_external_keyword_research(conn, provider, llm_client, site_id, since):
    profile = fetch_site_profile(conn, site_id)
    if not profile or not profile["main_topics"]:
        print(f"site {site_id}: no site_profile main_topics available, skipping external keyword research")
        return

    existing_topics = existing_gap_topics(conn, site_id)  # updated in-loop too, so cross-topic dupes in this same run are also caught
    keywords_researched = 0
    new_gaps = []

    for topic in profile["main_topics"]:
        results = research_topic_keywords(provider, llm_client, profile["site_type"], profile["industry"], topic)
        keywords_researched += len(results)
        if not results:
            continue

        positions = fetch_gsc_positions(conn, site_id, since, [r["keyword"] for r in results])
        for r in results:
            keyword_lower = r["keyword"].lower()
            position = positions.get(keyword_lower)
            if position is not None and position < EXTERNAL_RESEARCH_RANKING_THRESHOLD:
                continue  # already ranking well — not a gap
            if keyword_lower in existing_topics:
                continue  # already flagged (Step 3 or an earlier topic this run) — never duplicate
            new_gaps.append({
                "topic": r["keyword"],
                "reason": "People search this but you rank poorly/not at all",
                "priority": DIFFICULTY_TO_PRIORITY[r["estimated_difficulty"]],
            })
            existing_topics.add(keyword_lower)

    if new_gaps:
        save_external_gaps(conn, site_id, new_gaps)

    print(f"External research complete: {keywords_researched} keywords researched, {len(new_gaps)} new gaps found")


# ---------------------------------------------------------------------------
# Orchestration
# ---------------------------------------------------------------------------

def run_for_site(conn, provider, llm_client, embed_model, site_id, days, distance_threshold):
    since = date.today() - timedelta(days=days)
    keywords = fetch_keywords(conn, site_id, since)  # scoped to this site_id only — never touches another site's rows
    if not keywords:
        print(f"site {site_id}: no keyword data in the last {days} days, skipping")
        return

    profile = profile_site(provider, llm_client, keywords)
    if profile:
        save_profile(conn, site_id, profile)

    groups = cluster_keywords(keywords, embed_model, distance_threshold)
    naming = name_and_type_clusters(provider, llm_client, groups)
    cluster_rows = build_cluster_rows(groups, naming)
    if profile:
        cluster_rows = filter_noise_clusters(provider, llm_client, profile["industry"], profile["site_type"], cluster_rows)
    save_clusters(conn, site_id, cluster_rows)  # every row tagged this site_id — no cross-site writes possible

    gaps = []
    if profile and cluster_rows:
        gaps = find_gaps(provider, llm_client, profile, cluster_rows)
        save_gaps(conn, site_id, gaps)

    print(
        f"site {site_id}: profile={'ok' if profile else 'failed'}, "
        f"{len(cluster_rows)} cluster(s) saved, {len(gaps)} gap(s) flagged for review"
    )

    run_external_keyword_research(conn, provider, llm_client, site_id, since)


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--site-id", type=int, default=None, help="Single site; default runs every active site.")
    parser.add_argument("--days", type=int, default=DEFAULT_DAYS)
    parser.add_argument("--distance-threshold", type=float, default=DEFAULT_DISTANCE_THRESHOLD)
    parser.add_argument("--embedding-model", default=DEFAULT_EMBEDDING_MODEL)
    args = parser.parse_args()

    database_url = os.environ.get("DATABASE_URL")
    if not database_url:
        sys.exit("DATABASE_URL is not set.")

    provider = pick_provider()
    key_var = "OPENAI_API_KEY" if provider == "openai" else "ANTHROPIC_API_KEY"
    if not os.environ.get(key_var):
        sys.exit(f"Resolved LLM provider is '{provider}' but {key_var} is not set.")
    llm_client = make_llm_client(provider)
    print(f"LLM provider: {provider} ({os.environ.get('CLUSTERING_LLM_MODEL') or MODEL_DEFAULTS[provider]})")

    conn = psycopg2.connect(database_url)
    try:
        with conn.cursor() as cur:
            if args.site_id is not None:
                cur.execute("SELECT id FROM sites WHERE id = %s AND status = 'active'", (args.site_id,))
            else:
                cur.execute("SELECT id FROM sites WHERE status = 'active' ORDER BY id")
            site_ids = [row[0] for row in cur.fetchall()]
        if not site_ids:
            sys.exit("No matching active site(s) found.")

        print(f"Loading embedding model {args.embedding_model}...")
        embed_model = SentenceTransformer(args.embedding_model)

        for site_id in site_ids:
            run_for_site(conn, provider, llm_client, embed_model, site_id, args.days, args.distance_threshold)
    finally:
        conn.close()


if __name__ == "__main__":
    main()
