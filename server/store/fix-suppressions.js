import { query } from '../db.js';
import { normalizeScopeKey } from '../agents/lib/work-claims.js';

// Page-level (not generator-level) suppression, written from measured impact.
// See migration 182 for why generator_learning's site-wide demotion cannot
// express this.

// How long an automatic suppression lasts. Long enough to cover a full
// re-detection and re-measurement cycle (fix_impact measures ~31 days after
// merge, so anything shorter would let the same fix return before its own
// verdict landed), short enough that a page which has since been redesigned
// gets another chance. A human can suppress indefinitely by passing null.
export const DEFAULT_SUPPRESSION_DAYS = 90;

// Enforcement is opt-in, like every other gate added in this phase: unset,
// suppressions are still WRITTEN (so a week of real evidence accumulates)
// but never read, so behaviour is unchanged until the flag is on.
export function isSuppressionEnforcing(env = process.env) {
  return env.FIX_SUPPRESSION_ENABLED === 'true';
}

// A regression big enough to act on.
//
// classifyImpact (agents/lib/fix-impact.js) calls ANY negative click delta
// 'impact-negative', which is right for a confidence signal that gets
// averaged over many attempts and wrong as a trigger for blocking future
// work on a page: a page going from 2 clicks to 1 is noise, and suppressing
// on it would permanently ban a generator from a page on the strength of a
// single click.
//
// This is the same error class the repo already guards against elsewhere —
// query-intelligence.js's filterMovers rejects a '2 to 0' wobble with
// MIN_MOVER_CLICKS, and its comment says so outright. The floor here matches
// that precedent rather than inventing a second number, and the relative test
// stops a large, busy page's ordinary week-to-week variance from tripping it.
export const MIN_REGRESSION_CLICKS = 5;
export const MIN_REGRESSION_SHARE = 0.2;

export function isMaterialRegression(delta, before) {
  if (!delta || !before) return false;
  const lost = -Number(delta.clicks ?? 0);
  if (!(lost >= MIN_REGRESSION_CLICKS)) return false;
  const baseline = Number(before.clicks ?? 0);
  // No baseline to be a share of: the absolute floor above already holds, and
  // losing 5+ clicks a page never had is not something this can describe.
  if (baseline <= 0) return false;
  return lost / baseline >= MIN_REGRESSION_SHARE;
}

// A measured regression. Upserts, so re-measuring the same page/generator
// refreshes the window and the evidence rather than stacking rows.
export async function suppressFix(siteId, {
  scope = 'page', scopeKey, generatorId, reason, evidence = null,
  days = DEFAULT_SUPPRESSION_DAYS, createdBy = 'impact-measurement',
}) {
  const key = normalizeScopeKey(scope, scopeKey);
  if (!key || !generatorId) return null;
  const { rows } = await query(
    `INSERT INTO fix_suppressions
       (site_id, scope, scope_key, generator_id, reason, evidence, suppressed_until, created_by)
     VALUES ($1, $2, $3, $4, $5, $6,
             CASE WHEN $7::int IS NULL THEN NULL ELSE now() + ($7 || ' days')::interval END,
             $8)
     ON CONFLICT (site_id, scope, scope_key, generator_id) DO UPDATE
       SET reason = EXCLUDED.reason,
           evidence = EXCLUDED.evidence,
           suppressed_until = EXCLUDED.suppressed_until,
           created_by = EXCLUDED.created_by,
           created_at = now(),
           lifted_at = NULL
     RETURNING id`,
    [siteId, scope, key, generatorId, reason, evidence ? JSON.stringify(evidence) : null, days, createdBy]
  );
  return rows[0]?.id ?? null;
}

// Every live suppression for a site, as a Set of "scope:key:generatorId" —
// read once per auto-remediation run, the same shape and cost as
// getLearnedConfidenceMap.
export async function getSuppressionSet(siteId) {
  const { rows } = await query(
    `SELECT scope, scope_key, generator_id FROM fix_suppressions
      WHERE site_id = $1 AND lifted_at IS NULL
        AND (suppressed_until IS NULL OR suppressed_until > now())`,
    [siteId]
  );
  return new Set(rows.map((r) => `${r.scope}:${r.scope_key}:${r.generator_id}`));
}

// Pure, so the eligibility rule is testable without a DB — the same reason
// detect.js exports its threshold checks.
export function isSuppressed(suppressionSet, { scope = 'page', scopeKey, generatorId }) {
  const key = normalizeScopeKey(scope, scopeKey);
  if (!key || !generatorId) return false;
  return suppressionSet.has(`${scope}:${key}:${generatorId}`);
}

export async function liftSuppression(siteId, { scope = 'page', scopeKey, generatorId }) {
  const key = normalizeScopeKey(scope, scopeKey);
  if (!key) return;
  await query(
    `UPDATE fix_suppressions SET lifted_at = now()
      WHERE site_id = $1 AND scope = $2 AND scope_key = $3 AND generator_id = $4 AND lifted_at IS NULL`,
    [siteId, scope, key, generatorId]
  );
}

export async function listSuppressions(siteId) {
  const { rows } = await query(
    `SELECT scope, scope_key, generator_id, reason, evidence, suppressed_until, created_by, created_at
       FROM fix_suppressions
      WHERE site_id = $1 AND lifted_at IS NULL
      ORDER BY created_at DESC`,
    [siteId]
  );
  return rows;
}
