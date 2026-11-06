import { query } from '../db.js';

// Writes competitor opportunities into the EXISTING keyword_gaps queue (migration 234) and tracks what happened to
// them. Every function takes the siteId and puts it in the WHERE clause.
//
// Why not a new table: keyword_gaps already feeds the weekly ship cycle, already carries the qualification fields
// (observation_count, product_relevance, coverage_status, content_plan) and already has the per-gap idempotency that
// stops a topic being shipped twice. A parallel queue would need all of that again.

// One opportunity per statement, matching saveKeywordGaps' own shape: the WHERE NOT EXISTS keeps a gap a human has
// already accepted or dismissed from coming back, and the ON CONFLICT lets a re-observed opportunity raise its
// observation count (which is what the existing ship gate requires) instead of inserting a duplicate.
export async function saveCompetitorOpportunities(siteId, opportunities, { discoveryWeek = null } = {}) {
  let inserted = 0;
  let updated = 0;
  for (const o of opportunities) {
    const { rows } = await query(
      `INSERT INTO keyword_gaps (
         site_id, topic, reason, priority, status, source,
         first_discovery_week, last_observed_week,
         topic_cluster, cluster_role, location_code, language_code, search_volume,
         search_intent, existing_page_match, content_plan,
         opportunity_type, opportunity_score, competitor_evidence, keyword_difficulty,
         our_position, best_competitor_position, lifecycle_state, lifecycle_changed_at
       )
       SELECT $1, $2, $3, $4, 'pending_review', 'competitor_footprint',
              COALESCE($5::date, (date_trunc('week', now() AT TIME ZONE 'UTC'))::date),
              COALESCE($5::date, (date_trunc('week', now() AT TIME ZONE 'UTC'))::date),
              $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16::jsonb, $17, $18, $19, 'discovered', now()
        WHERE NOT EXISTS (
          SELECT 1 FROM keyword_gaps
           WHERE site_id = $1 AND topic = $2 AND status IN ('accepted', 'dismissed')
        )
       ON CONFLICT (site_id, topic) WHERE status = 'pending_review' DO UPDATE SET
         last_seen_at = now(),
         observation_count = keyword_gaps.observation_count
           + (CASE WHEN EXCLUDED.last_observed_week > COALESCE(keyword_gaps.last_observed_week, DATE '0001-01-01')
                   THEN 1 ELSE 0 END),
         last_observed_week = GREATEST(EXCLUDED.last_observed_week,
                                       COALESCE(keyword_gaps.last_observed_week, EXCLUDED.last_observed_week)),
         reason = COALESCE(EXCLUDED.reason, keyword_gaps.reason),
         -- A fresh measurement replaces the old one: a rival's position and the keyword's demand genuinely move.
         search_volume = COALESCE(EXCLUDED.search_volume, keyword_gaps.search_volume),
         keyword_difficulty = COALESCE(EXCLUDED.keyword_difficulty, keyword_gaps.keyword_difficulty),
         our_position = EXCLUDED.our_position,
         best_competitor_position = COALESCE(EXCLUDED.best_competitor_position, keyword_gaps.best_competitor_position),
         opportunity_type = COALESCE(EXCLUDED.opportunity_type, keyword_gaps.opportunity_type),
         opportunity_score = COALESCE(EXCLUDED.opportunity_score, keyword_gaps.opportunity_score),
         competitor_evidence = COALESCE(EXCLUDED.competitor_evidence, keyword_gaps.competitor_evidence),
         existing_page_match = COALESCE(EXCLUDED.existing_page_match, keyword_gaps.existing_page_match),
         content_plan = COALESCE(keyword_gaps.content_plan, EXCLUDED.content_plan),
         topic_cluster = COALESCE(EXCLUDED.topic_cluster, keyword_gaps.topic_cluster),
         cluster_role = COALESCE(EXCLUDED.cluster_role, keyword_gaps.cluster_role)
       RETURNING id, (xmax = 0) AS was_inserted`,
      [
        siteId, o.keyword, o.reason || null, priorityFor(o.score), discoveryWeek,
        o.topicCluster || null, o.clusterRole || null, o.locationCode ?? null, o.languageCode || null,
        o.searchVolume ?? null, o.searchIntent || null, o.existingPageMatch || null, o.contentPlan || null,
        o.opportunityType || null, o.score ?? null, JSON.stringify(o.evidence ?? {}), o.keywordDifficulty ?? null,
        o.ourPosition ?? null, o.bestCompetitorPosition ?? null,
      ]
    );
    if (!rows[0]) continue; // a gap already accepted or dismissed: deliberately left alone
    if (rows[0].was_inserted) inserted += 1; else updated += 1;
  }
  return { inserted, updated };
}

