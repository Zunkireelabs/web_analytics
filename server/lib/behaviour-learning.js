// BEHAVIOUR LEARNING, as something a person (or the next phase's decision engine) can read.
//
// The learning itself already exists and is not duplicated here: generator-learning.js records and scores outcomes,
// fix-impact.js measures real before/after search results, auto-remediation.js and growth-scoring.js use them to rank
// work. What was missing is a way to SEE it honestly:
//
//   1. getExecutionLifecycle: what happened to each piece of work, with the stages kept SEPARATE. A draft being
//      generated, passing its checks, having a PR opened, being merged, the deployment being detected live, and an
//      impact being measured are six different facts held in four tables. Reporting "shipped" for all of them is how a
//      system ends up claiming a change is live when it is only merged, or helpful when it is only measured.
//
//   2. explainExperience: a plain-language account of what the history says about one generator on one project, with an
//      evidence label so "3 attempts" is never presented like "30". It states counts, never conclusions the data does
//      not support, and always says impact is observed correlation.
//
// Everything is read-only, keyed by siteId, and built on the existing tables. No new storage.

export const MIN_SAMPLES = 3; // mirrors generator-learning.js's MIN_SAMPLES (exported there and checked by a test)
const ESTABLISHED_SAMPLES = 10;

const evidenceLevel = (n) => (n < MIN_SAMPLES ? 'insufficient' : n < ESTABLISHED_SAMPLES ? 'limited' : 'established');

// ── lifecycle ───────────────────────────────────────────────────────────────────────────────────────────────────

// validation_status is a map of gate results ({ qualityGate: { ok }, renderingConfig: { ok }, ... }). "Passed" needs at
// least one gate recorded and none failing; no record at all is its own state, never assumed to be a pass.
export function validationState(validationStatus) {
  const gates = Object.values(validationStatus && typeof validationStatus === 'object' ? validationStatus : {})
    .filter((g) => g && typeof g === 'object' && typeof g.ok === 'boolean');
  if (!gates.length) return 'not-recorded';
  return gates.every((g) => g.ok) ? 'passed' : 'failed';
}

const IMPACT_VERDICT = { 'impact-positive': 'positive', 'impact-negative': 'negative', 'impact-inconclusive': 'inconclusive' };

export function stagesFor(row) {
  const merged = Boolean(row.implemented_at || row.stage_merged_at || row.deployment_merged_at);
  const deployment = row.deployment_status === 'deployed' ? 'verified'
    : row.deployment_status === 'not-detected' ? 'not-detected'
      : row.deployment_status === 'pending' ? 'pending'
        : merged ? 'untracked' : null;

  let impact = null;
  if (row.impact_status === 'measured') impact = IMPACT_VERDICT[row.impact_verdict] || 'legacy'; // legacy = measured before verdicts existed
  else if (row.impact_status) impact = row.impact_status; // pending | unmeasurable | insufficient-data

  const furthest = impact && !['pending', 'unmeasurable', 'insufficient-data'].includes(impact) ? 'measured'
    : deployment === 'verified' ? 'deployed'
      : merged ? 'merged'
        : row.pr_number ? 'pr-opened'
          : 'generated';

  return {
    draftId: row.draft_id,
    actionType: row.action_type,
    createdAt: row.created_at,
    generated: true,
    validated: validationState(row.validation_status),
    prOpened: Boolean(row.pr_number),
    merged,
    deployment,
    impact,
    abandoned: Boolean(row.abandoned_at) || row.draft_status === 'abandoned',
    furthest,
  };
}

export function summarizeLifecycle(stages) {
  const n = (pred) => stages.filter(pred).length;
  return {
    total: stages.length,
    validationPassed: n((s) => s.validated === 'passed'),
    validationFailed: n((s) => s.validated === 'failed'),
    prOpened: n((s) => s.prOpened),
    merged: n((s) => s.merged),
    deploymentVerified: n((s) => s.deployment === 'verified'),
    deploymentNotDetected: n((s) => s.deployment === 'not-detected'),
    deploymentPending: n((s) => s.deployment === 'pending'),
    mergedButUntracked: n((s) => s.deployment === 'untracked'),
    impact: {
      positive: n((s) => s.impact === 'positive'),
      negative: n((s) => s.impact === 'negative'),
      inconclusive: n((s) => s.impact === 'inconclusive'),
      legacy: n((s) => s.impact === 'legacy'),
      insufficientData: n((s) => s.impact === 'insufficient-data'),
      pending: n((s) => s.impact === 'pending'),
      unmeasurable: n((s) => s.impact === 'unmeasurable'),
    },
    abandoned: n((s) => s.abandoned),
  };
}

