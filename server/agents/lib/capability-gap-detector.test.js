import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

const resolve = (p) => new URL(p, import.meta.url).href;
const { createCapabilityGapDetector, CLUSTER_THRESHOLD } = await import(resolve('./capability-gap-detector.js'));

function draft(id, actionType, reason) {
  return { id, action_type: actionType, abandoned_reason: reason };
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
    });
    const gaps = await detector.detectCapabilityGaps(1);
    assert.equal(gaps.length, 0);
  });

  test('respects a custom threshold', async () => {
    const detector = createCapabilityGapDetector({
      listDraftsFn: async () => [draft(1, 'x', 'a'), draft(2, 'x', 'b')],
      classifyAbandonReasonFn: () => ({ failureClass: 'FAILED_BECAUSE_AGENT_LOGIC_IS_WRONG', retryPolicy: 'item_defect', summary: 's' }),
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
