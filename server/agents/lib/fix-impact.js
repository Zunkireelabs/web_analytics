import {
  getDueImpactMeasurements, recordImpactOutcome, getPageSearchTotals, IMPACT_WINDOW_DAYS,
} from '../../store/fix-impact.js';
import { recordOutcome } from './generator-learning.js';
import { getDeploymentById, deploymentGraceElapsed } from '../../store/deployments.js';
import { suppressFix, isMaterialRegression } from '../../store/fix-suppressions.js';

// Measures what a merged fix actually did to real Search Console numbers, which
// is the one thing this system has never checked about its own work. Every
// expectedImpact it produces (opportunity.js's estimatedTrafficGain,
// growth-projection.js's trajectories) is a forecast that has never been
// compared against an outcome.
//
// Sibling of fix-verification.js, answering a different question about the same
// merged draft: that module re-checks the live page 48h later to confirm the
// ISSUE is gone (correctness), this one compares 28 days of before/after search
// performance (impact). Both are due-driven sweeps over their own table rather
// than per-site loops, because due-ness is per-row.
//
// The house rule this module exists under: every number is computed in plain JS
// from real stored data, never asked of a model, and a window with no data
// reports insufficient-data rather than a fabricated zero.

// Days to skip immediately after the merge. A change needs to be crawled and
// re-indexed before its effect can appear at all, and the days either side of a
// deploy are the noisiest in the whole series — including them would measure
// the deploy, not the fix.
const SETTLE_DAYS = 3;

function isoDay(d) {
  return d.toISOString().slice(0, 10);
}

function shiftDays(date, days) {
  const d = new Date(date);
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}

// before = the WINDOW_DAYS ending the day before the merge.
// after  = the WINDOW_DAYS starting SETTLE_DAYS after the merge.
// Equal-length windows, so the comparison is not distorted by one side simply
// covering more days than the other.
export function measurementWindows(mergedAt, windowDays = IMPACT_WINDOW_DAYS) {
  const merged = new Date(mergedAt);
  const beforeEnd = shiftDays(merged, -1);
  const beforeStart = shiftDays(beforeEnd, -(windowDays - 1));
  const afterStart = shiftDays(merged, SETTLE_DAYS);
  const afterEnd = shiftDays(afterStart, windowDays - 1);
  return {
    before: { start: isoDay(beforeStart), end: isoDay(beforeEnd) },
    after: { start: isoDay(afterStart), end: isoDay(afterEnd) },
  };
}

function pctChange(before, after) {
  if (before == null || after == null || before === 0) return null;
  return Number((((after - before) / before) * 100).toFixed(1));
}

// Position is the one metric where LOWER is better, so its delta is reported as
// (before - after): a positive number means the page moved UP the results. Every
// other delta is (after - before). Getting this backwards is the classic bug in
// SEO reporting, hence the explicit naming below.
export function computeDelta(before, after) {
  return {
    clicks: after.clicks - before.clicks,
    clicksPct: pctChange(before.clicks, after.clicks),
    impressions: after.impressions - before.impressions,
    impressionsPct: pctChange(before.impressions, after.impressions),
    ctr: before.ctr == null || after.ctr == null ? null : Number((after.ctr - before.ctr).toFixed(5)),
    // Positive = improved (moved closer to position 1).
    avgPosition: before.avgPosition == null || after.avgPosition == null
      ? null
      : Number((before.avgPosition - after.avgPosition).toFixed(2)),
    basis: 'observed',
    // Carried in the stored row itself, not just in a doc comment, so anything
    // that renders this cannot present it as proof the fix caused the change.
    caveat: 'Observed change over equal before/after windows. Search performance moves for many reasons (seasonality, algorithm updates, competitors, other changes shipped in the same period) — this is correlation, not attribution.',
  };
}

// The one already-computed, already-signed number this module uses to
// classify a measured outcome for the learning loop (see
// generator-learning.js's impactConfidence bucket): clicks is the most
// directly interpretable "did this help traffic" figure of the four in
// delta, it is never null when status is 'measured' (both windows have
// real impressions by construction), and computeDelta already documents
// its sign convention (positive = improved) — reused as-is, not a new
// formula. Deliberately NOT a weighted blend of clicks/impressions/
// position/ctr — that would be exactly the kind of invented business rule
// this system avoids; impressions/position/ctr remain visible in the
// stored delta for human review, just not used to derive this label.
export function classifyImpact(delta) {
  if (delta.clicks > 0) return 'impact-positive';
  if (delta.clicks < 0) return 'impact-negative';
  return 'impact-neutral';
}

