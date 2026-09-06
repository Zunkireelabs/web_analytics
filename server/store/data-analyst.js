import { query } from '../db.js';

// Reads against data-analyst-agent's own tables (forecast_runs/forecast_points,
// analyst_recommendations, anomalies) — now in this same Neon database since
// the schema merge. client_id there is the same id space as sites.id here by
// convention (no cross-DB FK was ever possible before the merge; see
// data-analyst-agent/app/db/models.py's Client model).

// forecast_runs is append-only per nightly run (one row per metric per run) —
// this always takes the latest 'ok' run per metric_key, never an older
// snapshot. days bounds how far out the returned forecast horizon extends
// (target_period <= today + days), not how far back the run itself was
// generated. dimension_type/dimension_value default to site-level ('site',
// '__site__') — this tool doesn't expose per-device/per-page forecasts.
export async function getForecasts(siteId, metric, days) {
  const { rows } = await query(
    `SELECT fr.metric_key AS metric,
            fp.point_estimate AS predicted_value,
            fp.lower_bound AS confidence_low,
            fp.upper_bound AS confidence_high,
            fr.model AS model_used,
            to_char(fp.target_period, 'YYYY-MM-DD') AS forecast_date
       FROM forecast_runs fr
       JOIN forecast_points fp ON fp.forecast_run_id = fr.id
      WHERE fr.id IN (
              SELECT DISTINCT ON (metric_key) id
                FROM forecast_runs
               WHERE client_id = $1 AND status = 'ok'
                 AND dimension_type = 'site' AND dimension_value = '__site__'
                 AND ($2::text IS NULL OR metric_key = $2)
               ORDER BY metric_key, generated_at DESC
            )
        AND ($3::int IS NULL OR fp.target_period <= CURRENT_DATE + ($3::int * INTERVAL '1 day'))
      ORDER BY fr.metric_key, fp.target_period`,
    [siteId, metric || null, days ?? null]
  );
  return rows;
}

export async function getAnomalyAlerts(siteId, limit = 20) {
  const { rows } = await query(
    `SELECT metric_key, value, method, score, threshold_used, direction, created_at
       FROM anomalies
      WHERE client_id = $1
      ORDER BY created_at DESC
      LIMIT $2`,
    [siteId, limit]
  );
  return rows;
}

export async function getSiteProfile(siteId) {
  const { rows } = await query(
    `SELECT industry, main_topics_json AS main_topics, site_type, profiled_at
       FROM site_profiles
      WHERE site_id = $1`,
    [siteId]
  );
  return rows[0] || null;
}

// Upsert — one current-state row per site, same convention clustering used
// as a standalone script (agents/clustering.py, now retired: this logic
// lives in data-analyst-agent/app/collectors/keyword_clustering.py, reached
// only via the 'save_site_profile' MCP tool, never a direct DB write from
// Python — see app/mcp_client/client.py's own "ONLY interface" rule).
export async function saveSiteProfile(siteId, { industry, mainTopics, siteType }) {
  await query(
    `INSERT INTO site_profiles (site_id, industry, main_topics_json, site_type, profiled_at)
     VALUES ($1, $2, $3, $4, now())
     ON CONFLICT (site_id) DO UPDATE SET
       industry = EXCLUDED.industry,
       main_topics_json = EXCLUDED.main_topics_json,
       site_type = EXCLUDED.site_type,
       profiled_at = EXCLUDED.profiled_at`,
    [siteId, industry, JSON.stringify(mainTopics || []), siteType || null]
  );
}

