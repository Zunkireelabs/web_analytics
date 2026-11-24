import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

const resolve = (p) => new URL(p, import.meta.url).href;
const { createCapabilityGapDetector, CLUSTER_THRESHOLD, UNCLASSIFIED_FALLBACK_SUMMARY } = await import(resolve('./capability-gap-detector.js'));

function draft(id, actionType, reason) {
  return { id, action_type: actionType, abandoned_reason: reason };
}

// Every existing test below passes a decisionEngineFn stub that throws if
// called, so a bug that accidentally investigates a KNOWN-rule cluster (not
// just the generic fallback one) fails loudly rather than silently paying
// for an LLM call the design says should never happen for that case.
function neverCalledDecisionEngine() {
  return { decide: async () => { throw new Error('decision-engine should not be called for a known-RULES cluster'); } };
}

describe('detectCapabilityGaps — clustering', () => {
  test('groups same-generator ITEM_DEFECT failures sharing a summary into one gap', async () => {
    const detector = createCapabilityGapDetector({
      listDraftsFn: async () => [
        draft(1, 'expand-content', 'unsupported JSX structure on page A'),
        draft(2, 'expand-content', 'unsupported JSX structure on page B'),
        draft(3, 'expand-content', 'unsupported JSX structure on page C'),
      ],
      classifyAbandonReasonFn: () => ({ failureClass: 'FAILED_BECAUSE_AGENT_LOGIC_IS_WRONG', retryPolicy: 'item_defect', summary: 'Unsupported JSX structure' }),
      decisionEngineFn: neverCalledDecisionEngine(),
    });

    const gaps = await detector.detectCapabilityGaps(1);
    assert.equal(gaps.length, 1);
    assert.equal(gaps[0].generatorId, 'expand-content');
    assert.equal(gaps[0].affectedCount, 3);
    assert.deepEqual(gaps[0].affectedIds, [1, 2, 3]);
    assert.equal(gaps[0].status, 'detected');
  });

  test('does not cluster failures below the threshold', async () => {
    const detector = createCapabilityGapDetector({
      listDraftsFn: async () => [
        draft(1, 'expand-content', 'x'),
        draft(2, 'expand-content', 'y'),
      ],
      classifyAbandonReasonFn: () => ({ failureClass: 'FAILED_BECAUSE_AGENT_LOGIC_IS_WRONG', retryPolicy: 'item_defect', summary: 'same category' }),
      decisionEngineFn: neverCalledDecisionEngine(),
    });
    const gaps = await detector.detectCapabilityGaps(1);
    assert.equal(gaps.length, 0);
  });

  test('respects a custom threshold', async () => {
    const detector = createCapabilityGapDetector({
      listDraftsFn: async () => [draft(1, 'x', 'a'), draft(2, 'x', 'b')],
      classifyAbandonReasonFn: () => ({ failureClass: 'FAILED_BECAUSE_AGENT_LOGIC_IS_WRONG', retryPolicy: 'item_defect', summary: 's' }),
      decisionEngineFn: neverCalledDecisionEngine(),
    });
    const gaps = await detector.detectCapabilityGaps(1, { threshold: 2 });
    assert.equal(gaps.length, 1);
  });

  test('excludes non-ITEM_DEFECT policies (retry/needs_human/already_resolved/never)', async () => {
    const detector = createCapabilityGapDetector({
      listDraftsFn: async () => [draft(1, 'x', 'a'), draft(2, 'x', 'b'), draft(3, 'x', 'c')],
      classifyAbandonReasonFn: (reason) => ({
        failureClass: null,
        retryPolicy: reason === 'a' ? 'retry' : reason === 'b' ? 'needs_human' : 'already_resolved',
        summary: 'irrelevant',
      }),
    });
    const gaps = await detector.detectCapabilityGaps(1, { threshold: 1 });
    assert.equal(gaps.length, 0);
  });

  test('different generators with the same failure summary do not merge', async () => {
    const detector = createCapabilityGapDetector({
      listDraftsFn: async () => [
        draft(1, 'expand-content', 'a'), draft(2, 'expand-content', 'a'), draft(3, 'expand-content', 'a'),
        draft(4, 'blog-outline', 'a'), draft(5, 'blog-outline', 'a'), draft(6, 'blog-outline', 'a'),
      ],
      classifyAbandonReasonFn: () => ({ failureClass: 'FAILED_BECAUSE_AGENT_LOGIC_IS_WRONG', retryPolicy: 'item_defect', summary: 'same summary' }),
      decisionEngineFn: neverCalledDecisionEngine(),
    });
    const gaps = await detector.detectCapabilityGaps(1);
    assert.equal(gaps.length, 2);
    assert.deepEqual(gaps.map((g) => g.generatorId).sort(), ['blog-outline', 'expand-content']);
  });
});