// Deployment → production-verification gap (2026-09 lifecycle-gap audit,
// finding #2): scheduleImpactMeasurement used to assume a human's merge WAS
// a live deploy — "the merge is the only moment we know a fix is genuinely
// live" (routes/action-center.js's finalizeImplemented, an explicit stated
// assumption). deployments.js (migration 153) already tracks the real
// signal — fix-verification.js's live page re-check actually confirming the
// shipped content is present — this just consults it before trusting the
// merge date, rather than building a second live-check mechanism.
//
// Returns null when it's safe to proceed with measurement (deployed,
// confirmed by a real re-check, or no deployment tracked for this row at
// all — unchanged pre-existing behavior). Returns a status string
// ('await' | 'insufficient-data') otherwise.
async function resolveDeploymentGate(row) {
  if (!row.deployment_id) return null; // nothing tracked — measure exactly as before this existed
  const deployment = await getDeploymentById(row.deployment_id);
  if (!deployment || deployment.status === 'deployed') return null;
  // Still within the grace window fix-verification.js itself uses — not yet
  // confirmed live, but not proven absent either. 'await', not
  // insufficient-data: this row keeps its existing measure_after untouched,
  // so runDueImpactMeasurements' own daily sweep naturally re-checks it
  // tomorrow — the same deploy-aware "wait, don't guess" pattern
  // AWAIT_RECHECK_HOURS uses in fix-verification.js, without needing a
  // second reschedule mechanism here.
  if (!deploymentGraceElapsed(deployment)) return 'await';
  return 'insufficient-data';
}

export async function measureOne(row) {
  const gate = await resolveDeploymentGate(row);
  if (gate === 'await') return null; // left pending, unchanged — re-checked on the next daily sweep
  if (gate === 'insufficient-data') {
    // The grace window elapsed with no live confirmation — this merge may
    // never have actually deployed. Measuring real GSC data against an
    // assumed-live date would silently attribute a change this system never
    // actually confirmed shipped. Same honest status already used for "no
    // GSC data in the window" — no outcome is logged for the learning loop
    // either, "we don't know" must never read as neutral/negative.
    return recordImpactOutcome(row.id, {
      status: 'insufficient-data',
      beforeWindow: { reason: 'deployment-not-detected', deploymentId: row.deployment_id },
      afterWindow: null, delta: null,
    });
  }

  const windows = measurementWindows(row.merged_at);
  const [before, after] = await Promise.all([
    getPageSearchTotals(row.site_id, row.page_url, windows.before.start, windows.before.end),
    getPageSearchTotals(row.site_id, row.page_url, windows.after.start, windows.after.end),
  ]);

  // A page with no impressions before the fix has no baseline to compare
  // against, and one with none after may simply not have been re-crawled yet.
  // Either way there is no honest comparison to report — and reporting "+0%"
  // would read as "the fix did nothing", which is a different and unearned
  // claim. No outcome is logged for the learning loop either — "we don't
  // know" must never be recorded as a neutral/negative signal.
  if (!before || !after) {
    return recordImpactOutcome(row.id, {
      status: 'insufficient-data',
      beforeWindow: before, afterWindow: after, delta: null,
    });
  }

  const delta = computeDelta(before, after);
  const updated = await recordImpactOutcome(row.id, { status: 'measured', beforeWindow: before, afterWindow: after, delta });

  // The design lessons that came from this draft get the page's real before
  // and after: the lesson was recorded with the pre-fix baseline, and this is
  // the measured result, so a design fix that helped is distinguishable from
  // one that only validated. Never allowed to fail the measurement.
  try {
    const { attachImpactToLessons } = await import('../../store/design-knowledge.js');
    await attachImpactToLessons(row.site_id, row.draft_id, {
      before, after, delta, windowDays: IMPACT_WINDOW_DAYS, measuredAt: new Date().toISOString(),
    });
  } catch (err) {
    console.warn(`[fix-impact] design-lesson impact not attached for draft ${row.draft_id}: ${err.message}`);
  }

  // Distinct from the technical shipped/failed/merged/rejected signal
  // (generator-learning.js keeps them in separate buckets) — this is
  // "did the fix move the metric", logged into the same existing
  // outcome/confidence mechanism rather than a new one.
  await recordOutcome(row.site_id, row.generator_id, classifyImpact(delta), {
    draftId: row.draft_id, detail: `clicks ${delta.clicks >= 0 ? '+' : ''}${delta.clicks} over ${IMPACT_WINDOW_DAYS}d post-merge`,
  });

  // recordOutcome above moves this generator's confidence for the whole
  // SITE, which is the right granularity for "this generator is unreliable"
  // and cannot express "this generator is fine, but it is wrong for THIS
  // page". Until now a measurably harmful fix changed nothing on the page it
  // harmed: the recommendation was re-detected, re-drafted and re-shipped,
  // and no failure cap ever tripped because the fix did not fail — it applied
  // cleanly and made things worse.
  //
  // Deliberately stricter than classifyImpact's own 'impact-negative', which
  // fires on a single lost click. See isMaterialRegression for why.
  //
  // Never allowed to fail the measurement: the impact row is the valuable
  // record here, and a suppression that could not be written is recoverable
  // on the next measurement, while a lost measurement is not.
  if (isMaterialRegression(delta, before)) {
    await suppressFix(row.site_id, {
      scope: 'page', scopeKey: row.page_url, generatorId: row.generator_id,
      reason: 'measured-regression',
      evidence: { draftId: row.draft_id, before, after, delta, windowDays: IMPACT_WINDOW_DAYS },
    }).catch((err) => console.error(`[fix-impact] could not suppress ${row.generator_id} on ${row.page_url}:`, err.message));
  }

  // Close the Decision Engine's loop (166/184). THIS is the moment a
  // decision's outcome is actually known: a real before/after Search Console
  // comparison now exists, which is a far stronger statement than "it
  // shipped".
  //
  // 'verified' and 'failed' here mean what the MEASUREMENT says, not whether
  // the mechanics worked. A fix that applied cleanly and lost real traffic is
  // a failed decision, and recording it as verified because the PR merged is
  // exactly the self-congratulatory bookkeeping that would make the engine's
  // own history worthless to learn from. The bar is isMaterialRegression —
  // the same stricter threshold the suppression above uses, deliberately not
  // classifyImpact's single-lost-click one.
  //
  // outcome_ref is the forward link migration 166's own comment promised and
  // nothing ever wrote.
  await recordDecisionOutcome(row, isMaterialRegression(delta, before))
    .catch((err) => console.warn(`[fix-impact] could not record a decision outcome for draft ${row.draft_id}: ${err.message}`));

  return updated;
}

