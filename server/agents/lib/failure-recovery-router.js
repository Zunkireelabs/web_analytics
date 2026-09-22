import { classifyFailure, shouldRetry } from '../../lib/failure-classification.js';
import { capabilityGapDetector } from './capability-gap-detector.js';
import { decisionEngine } from './decision-engine.js';

// Phase 8 of the "one intelligence" consolidation plan (fix/system) — the
// FAIL -> CLASSIFY -> INVESTIGATE -> ROOT CAUSE -> REPAIR -> REVALIDATE ->
// CONTINUE loop, built entirely as routing logic over the two already-
// correct classifiers this plan's audit confirmed exist (failure-
// classification.js's deterministic FAILURE_CLASS/shouldRetry, and this
// plan's own Phase 5 capability-gap-detector), plus decision-engine as the
// last resort for a failure that is neither a known transient fault nor
// part of a detected cluster.
//
// Routing order matters and mirrors the plan's stated priority: retry
// (existing, cheapest, already correct) -> capability-gap clustering
// (Phase 5, catches "this is the 4th of the same thing") -> decision-engine
// (most expensive, reserved for a genuinely novel failure shape). A
// transient EXTERNAL_SERVICE failure never reaches capability-gap-detector
// or decision-engine at all — shouldRetry's existing 3-attempt cap is
// untouched and remains authoritative for that class.
//
// Deliberately does not itself retry, pause a draft, or open a repair PR —
// same "decide, don't execute" boundary decision-engine.js keeps. A caller
// wiring this in later (not part of this commit) acts on the returned
// `route`.

export function createFailureRecoveryRouter({
  classifyFailureFn = classifyFailure,
  shouldRetryFn = shouldRetry,
  detectCapabilityGapsFn = capabilityGapDetector.detectCapabilityGaps,
  decisionEngineFn = decisionEngine,
} = {}) {
  async function routeFailure({ siteId, generatorId, stage, err, exitCode, timedOut, attempt = 1 }) {
    const classification = classifyFailureFn({ stage, err, exitCode, timedOut });

    if (shouldRetryFn(classification, attempt)) {
      return { route: 'retry', classification, capabilityGap: null, decision: null };
    }

    const gaps = await detectCapabilityGapsFn(siteId);
    const matchingGap = gaps.find((g) => g.generatorId === generatorId);
    if (matchingGap) {
      return { route: 'capability-gap', classification, capabilityGap: matchingGap, decision: null };
    }

    const situation = `Generator "${generatorId}" failed on site ${siteId} (${classification.errorCode}: ` +
      `${classification.message}) and is neither auto-retryable nor part of a detected same-site failure cluster.`;
    const decision = await decisionEngineFn.decide(siteId, situation, [
      { source: 'failure-classification', summary: classification.message, ref: `failure:${classification.errorCode}` },
    ]);
    return { route: 'decision-engine', classification, capabilityGap: null, decision };
  }

  return { routeFailure };
}

export const failureRecoveryRouter = createFailureRecoveryRouter();