// Append-only per run — same convention getKeywordClusters already reads
// (ORDER BY created_at DESC, no dedup to "latest run only").
export async function saveKeywordClusters(siteId, clusters) {
  for (const c of clusters) {
    await query(
      `INSERT INTO keyword_clusters
         (site_id, cluster_name, cluster_type, keywords_json, avg_impressions, avg_position, gap_score)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [siteId, c.clusterName, c.clusterType, JSON.stringify(c.keywords || []), c.avgImpressions, c.avgPosition ?? null, c.gapScore ?? 0]
    );
  }
}

// source distinguishes the clustering-based gap pass ('internal_analysis',
// the default) from the external keyword-research pass ('claude_research')
// — see GAP_STATUS_TO_DB's sibling comment above and migration
// 082_keyword_gaps_source.sql.
//
// Upsert-on-resight for still-pending topics (migration 129's partial unique
// index on (site_id, topic) WHERE status='pending_review'): a topic the
// weekly discovery pass finds again bumps observation_count and last_seen_at
// on the SAME row rather than creating a duplicate, so
// qualifyAndShipContentGaps (analyst-seo-mapping.js) can require 2+
// observations before a gap is even eligible to ship. A gap a human already
// accepted/dismissed falls outside the partial index, so a resighting there
// inserts a fresh row exactly as before — re-approval/re-dismissal behavior
// is unchanged.
// observation_count counts DISTINCT WEEKS a topic was genuinely re-observed,
// not raw calls to this function (migration 143). The increment is gated on
// last_observed_week strictly advancing, which matters for two reasons:
//
//   - The nightly pipeline is not guaranteed to run exactly once a day.
//     Staging runs it twice (an in-process APScheduler at 03:00 UTC and a host
//     crontab at 22:00 UTC, both executing the same run_nightly(), with no lock
//     between them). Unlike metric_observations' absolute-value upsert, `+ 1`
//     is destructive under a double run.
//   - The research pass now re-submits topics it has already seen, rather than
//     filtering them out (data-analyst-agent/app/intelligence/keyword_clustering.py's
//     gaps_from_research). That filtering was what deadlocked research-sourced
//     gaps at observation_count = 1 forever, below
//     qualifyAndShipContentGaps's `>= 2` threshold. Now that re-sights reach
//     this function, the week gate is what keeps the count honest instead of
//     letting it drift into "number of times any job happened to run."
//
// discoveryWeek defaults to the current ISO-week Monday computed in SQL rather
// than in the caller, so two processes on different hosts (or one with a skewed
// clock) can't disagree about which week they're writing.
export async function saveKeywordGaps(siteId, gaps, source = 'internal_analysis', { discoveryWeek = null } = {}) {
  for (const g of gaps) {
    await query(
      `INSERT INTO keyword_gaps (site_id, topic, reason, priority, status, source,
                                 first_discovery_week, last_observed_week)
       VALUES ($1, $2, $3, $4, 'pending_review', $5,
               COALESCE($6::date, (date_trunc('week', now() AT TIME ZONE 'UTC'))::date),
               COALESCE($6::date, (date_trunc('week', now() AT TIME ZONE 'UTC'))::date))
       ON CONFLICT (site_id, topic) WHERE status = 'pending_review' DO UPDATE SET
         last_seen_at = now(),
         observation_count = keyword_gaps.observation_count
           + (CASE WHEN EXCLUDED.last_observed_week > COALESCE(keyword_gaps.last_observed_week, DATE '0001-01-01')
                   THEN 1 ELSE 0 END),
         last_observed_week = GREATEST(EXCLUDED.last_observed_week,
                                       COALESCE(keyword_gaps.last_observed_week, EXCLUDED.last_observed_week)),
         reason = COALESCE(EXCLUDED.reason, keyword_gaps.reason)`,
      [siteId, g.topic, g.reason || null, g.priority || 'medium', source, discoveryWeek]
    );
  }
}

export async function getKeywordClusters(siteId, clusterType) {
  const { rows } = await query(
    `SELECT cluster_name, cluster_type, keywords_json, avg_impressions, avg_position, gap_score
       FROM keyword_clusters
      WHERE site_id = $1 AND ($2::text IS NULL OR cluster_type = $2)
      ORDER BY created_at DESC`,
    [siteId, clusterType || null]
  );
  return rows;
}

// MCP-facing status vocabulary (pending_review/approved/rejected) is
// translated to the real column's values (pending_review/accepted/dismissed)
// here — the DB's CHECK constraint (migration 081) only allows the latter.
const GAP_STATUS_TO_DB = { pending_review: 'pending_review', approved: 'accepted', rejected: 'dismissed' };
const GAP_STATUS_FROM_DB = { pending_review: 'pending_review', accepted: 'approved', dismissed: 'rejected' };

export async function getKeywordGaps(siteId, status) {
  const { rows } = await query(
    `SELECT id, topic, reason, priority, status, source, search_intent, product_relevance, existing_page_match,
            first_seen_at, last_seen_at, observation_count, evidence_snapshots, created_at,
            -- ::text deliberately. node-postgres parses a DATE into a JS Date at
            -- LOCAL midnight, so in any positive-offset timezone (this app runs
            -- Asia/Kolkata) reading its UTC components yields the PREVIOUS day —
            -- which for a Monday-based week boundary silently means the previous
            -- WEEK. qualifyAndShipContentGaps compares these against an ISO week
            -- string, and a week-boundary comparison that is off by one day is
            -- exactly the bug that would let a gap discovered this Monday ship on
            -- that same Monday. Keeping them as 'YYYY-MM-DD' text makes the
            -- comparison lexicographic and timezone-free.
            first_discovery_week::text AS first_discovery_week,
            last_observed_week::text   AS last_observed_week
       FROM keyword_gaps
      WHERE site_id = $1 AND ($2::text IS NULL OR status = $2)
      ORDER BY created_at DESC`,
    [siteId, status ? GAP_STATUS_TO_DB[status] : null]
  );
  return rows.map((r) => ({ ...r, status: GAP_STATUS_FROM_DB[r.status] }));
}

// Records one weekly discovery pass's real-GSC evidence for a still-pending
// gap (migration 129) — appended by the weekly refresh pass
// (analyst-seo-mapping.js's refreshPendingKeywordGapObservations), not by
// saveKeywordGaps itself, since evidence is a Node-side GSC lookup
// (getRelatedQueriesForTopic) rather than something Python's clustering pass
// carries. qualifyAndShipContentGaps reads the last two entries to judge
// whether demand is stable/growing before a gap is ever eligible to ship.
export async function appendKeywordGapEvidenceSnapshot(siteId, gapId, snapshot) {
  await query(
    `UPDATE keyword_gaps
        SET evidence_snapshots = evidence_snapshots || $3::jsonb
      WHERE site_id = $1 AND id = $2 AND status = 'pending_review'`,
    [siteId, gapId, JSON.stringify([snapshot])]
  );
}

export async function updateKeywordGapStatus(siteId, gapId, status) {
  const { rows } = await query(
    `UPDATE keyword_gaps SET status = $3
      WHERE site_id = $1 AND id = $2
      RETURNING id, topic, reason, priority, status, source, search_intent, product_relevance, existing_page_match, created_at`,
    [siteId, gapId, GAP_STATUS_TO_DB[status]]
  );
  if (!rows[0]) return null;
  return { ...rows[0], status: GAP_STATUS_FROM_DB[rows[0].status] };
}

// Written once by classifyGapRelevance/findExistingPageMatch (analyst-seo-
// mapping.js) at approval time. Every field is independently optional and
// COALESCEd against its own current value — the two checks run in parallel
// and neither depends on the other, so a call that only has ONE result
// (e.g. the page-inventory check ran but classification was already set
// from an earlier approval) must never null out the other's already-
// recorded value. A gap is only ever classified/checked once; re-approval
// after a dismissed draft reuses what's already known rather than
// re-judging against a possibly-changed capability set or page inventory.
export async function setGapClassification(siteId, gapId, { searchIntent, productRelevance, priority, existingPageMatch }) {
  const { rows } = await query(
    `UPDATE keyword_gaps SET
            search_intent = COALESCE($3, search_intent),
            product_relevance = COALESCE($4, product_relevance),
            priority = COALESCE($5, priority),
            existing_page_match = COALESCE($6, existing_page_match)
      WHERE site_id = $1 AND id = $2
      RETURNING id, topic, reason, priority, status, source, search_intent, product_relevance, existing_page_match, created_at`,
    [siteId, gapId, searchIntent, productRelevance, priority ?? null, existingPageMatch ?? null]
  );
  if (!rows[0]) return null;
  return { ...rows[0], status: GAP_STATUS_FROM_DB[rows[0].status] };
}

// Product Understanding Layer (migration 111). 'verified' rows are the only
// ones classifyGapRelevance ever reads — a 'proposed' row an agent adds is
// invisible to routing decisions until a human approves it.
export async function getProductCapabilities(siteId, status) {
  const { rows } = await query(
    `SELECT id, site_id, name, category, description, industries_json AS industries, status, source, created_at, updated_at
       FROM product_capabilities
      WHERE site_id = $1 AND ($2::text IS NULL OR status = $2)
      ORDER BY created_at DESC`,
    [siteId, status || null]
  );
  return rows;
}

// Added through the Analyst page's own form, so 'human' + 'verified' is the
// only path this function writes — an agent proposing a capability is a
// separate, not-yet-built entry point that would insert source='agent_proposed',
// status='proposed' instead. No such writer exists yet, so every row today
// is human-asserted ground truth, per the "do not invent capabilities" rule.
export async function createProductCapability(siteId, { name, category, description, industries }) {
  const { rows } = await query(
    `INSERT INTO product_capabilities (site_id, name, category, description, industries_json, status, source)
     VALUES ($1, $2, $3, $4, $5, 'verified', 'human')
     RETURNING id, site_id, name, category, description, industries_json AS industries, status, source, created_at, updated_at`,
    [siteId, name, category || null, description || null, JSON.stringify(industries || [])]
  );
  return rows[0];
}

export async function updateProductCapabilityStatus(siteId, id, status) {
  const { rows } = await query(
    `UPDATE product_capabilities SET status = $3, updated_at = now()
      WHERE site_id = $1 AND id = $2
      RETURNING id, site_id, name, category, description, industries_json AS industries, status, source, created_at, updated_at`,
    [siteId, id, status]
  );
  return rows[0] || null;
}

// Product-visibility growth objective, Phase 5 (migration 114) — one row
// per capability per snapshotCapabilityVisibility run (analyst-seo-mapping.js),
// on the same 14-day cadence as keyword clustering/narrative (server/cron.js).
export async function recordCapabilityVisibilitySnapshot(siteId, capabilityId, { avgImpressions, avgPosition, openGapCount, approvedGapCount }) {
  await query(
    `INSERT INTO capability_visibility_snapshots
       (site_id, capability_id, avg_impressions, avg_position, open_gap_count, approved_gap_count)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [siteId, capabilityId, avgImpressions, avgPosition, openGapCount ?? 0, approvedGapCount ?? 0]
  );
}

// The two most recent snapshots for a capability — enough to compute a
// single trend (current vs. immediately-prior run), which is all a 14-day
// cadence needs; a longer history is a chart concern, not this read's job.
export async function getRecentCapabilityVisibilitySnapshots(siteId, capabilityId, limit = 2) {
  const { rows } = await query(
    `SELECT avg_impressions, avg_position, open_gap_count, approved_gap_count, created_at
       FROM capability_visibility_snapshots
      WHERE site_id = $1 AND capability_id = $2
      ORDER BY created_at DESC
      LIMIT $3`,
    [siteId, capabilityId, limit]
  );
  return rows;
}

// A keyword a human typed on the Analyst page as a growth target. Deliberately
// lands in the same keyword_gaps queue as the machine-generated passes (source
// 'user_request', see migration 099) so approval routes through the identical
// createActionCenterRecommendationForGap → generateDraft → Action Center
// pipeline, rather than a parallel path to the same destination.
//
// Returns the existing row instead of inserting when the same topic is already
// awaiting review for this site: re-typing a keyword you already asked for
// should surface the request you already made, not stack a second identical
// row in the review queue. Only pending_review rows are reused — a topic that
// was previously approved or rejected can legitimately be raised again.
export async function createUserKeywordGap(siteId, topic, reason) {
  const { rows: existing } = await query(
    `SELECT id, topic, reason, priority, status, source, search_intent, product_relevance, existing_page_match, created_at
       FROM keyword_gaps
      WHERE site_id = $1 AND lower(topic) = lower($2) AND status = 'pending_review'
      ORDER BY created_at DESC
      LIMIT 1`,
    [siteId, topic]
  );
  if (existing[0]) {
    return { ...existing[0], status: GAP_STATUS_FROM_DB[existing[0].status], alreadyQueued: true };
  }

  const { rows } = await query(
    `INSERT INTO keyword_gaps (site_id, topic, reason, priority, status, source)
     VALUES ($1, $2, $3, 'medium', 'pending_review', 'user_request')
     RETURNING id, topic, reason, priority, status, source, search_intent, product_relevance, existing_page_match, created_at`,
    [siteId, topic, reason || null]
  );
  return { ...rows[0], status: GAP_STATUS_FROM_DB[rows[0].status], alreadyQueued: false };
}

// Real GSC queries that textually match a gap's topic — used as the "did we
// already partially cover this?" evidence check when a gap is approved (see
// server/routes/keywords.js). A true zero-coverage gap should turn up little
// or nothing here; this only ever surfaces real, already-observed queries,
// never a fabricated/estimated one. Matches on individual topic words (not
// the whole phrase) since a real query is rarely an exact phrase match.
export async function getRelatedQueriesForTopic(siteId, topic, days = 90, limit = 8) {
  const words = (topic || '').toLowerCase().split(/\s+/).filter((w) => w.length > 2);
  if (!words.length) return [];
  const patterns = words.map((w) => `%${w}%`);
  const { rows } = await query(
    `SELECT dim_value,
            SUM(clicks)      AS clicks,
            SUM(impressions) AS impressions,
            CASE WHEN SUM(impressions) = 0 THEN NULL
                 ELSE ROUND(SUM(position * impressions) / SUM(impressions), 2) END AS avg_position
       FROM gsc_breakdown
      WHERE site_id = $1 AND dim_type = 'query' AND date >= CURRENT_DATE - ($2::int * INTERVAL '1 day')
        AND LOWER(dim_value) LIKE ANY($3::text[])
      GROUP BY dim_value
      ORDER BY impressions DESC
      LIMIT $4`,
    [siteId, days, patterns, limit]
  );
  return rows;
}

// Supplementary keyword/AEO narrative — see server/agents/keyword-narrative.js
// and migration 083_keyword_narratives.sql. Append-only per run, same
// "latest row wins" pattern as getKeywordClusters above.
export async function saveKeywordNarrative(siteId, narrative) {
  await query(
    'INSERT INTO keyword_narratives (site_id, narrative) VALUES ($1, $2)',
    [siteId, narrative]
  );
}

export async function getLatestKeywordNarrative(siteId) {
  const { rows } = await query(
    `SELECT narrative, created_at
       FROM keyword_narratives
      WHERE site_id = $1
      ORDER BY created_at DESC
      LIMIT 1`,
    [siteId]
  );
  return rows[0] || null;
}

// Latest forecast_runs status per metric — used only to flag "any forecast
// issues" for the layout suggester (server/routes/keywords.js), not to read
// forecast values (see getForecasts above for that).
export async function getLatestForecastStatuses(siteId) {
  const { rows } = await query(
    `SELECT DISTINCT ON (metric_key) metric_key, status
       FROM forecast_runs
      WHERE client_id = $1
      ORDER BY metric_key, generated_at DESC`,
    [siteId]
  );
  return rows;
}

// AI layout suggestions — see server/routes/keywords.js's GET .../layout and
// migration 084_layout_suggestions.sql. Append-only per run, same "latest
// row wins" pattern as getKeywordClusters/getLatestKeywordNarrative above.
// layout_json stores { layout: [...9 ids], signature: { anomalyCount, gapCount } }
// so the route can decide whether to reuse this row or regenerate, without
// needing extra columns.
export async function getLatestLayoutSuggestion(siteId) {
  const { rows } = await query(
    `SELECT layout_json, reason, generated_at
       FROM layout_suggestions
      WHERE site_id = $1
      ORDER BY generated_at DESC
      LIMIT 1`,
    [siteId]
  );
  return rows[0] || null;
}

export async function saveLayoutSuggestion(siteId, layoutJson, reason) {
  const { rows } = await query(
    `INSERT INTO layout_suggestions (site_id, layout_json, reason)
     VALUES ($1, $2, $3)
     RETURNING layout_json, reason, generated_at`,
    [siteId, JSON.stringify(layoutJson), reason]
  );
  return rows[0];
}

// Direct-DB read of insights for page-dimension fusion (analyst-fusion.js) —
// deliberately a straight SQL read of the shared `insights` table rather
// than a round trip through fetchAnalystInsights' HTTP call to the Python
// service, which analyst-seo-mapping.js's nightly sync already uses for its
// own, unrelated purpose. Both are valid; this one exists because the
// fusion engine needs to group insights BY PAGE across insight_type values
// (anomaly + forecast_risk + trend_shift together) to compute corroboration,
// which is cheaper and simpler as one grouped query than three HTTP-shaped
// filters over the same payload.
export async function getRecentPageInsights(siteId, days = 21) {
  const { rows } = await query(
    `SELECT id, metric_key, dimension_value AS page, insight_type, severity, evidence, generated_at, period_start
       FROM insights
      WHERE client_id = $1 AND dimension_type = 'page'
        AND generated_at >= now() - ($2 * interval '1 day')
      ORDER BY generated_at DESC`,
    [siteId, days]
  );
  return rows;
}