// Imported lazily and wrapped: a decision is an optional annotation on a
// recommendation (only DEFAULT-bucket findings get one, migration 173), so
// for almost every measurement this is one indexed lookup that finds
// nothing. It must never be able to fail a measurement.
async function recordDecisionOutcome(row, regressed) {
  const [{ getDecisionIdForDraft }, { advanceDecision, outcomeRefForFixImpact }] = await Promise.all([
    import('../../store/decisions.js'),
    import('./decision-lifecycle.js'),
  ]);
  const decisionId = await getDecisionIdForDraft(row.site_id, row.draft_id);
  if (!decisionId) return null;
  return advanceDecision(decisionId, regressed ? 'failed' : 'verified', {
    outcomeRef: outcomeRefForFixImpact(row.id),
  });
}

// Due-driven sweep, mirroring fix-verification.js's runDueVerifications. One
// row's failure never stops the rest — a single page's bad read should not
// stall every other pending measurement behind it.
export async function runDueImpactMeasurements() {
  const due = await getDueImpactMeasurements();
  const results = [];
  for (const row of due) {
    try {
      const updated = await measureOne(row);
      results.push(updated);
      if (updated?.status === 'measured') {
        const d = updated.delta;
        console.log(`[fix-impact] site ${row.site_id} draft ${row.draft_id} (${row.generator_id}) ${row.page_url}: impressions ${d.impressions >= 0 ? '+' : ''}${d.impressions}, clicks ${d.clicks >= 0 ? '+' : ''}${d.clicks}, position ${d.avgPosition == null ? 'n/a' : (d.avgPosition >= 0 ? '+' : '') + d.avgPosition}`);
      }
    } catch (err) {
      console.error(`[fix-impact] could not measure draft ${row.draft_id} for site ${row.site_id}:`, err.message);
    }
  }
  if (results.length) console.log(`[fix-impact] measured ${results.filter((r) => r?.status === 'measured').length}/${due.length} due row(s)`);
  return results;
}