describe('CLUSTER_THRESHOLD', () => {
  test('defaults to 3', () => {
    assert.equal(CLUSTER_THRESHOLD, 3);
  });
});

describe('detectCapabilityGaps — investigating the generic fallback bucket', () => {
  test('never investigates a cluster with a real (non-fallback) summary', async () => {
    const detector = createCapabilityGapDetector({
      listDraftsFn: async () => [draft(1, 'x', 'a'), draft(2, 'x', 'b'), draft(3, 'x', 'c')],
      classifyAbandonReasonFn: () => ({ failureClass: 'FAILED_BECAUSE_AGENT_LOGIC_IS_WRONG', retryPolicy: 'item_defect', summary: 'A real, specific RULES match' }),
      decisionEngineFn: neverCalledDecisionEngine(),
    });
    const gaps = await detector.detectCapabilityGaps(1);
    assert.equal(gaps.length, 1);
    assert.equal(gaps[0].investigation, undefined);
  });

  test('investigates a generic-fallback cluster, sending frequency-sorted DISTINCT shapes (not raw items)', async () => {
    let receivedSituation = null, receivedEvidence = null;
    const detector = createCapabilityGapDetector({
      // 2 occurrences of shape A (different pages), 1 of shape B — real
      // path-bearing reason text, same shape attempt-classification.js's
      // own RULES match against.
      listDraftsFn: async () => [
        draft(1, 'expand-content', 'Could not safely resolve marker(s) in src/app/page-a/page.tsx: expandedContent (no-jsx-return-found)'),
        draft(2, 'expand-content', 'Could not safely resolve marker(s) in src/app/page-b/page.tsx: expandedContent (no-jsx-return-found)'),
        draft(3, 'expand-content', 'Could not safely resolve marker(s) in src/app/page-c/page.tsx: expandedContent (self-closing-root-no-body)'),
      ],
      classifyAbandonReasonFn: () => ({ failureClass: 'FAILED_BECAUSE_AGENT_LOGIC_IS_WRONG', retryPolicy: 'item_defect', summary: UNCLASSIFIED_FALLBACK_SUMMARY }),
      decisionEngineFn: {
        decide: async (siteId, situation, evidence) => {
          receivedSituation = situation; receivedEvidence = evidence;
          return { action: 'investigate_further', rationale: 'Two distinct root causes underneath one generic bucket.' };
        },
      },
    });

    const gaps = await detector.detectCapabilityGaps(1);
    assert.equal(gaps.length, 1);
    assert.equal(gaps[0].investigation.action, 'investigate_further');
    assert.match(receivedSituation, /expand-content/);
    // 3 raw items collapse to 2 DISTINCT shapes (paths normalized away),
    // sorted by true frequency — the no-jsx-return-found shape (count 2)
    // must sort before self-closing-root-no-body (count 1).
    assert.equal(receivedEvidence.length, 2);
    assert.match(receivedEvidence[0].summary, /Occurred 2 time\(s\)/);
    assert.match(receivedEvidence[0].summary, /no-jsx-return-found/);
    assert.match(receivedEvidence[1].summary, /Occurred 1 time\(s\)/);
    assert.equal(receivedEvidence[0].meta.count, 2);
  });

  test('a failed investigation is caught and recorded as null, never thrown', async () => {
    const detector = createCapabilityGapDetector({
      listDraftsFn: async () => [draft(1, 'x', 'a'), draft(2, 'x', 'b'), draft(3, 'x', 'c')],
      classifyAbandonReasonFn: () => ({ failureClass: 'FAILED_BECAUSE_AGENT_LOGIC_IS_WRONG', retryPolicy: 'item_defect', summary: UNCLASSIFIED_FALLBACK_SUMMARY }),
      decisionEngineFn: { decide: async () => { throw new Error('LLM unavailable'); } },
    });
    const gaps = await detector.detectCapabilityGaps(1);
    assert.equal(gaps[0].investigation, null);
  });

  test('investigateUnclassified: false skips investigation entirely, even for the fallback bucket', async () => {
    const detector = createCapabilityGapDetector({
      listDraftsFn: async () => [draft(1, 'x', 'a'), draft(2, 'x', 'b'), draft(3, 'x', 'c')],
      classifyAbandonReasonFn: () => ({ failureClass: 'FAILED_BECAUSE_AGENT_LOGIC_IS_WRONG', retryPolicy: 'item_defect', summary: UNCLASSIFIED_FALLBACK_SUMMARY }),
      decisionEngineFn: neverCalledDecisionEngine(),
    });
    const gaps = await detector.detectCapabilityGaps(1, { investigateUnclassified: false });
    assert.equal(gaps[0].investigation, undefined);
  });
});