// Every join is also keyed by site, so one project's deployment or measurement can never attach to another's draft.
export async function getExecutionLifecycle(siteId, { limit = 100, deps = {} } = {}) {
  // Lazy, so the pure functions above can be imported and tested without a database.
  const q = deps.query || (await import('../db.js')).query;
  const { rows } = await q(
    `SELECT d.id AS draft_id, d.action_type, d.status AS draft_status, d.created_at, d.validation_status,
            d.pr_number, d.implemented_at, d.stage_merged_at, d.abandoned_at,
            dep.status AS deployment_status, dep.merged_at AS deployment_merged_at,
            fi.status AS impact_status, fi.delta->>'verdict' AS impact_verdict
       FROM drafts d
       LEFT JOIN fix_impact fi ON fi.draft_id = d.id AND fi.site_id = d.site_id
       LEFT JOIN LATERAL (
              SELECT x.status, x.merged_at FROM deployments x
               WHERE x.site_id = d.site_id
                 AND (x.id = fi.deployment_id OR (fi.deployment_id IS NULL AND d.pr_number IS NOT NULL AND x.pr_number = d.pr_number))
               ORDER BY x.merged_at DESC LIMIT 1
            ) dep ON true
      WHERE d.site_id = $1
      ORDER BY d.created_at DESC
      LIMIT $2`,
    [siteId, Math.min(Math.max(Number(limit) || 100, 1), 1000)]
  );
  const stages = rows.map(stagesFor);
  return { stages, summary: summarizeLifecycle(stages) };
}

// ── experience ──────────────────────────────────────────────────────────────────────────────────────────────────

const pct = (a, b) => Math.round((a / b) * 100);

// `entry` is one value from generator-learning.js's getLearnedConfidenceMap (or undefined for no history).
export function explainExperience(generatorId, entry, { impactWindowDays = 28 } = {}) {
  if (!entry) {
    return {
      generatorId, technicalEvidence: 'none', impactEvidence: 'none', demoted: false,
      text: `${generatorId}: no recorded history on this project yet. Nothing is assumed about how it will go.`,
    };
  }
  const scored = entry.successes + entry.failures;
  const qualified = entry.impactPositive + entry.impactNegative;
  const technicalEvidence = evidenceLevel(scored);
  const impactEvidence = evidenceLevel(qualified);
  const parts = [];

  parts.push(scored >= MIN_SAMPLES
    ? `${entry.successes} of ${scored} recent attempts shipped or merged (${pct(entry.successes, scored)}%)`
    : `only ${scored} scored attempt${scored === 1 ? '' : 's'} so far, too few to judge`);

  const notCounted = entry.refused + entry.infra;
  if (notCounted > 0) parts.push(`${notCounted} more not counted for or against it (refused, or caused by infrastructure or a person's decision)`);

  if (qualified >= MIN_SAMPLES) {
    parts.push(`of ${qualified} evidence-supported impact measurements, ${entry.impactPositive} improved clicks beyond the site's own trend and ${entry.impactNegative} got worse`);
  } else if (qualified > 0) {
    parts.push(`${qualified} evidence-supported impact measurement${qualified === 1 ? '' : 's'}, too few to judge`);
  }
  if (entry.impactNeutral > 0) parts.push(`${entry.impactNeutral} impact measurement${entry.impactNeutral === 1 ? ' was' : 's were'} inconclusive (inside normal noise, or the page moved with the whole site)`);

  let text = `${generatorId}: ${parts.join('; ')}.`;
  if (entry.demote && entry.reason) text += ` Held for human review: ${entry.reason}.`;
  if (qualified + entry.impactNeutral > 0) text += ` Impact is observed correlation over ${impactWindowDays}-day windows, not proven cause.`;

  return {
    generatorId, technicalEvidence, impactEvidence, demoted: Boolean(entry.demote), text,
    counts: {
      shipped: entry.successes, failed: entry.failures, refused: entry.refused, notCounted: entry.infra,
      impactPositive: entry.impactPositive, impactNegative: entry.impactNegative, impactInconclusive: entry.impactNeutral,
    },
  };
}

export async function getBehaviourLearning(siteId, { deps = {} } = {}) {
  const getMap = deps.getLearnedConfidenceMap || (async (...a) => (await import('../agents/lib/generator-learning.js')).getLearnedConfidenceMap(...a));
  const [learned, lifecycle] = await Promise.all([getMap(siteId), getExecutionLifecycle(siteId, { deps })]);
  const generators = [...learned.entries()]
    .map(([generatorId, entry]) => explainExperience(generatorId, entry))
    .sort((a, b) => a.generatorId.localeCompare(b.generatorId));
  return { siteId, generators, lifecycle: lifecycle.summary };
}