// The score band mapped onto the priority the existing queue and gates already understand. Deliberately coarse: the
// precise ordering lives in opportunity_score, and priority only needs to agree with the existing three buckets.
function priorityFor(score) {
  if (typeof score !== 'number') return 'medium';
  if (score >= 0.6) return 'high';
  if (score >= 0.35) return 'medium';
  return 'low';
}

export async function listCompetitorOpportunities(siteId, { status = 'pending_review', limit = 50, opportunityType = null } = {}) {
  const { rows } = await query(
    `SELECT id, topic, priority, status, opportunity_type, opportunity_score::float AS opportunity_score,
            search_volume, keyword_difficulty, search_intent, our_position::float AS our_position,
            best_competitor_position, existing_page_match, content_plan, topic_cluster, cluster_role,
            competitor_evidence, observation_count, lifecycle_state, lifecycle_changed_at, reason, created_at
       FROM keyword_gaps
      WHERE site_id = $1 AND source = 'competitor_footprint'
        AND ($2::text IS NULL OR status = $2)
        AND ($3::text IS NULL OR opportunity_type = $3)
      ORDER BY opportunity_score DESC NULLS LAST, created_at DESC
      LIMIT $4`,
    [siteId, status, opportunityType, Math.min(Math.max(Number(limit) || 50, 1), 500)]
  );
  return rows;
}

// Lifecycle moves forward only. An opened PR is 'drafted', not a result; only 'verified' counts as an outcome, and
// that transition is the one behaviour learning reads.
const ORDER = ['discovered', 'drafted', 'merged', 'deployed', 'verified'];
export async function advanceOpportunityLifecycle(siteId, gapId, state) {
  if (!ORDER.includes(state)) throw new Error(`Unknown lifecycle state "${state}".`);
  const { rows } = await query(
    `UPDATE keyword_gaps
        SET lifecycle_state = $3, lifecycle_changed_at = now()
      WHERE site_id = $1 AND id = $2
        AND array_position($4::text[], lifecycle_state) < array_position($4::text[], $3)
      RETURNING id, lifecycle_state, lifecycle_changed_at`,
    [siteId, gapId, state, ORDER]
  );
  return rows[0] || null; // null = already at or past this state; a re-run must not move it backwards
}

// Verified outcomes per opportunity type — the only input the scorer's learned multiplier is allowed to use.
// `outcome` is 'positive' | 'negative' | 'neutral': neutral counts towards the total but towards neither side, so a
// change that did nothing measurable is recorded honestly rather than ignored.
export async function recordOpportunityOutcome(siteId, opportunityType, outcome) {
  if (!['positive', 'negative', 'neutral'].includes(outcome)) throw new Error(`Unknown outcome "${outcome}".`);
  const { rows } = await query(
    `INSERT INTO opportunity_type_outcomes (site_id, opportunity_type, verified_total, verified_positive, verified_negative)
     VALUES ($1, $2, 1, $3, $4)
     ON CONFLICT (site_id, opportunity_type) DO UPDATE SET
       verified_total = opportunity_type_outcomes.verified_total + 1,
       verified_positive = opportunity_type_outcomes.verified_positive + $3,
       verified_negative = opportunity_type_outcomes.verified_negative + $4,
       updated_at = now()
     RETURNING opportunity_type, verified_total, verified_positive, verified_negative`,
    [siteId, opportunityType, outcome === 'positive' ? 1 : 0, outcome === 'negative' ? 1 : 0]
  );
  return rows[0];
}

// What this project's verified history says about each kind of work, as the bounded multiplier the scorer takes.
// MIN_VERIFIED is the honesty gate: below it there is nothing to learn from and every type stays neutral, so the
// system cannot talk itself into a preference off one lucky result.
export const MIN_VERIFIED = 3;
export async function getLearnedMultipliers(siteId) {
  const { rows } = await query(
    `SELECT opportunity_type, verified_total, verified_positive, verified_negative
       FROM opportunity_type_outcomes WHERE site_id = $1`,
    [siteId]
  );
  const out = {};
  for (const r of rows) {
    if (r.verified_total < MIN_VERIFIED) continue;
    const successRate = r.verified_positive / r.verified_total;
    // 0.7 at never-works, 1.0 at half, 1.3 at always-works — the same bounds the scorer clamps to.
    out[r.opportunity_type] = Number((0.7 + successRate * 0.6).toFixed(3));
  }
  return out;
}