describe('detectCapabilityGaps — failures from before this build do not keep a gap alive', () => {
  const BOOT = new Date('2026-11-23T17:07:00Z');
  const at = (id, iso) => ({ id, action_type: 'faq', abandoned_reason: 'x', updated_at: iso });
  const base = (drafts) => createCapabilityGapDetector({
    listDraftsFn: async () => drafts,
    classifyAbandonReasonFn: () => ({ failureClass: 'FAILED_BECAUSE_AGENT_LOGIC_IS_WRONG', retryPolicy: 'item_defect', summary: 'Undersized tap target' }),
    decisionEngineFn: neverCalledDecisionEngine(),
    buildStartedAt: BOOT,
  });

  test('three failures all from before the build (the code was fixed since): no gap', async () => {
    const gaps = await base([at(1, '2026-11-20T06:00:00Z'), at(2, '2026-11-21T07:00:00Z'), at(3, '2026-11-21T07:10:00Z')]).detectCapabilityGaps(1);
    assert.deepEqual(gaps, []);
  });
  test('three failures from this build: a gap, as before', async () => {
    const gaps = await base([at(1, '2026-11-24T02:00:00Z'), at(2, '2026-11-24T02:05:00Z'), at(3, '2026-11-24T02:10:00Z')]).detectCapabilityGaps(1);
    assert.equal(gaps.length, 1);
    assert.deepEqual(gaps[0].affectedIds, [1, 2, 3]);
  });
  test('old and new failures together: only the new ones count, so two new ones are still below the threshold', async () => {
    const gaps = await base([at(1, '2026-11-20T06:00:00Z'), at(2, '2026-11-21T07:00:00Z'), at(3, '2026-11-24T02:00:00Z'), at(4, '2026-11-24T02:05:00Z')]).detectCapabilityGaps(1);
    assert.deepEqual(gaps, []);
  });
  test('a draft with no date is still counted (nothing is dropped on missing data)', async () => {
    const gaps = await base([{ id: 1, action_type: 'faq', abandoned_reason: 'x' }, { id: 2, action_type: 'faq', abandoned_reason: 'x' }, { id: 3, action_type: 'faq', abandoned_reason: 'x' }]).detectCapabilityGaps(1);
    assert.equal(gaps.length, 1);
  });
});
