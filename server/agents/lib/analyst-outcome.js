import { getAnalystOutcomeChain, recordAnalystOutcome, analystOutcomeSummary } from '../../store/analyst-evidence.js';

// Closes the loop the request calls "insight -> recommendation -> generated
// change -> PR -> shipped -> post-change metrics -> outcome" — every link of
// that chain already existed as separate tables (analyst_evidence,
// recommendations, drafts, fix_impact); this module is the sweep that reads
// the chain once fix-impact.js has produced a real measurement and writes
// the verdict back onto the analyst_evidence row that started it.
//
// Deliberately does NOT re-measure anything itself. fix-impact.js already
// owns "wait until 31 days post-merge, then compute a real before/after
// delta from gsc_breakdown" (runDueImpactMeasurements, on its own due-driven
// schedule) — this only asks "has that measurement landed for a
// recommendation this fusion pass created, and if so, what does it say
// about the conclusion that produced it".
export async function sweepAnalystOutcomes(siteId) {
  const rows = await getAnalystOutcomeChain(siteId, { onlyUnmeasured: true });
  let recorded = 0;
  for (const row of rows) {
    if (row.impact_status !== 'measured' || !row.delta) continue; // still waiting on fix-impact.js's own window

    // 'improved' reuses fix-impact.js's own sign convention (computeDelta):
    // clicks is the one always-populated, directly-interpretable figure.
    // Deliberately not a weighted blend of clicks/impressions/position — see
    // fix-impact.js's classifyImpact for why that line is not crossed here
    // either.
    const clicksDelta = Number(row.delta.clicks);
    const improved = Number.isFinite(clicksDelta) ? clicksDelta > 0 : null;

    // For a decline-risk conclusion, the PREDICTION was "this will keep
    // getting worse without intervention" — so confirming the prediction
    // means the fix reversed it (improved === true). For a growth-opportunity
    // conclusion, the prediction was "capturing this demand is achievable" —
    // confirmed the same way. Recorded explicitly rather than left for a
    // reader to infer from direction + improved, since that is exactly the
    // fact a future calibration step needs without re-deriving it.
    const predictionConfirmed = improved;

    await recordAnalystOutcome(row.id, {
      improved, predictionConfirmed, delta: row.delta,
      draftId: row.draft_id, prUrl: row.pr_url, recommendationStatus: row.recommendation_status,
      measuredAt: row.impact_measured_at,
    });
    recorded++;
  }
  if (recorded) console.log(`[analyst-outcome] site ${siteId}: recorded ${recorded} outcome(s) from newly-measured fixes.`);
  return { checked: rows.length, recorded };
}

export async function sweepAnalystOutcomesForAllSites() {
  // Dynamic import to avoid a circular static import with job.js, which
  // itself imports this module — same pattern analyst-seo-mapping.js's
  // snapshotCapabilityVisibilityForAllSites already uses for the identical
  // reason.
  const { listConnectedSites } = await import('../../job.js');
  const sites = await listConnectedSites();
  const totals = { sites: 0, checked: 0, recorded: 0 };
  for (const site of sites) {
    try {
      const { checked, recorded } = await sweepAnalystOutcomes(site.id);
      totals.sites++; totals.checked += checked; totals.recorded += recorded;
    } catch (err) {
      console.error(`[analyst-outcome] sweep failed for site ${site.id} "${site.name}":`, err.message);
    }
  }
  return totals;
}

// "Which kinds of analyst recommendation actually produce growth" — the
// calibration input the request asks the system to eventually learn from.
// Read-only rollup over analystOutcomeSummary; nothing here changes scoring
// yet (a future step could feed this back into analyst-scoring.js's
// weights), but the data model and the read both exist now.
export async function getAnalystLearningSummary(siteId) {
  return analystOutcomeSummary(siteId);
}
