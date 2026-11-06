import { classifyImpactEvidence } from './fix-impact.js';
import {
  reconcileOpportunityLifecycles, listUncountedVerifiedOutcomes, markOutcomeCounted,
} from '../../store/opportunity-lifecycle.js';
import { recordOpportunityOutcome, getLearnedMultipliers } from '../../store/competitor-opportunities.js';

// Closes the loop (Phase 6): what actually happened after a competitor opportunity was shipped, and what the system
// is allowed to learn from it.
//
// Two rules decide everything here, and both exist to stop the system flattering itself:
//
//   1. Only a MEASURED outcome counts. An opened PR counts for nothing, a merged PR counts for nothing, and a deploy
//      counts for nothing. The lifecycle is derived from real records (store/opportunity-lifecycle.js) and only the
//      'verified' rung — fix_impact has measured the window after the change — is eligible.
//   2. A measured change is only called a win or a loss when the evidence supports it. That judgement is NOT made
//      here: it reuses classifyImpactEvidence (fix-impact.js), which already requires the change to be material,
//      outside Poisson noise, and not merely the whole site moving. Anything it calls inconclusive is recorded as
//      neutral, which counts towards the sample but teaches neither direction.
//
// Everything is per site_id. What one project learned never reaches another; cross-project patterns are the separate
// industry-intelligence layer's job, and only in aggregated, de-identified form.

/**
 * Reconcile lifecycles, then count whatever has newly reached a measured outcome.
 *
 * Returns { advanced[], counted[], multipliers, skipped } — `skipped` lists outcomes that could not be judged and why,
 * so a run that learned nothing is explainable rather than silent.
 */
export async function learnFromCompetitorOutcomes(siteId, { limit = 100, deps = {} } = {}) {
  const reconcile = deps.reconcileOpportunityLifecycles || reconcileOpportunityLifecycles;
  const listUncounted = deps.listUncountedVerifiedOutcomes || listUncountedVerifiedOutcomes;
  const markCounted = deps.markOutcomeCounted || markOutcomeCounted;
  const record = deps.recordOpportunityOutcome || recordOpportunityOutcome;
  const multipliers = deps.getLearnedMultipliers || getLearnedMultipliers;
  const classify = deps.classifyImpactEvidence || classifyImpactEvidence;

  const { checked, advanced } = await reconcile(siteId, { limit });
  const pending = await listUncounted(siteId, { limit });

  const counted = [];
  const skipped = [];
  for (const row of pending) {
    const delta = row.delta || null;
    const before = beforeFrom(row);
    if (!delta || !before) {
      // No usable measurement: deliberately NOT counted at all. Recording it as neutral would add a sample the system
      // never actually observed, which is worse than learning nothing.
      skipped.push({ gapId: row.gap_id, topic: row.topic, reason: 'no_measurement' });
      continue;
    }

    // fix-impact's own measurement already stored a verdict, computed WITH the site-wide control for those same two
    // windows (measureOne -> delta.verdict). Use it: re-deriving the verdict here would have no control to compare
    // against, so every real improvement would come back 'no-site-control' and nothing would ever be learned.
    // Only a legacy row measured before verdicts were stored falls back to classifying, and without a control it can
    // only ever reach neutral — which is the honest answer for a measurement whose context was never recorded.
    const { verdict, reason } = delta.verdict
      ? { verdict: delta.verdict, reason: delta.verdictReason || 'stored' }
      : classify(delta, before, null);
    const outcome = verdict === 'impact-positive' ? 'positive' : verdict === 'impact-negative' ? 'negative' : 'neutral';

    // Mark first: if recording then fails, the worst case is one uncounted outcome, not the same one counted forever.
    const claimed = await markCounted(siteId, row.gap_id);
    if (!claimed) {
      skipped.push({ gapId: row.gap_id, topic: row.topic, reason: 'already_counted' });
      continue;
    }
    await record(siteId, row.opportunity_type, outcome);
    counted.push({
      gapId: row.gap_id, topic: row.topic, opportunityType: row.opportunity_type,
      outcome, verdict, reason, clicksDelta: delta.clicks ?? null,
    });
  }

  return { checked, advanced, counted, skipped, multipliers: await multipliers(siteId) };
}

// fix_impact stores the before window as JSON; classifyImpactEvidence needs its clicks. Accepts either the stored
// column or an already-parsed object, and returns null rather than a zero-filled stand-in when it is unusable — a
// missing baseline must stop a verdict, not produce a confident one.
function beforeFrom(row) {
  const raw = row.before_window ?? row.before ?? null;
  if (!raw) return null;
  const parsed = typeof raw === 'string' ? safeParse(raw) : raw;
  if (!parsed || typeof parsed.clicks !== 'number') return null;
  return parsed;
}

function safeParse(text) {
  try { return JSON.parse(text); } catch { return null; }
}

/**
 * What this project has learned, in words, for a report or the CLI. Says plainly when there is not enough evidence
 * yet, rather than presenting an early lean as a finding.
 */
export function describeLearning(multipliers) {
  const entries = Object.entries(multipliers || {});
  if (!entries.length) {
    return 'No verified outcomes yet, so every kind of work is still weighted equally. Nothing has been learned.';
  }
  return entries
    .sort((a, b) => b[1] - a[1])
    .map(([type, m]) => {
      const verdict = m >= 1.15 ? 'has been working here' : m <= 0.85 ? 'has not been working here' : 'is about even here';
      return `${type.replace(/_/g, ' ')}: ${verdict} (weight ${m}).`;
    })
    .join(' ');
}
