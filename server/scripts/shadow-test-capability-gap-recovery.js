import { listDrafts } from '../store/drafts.js';
import { createDecisionEngine } from '../agents/lib/decision-engine.js';
import { createCapabilityGapDetector } from '../agents/lib/capability-gap-detector.js';

// Shadow-mode proof for the "one intelligence" consolidation plan's Smart
// Failure Recovery requirement: run the real capability-gap-detector
// (Phase 5, including its investigation of the generic-fallback bucket)
// against REAL historical data, with ZERO side effects — no draft status
// changes, no repairs queued, and (unlike a normal decisionEngine call)
// no `decisions` table write either, since a pure shadow run should leave
// no trace beyond its own printed report. The one real effect this script
// has is a real LLM API call for the investigation step itself — that's
// inherent to actually proving the reasoning works, not a side effect on
// any persisted state.
//
// Run with: node server/scripts/shadow-test-capability-gap-recovery.js <siteId>
//
// Verified against the real Admizz Education incident (site 8862,
// 2026-09-22): 116 abandoned expand-content drafts sharing the
// SEOAI:EXPANDEDCONTENT marker-resolution failure, none matching an
// existing attempt-classification.js RULE, two genuinely distinct root
// causes underneath (self-closing-root-no-body / no-jsx-return-found) —
// see capability-gap-detector.js's own comment for the full query trail.

const siteId = Number(process.argv[2]);
if (!siteId) {
  console.error('Usage: node server/scripts/shadow-test-capability-gap-recovery.js <siteId>');
  process.exit(1);
}

// A decision-engine whose decide() reasons and returns normally but never
// writes to the decisions table — the shadow-mode guarantee for this
// specific proof run.
const shadowDecisionEngine = createDecisionEngine({
  insertDecisionFn: async (siteId, decision) => ({ id: null, siteId, ...decision }),
});

const detector = createCapabilityGapDetector({ listDraftsFn: listDrafts, decisionEngineFn: shadowDecisionEngine });

console.log(`[shadow-test] Detecting capability gaps for site ${siteId} (read-only, no writes)...`);
const gaps = await detector.detectCapabilityGaps(siteId);

if (!gaps.length) {
  console.log('[shadow-test] No capability gaps met the clustering threshold.');
  process.exit(0);
}

for (const gap of gaps) {
  console.log('\n' + '='.repeat(80));
  console.log(`Generator: ${gap.generatorId}`);
  console.log(`Failure category: ${gap.summary}`);
  console.log(`Affected drafts: ${gap.affectedCount} (ids: ${gap.affectedIds.slice(0, 10).join(', ')}${gap.affectedIds.length > 10 ? `, +${gap.affectedIds.length - 10} more` : ''})`);
  if (gap.investigation === undefined) {
    console.log('Investigation: not run (known RULES match — no ambiguity to investigate).');
  } else if (gap.investigation === null) {
    console.log('Investigation: FAILED (see warning above).');
  } else {
    console.log('\n--- decision-engine investigation ---');
    console.log(`Action: ${gap.investigation.action}`);
    console.log(`Confidence: ${gap.investigation.confidence}`);
    console.log(`Rationale: ${gap.investigation.rationale}`);
    if (gap.investigation.rootCause) console.log(`Root cause: ${JSON.stringify(gap.investigation.rootCause)}`);
    if (gap.investigation.missingEvidence?.length) console.log(`Missing evidence: ${gap.investigation.missingEvidence.join('; ')}`);
  }
}
console.log('\n' + '='.repeat(80));
console.log(`[shadow-test] Done. ${gaps.length} gap(s) reported. No drafts, decisions, or repairs were changed.`);
process.exit(0);
