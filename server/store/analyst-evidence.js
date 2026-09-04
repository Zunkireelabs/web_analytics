import { query } from '../db.js';

// Persistence for analyst_evidence (migration 141) — the Analyst's stored
// reasoning, as opposed to `recommendations`, which stores only what it
// decided to do. Same append-then-resolve shape as fix-impact.js: the
// conclusion is written when it is reached, and the `outcome` column is
// filled in later by a sweep once real post-change numbers exist.

// Idempotent on (site_id, finding_id): re-running a night's analyst pass
// updates the conclusion in place rather than duplicating it. Deliberately
// re-writes the evidence/narrative/score every time — the point of a second
// run is that the numbers moved, and a stale conclusion is worse than none.
//
// `outcome`/`measured_at` are never touched here: once a conclusion has been
// measured against reality, re-deriving it must not erase what actually
// happened.
export async function upsertAnalystEvidence(siteId, conclusion) {
  const {
    subjectType, subjectKey, direction, verdict, corroboration = 0, confidence = null,
    score = null, scoreFactors = null, signals = [], freshness = null, narrative = null,
    productMapping = null, externalDemand = null, recommendationId = null, findingId,
  } = conclusion;

  const { rows } = await query(
    `INSERT INTO analyst_evidence
       (site_id, subject_type, subject_key, direction, verdict, corroboration, confidence,
        score, score_factors, signals, freshness, narrative, product_mapping, external_demand,
        recommendation_id, finding_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
     ON CONFLICT (site_id, finding_id) DO UPDATE SET
       subject_type    = EXCLUDED.subject_type,
       subject_key     = EXCLUDED.subject_key,
       direction       = EXCLUDED.direction,
       verdict         = EXCLUDED.verdict,
       corroboration   = EXCLUDED.corroboration,
       confidence      = EXCLUDED.confidence,
       score           = EXCLUDED.score,
       score_factors   = EXCLUDED.score_factors,
       signals         = EXCLUDED.signals,
       freshness       = EXCLUDED.freshness,
       narrative       = EXCLUDED.narrative,
       product_mapping = EXCLUDED.product_mapping,
       external_demand = EXCLUDED.external_demand,
       -- COALESCE, not EXCLUDED: a later pass that reaches the same
       -- conclusion but does not create a recommendation (because one is
       -- already open) must not blank the link to the row that DID ship.
       recommendation_id = COALESCE(EXCLUDED.recommendation_id, analyst_evidence.recommendation_id),
       updated_at      = now()
     RETURNING *`,
    [
      siteId, subjectType, subjectKey, direction, verdict, corroboration, confidence,
      score, scoreFactors ? JSON.stringify(scoreFactors) : null, JSON.stringify(signals),
      freshness ? JSON.stringify(freshness) : null, narrative ? JSON.stringify(narrative) : null,
      productMapping ? JSON.stringify(productMapping) : null,
      externalDemand ? JSON.stringify(externalDemand) : null,
      recommendationId, findingId,
    ]
  );
  return rows[0] || null;
}

// The lane read: conclusions that cleared the evidence bar, best first.
// Used by auto-remediation.js to size the analyst lane from real evidence
// rather than from "candidates that happen to sit on a declining page".
export async function listActionableAnalystEvidence(siteId, limit = 100) {
  const { rows } = await query(
    `SELECT * FROM analyst_evidence
      WHERE site_id = $1 AND verdict = 'act'
      ORDER BY score DESC NULLS LAST, created_at DESC
      LIMIT $2`,
    [siteId, limit]
  );
  return rows;
}

export async function listAnalystEvidence(siteId, { verdict = null, limit = 100 } = {}) {
  const { rows } = await query(
    `SELECT * FROM analyst_evidence
      WHERE site_id = $1 AND ($2::text IS NULL OR verdict = $2)
      ORDER BY created_at DESC
      LIMIT $3`,
    [siteId, verdict, limit]
  );
  return rows;
}

// Conclusions that produced a recommendation and are still unmeasured, with
// the shipping trail joined on: the recommendation's status, the draft it
// became, its PR, and fix_impact's measured before/after windows.
//
// This IS the insight -> recommendation -> change -> PR -> shipped ->
// post-change metrics chain, expressed as one query over tables that already
// hold every link of it. Nothing new is written into the shipping path to
// make this work — the join key is finding_id, which recommendations, drafts
// and analyst_evidence already all carry.
export async function getAnalystOutcomeChain(siteId, { onlyUnmeasured = false, limit = 200 } = {}) {
  const { rows } = await query(
    `SELECT ae.id, ae.finding_id, ae.subject_type, ae.subject_key, ae.direction,
            ae.confidence, ae.score, ae.narrative, ae.product_mapping,
            ae.outcome, ae.measured_at, ae.created_at AS concluded_at,
            r.id  AS recommendation_id, r.recommendation_type, r.status AS recommendation_status,
            d.id  AS draft_id, d.status AS draft_status, d.pr_url, d.pr_number,
            d.implemented_at, d.stage_merged_at,
            fi.status AS impact_status, fi.before_window, fi.after_window, fi.delta,
            fi.measured_at AS impact_measured_at
       FROM analyst_evidence ae
       LEFT JOIN recommendations r ON r.id = ae.recommendation_id
       LEFT JOIN drafts d          ON d.site_id = ae.site_id AND d.finding_id = ae.finding_id
       LEFT JOIN fix_impact fi     ON fi.draft_id = d.id
      WHERE ae.site_id = $1
        AND ae.recommendation_id IS NOT NULL
        AND ($2 = false OR ae.outcome IS NULL)
      ORDER BY ae.created_at DESC
      LIMIT $3`,
    [siteId, onlyUnmeasured, limit]
  );
  return rows;
}

export async function recordAnalystOutcome(id, outcome) {
  const { rows } = await query(
    `UPDATE analyst_evidence
        SET outcome = $2, measured_at = now(), updated_at = now()
      WHERE id = $1
      RETURNING *`,
    [id, JSON.stringify(outcome)]
  );
  return rows[0] || null;
}

// "Which KINDS of analyst recommendation actually produce growth" — the
// aggregate the learning step will eventually calibrate against. Grouped by
// direction and by the surface that was chosen, because those are the two
// decisions the Analyst makes that a measurement can prove wrong: whether it
// read prevention vs. growth correctly, and whether expanding an existing
// page beat creating a new one.
//
// Reports only rows that have a real measurement. A recommendation still
// waiting out fix_impact's 31-day window carries no information and would
// only dilute the averages.
export async function analystOutcomeSummary(siteId) {
  const { rows } = await query(
    `SELECT ae.direction,
            COALESCE(ae.product_mapping->'surface'->>'kind', 'unknown') AS surface_kind,
            count(*)::int AS measured,
            count(*) FILTER (WHERE (ae.outcome->>'improved')::boolean) ::int AS improved,
            ROUND(AVG((ae.outcome->'delta'->>'impressions')::numeric), 1) AS avg_impressions_delta,
            ROUND(AVG((ae.outcome->'delta'->>'clicks')::numeric), 1)      AS avg_clicks_delta,
            ROUND(AVG((ae.outcome->'delta'->>'avgPosition')::numeric), 2) AS avg_position_delta,
            ROUND(AVG(ae.confidence), 3) AS avg_confidence
       FROM analyst_evidence ae
      WHERE ae.site_id = $1 AND ae.outcome IS NOT NULL
      GROUP BY 1, 2
      ORDER BY measured DESC`,
    [siteId]
  );
  return rows;
}
