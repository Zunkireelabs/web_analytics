import { test, describe, mock } from 'node:test';
import assert from 'node:assert/strict';

// generator-learning.test.js covers the real query/window logic end-to-end
// against a real database. This file covers just the NEW impactConfidence
// aggregation added alongside it, with db.js's `query` mocked (same
// `mock.module` approach as auto-remediation.test.js) so it runs without a
// live database — the module under test is imported dynamically, after the
// mock is registered, for the same reason fix-impact-outcome.test.js does.
const resolve = (p) => new URL(p, import.meta.url).href;

let rowsToReturn;
mock.module(resolve('../../db.js'), {
  namedExports: { query: async () => ({ rows: rowsToReturn }) },
});

const { getLearnedConfidenceMap } = await import('./generator-learning.js');

function outcomeRow(generatorId, outcome, daysAgo = 0) {
  return { generator_id: generatorId, outcome, created_at: new Date(Date.now() - daysAgo * 86_400_000) };
}

describe('getLearnedConfidenceMap — impactConfidence is a separate signal from confidence', () => {
  test('impact outcomes never contribute to the technical confidence ratio', async () => {
    rowsToReturn = [
      outcomeRow('expand-content', 'shipped'),
      outcomeRow('expand-content', 'shipped'),
      outcomeRow('expand-content', 'shipped'),
      outcomeRow('expand-content', 'impact-negative'),
      outcomeRow('expand-content', 'impact-negative'),
      outcomeRow('expand-content', 'impact-negative'),
    ];
    const map = await getLearnedConfidenceMap(1);
    const entry = map.get('expand-content');
    assert.equal(entry.confidence, 1, 'three technical successes, zero technical failures — impact rows must not dilute this');
    assert.equal(entry.demote, false, 'weak measured impact alone must never demote a generator');
  });

  test('below the minimum impact sample size, impactConfidence is null (fails closed, not neutral-by-default)', async () => {
    rowsToReturn = [outcomeRow('expand-content', 'impact-positive'), outcomeRow('expand-content', 'impact-positive')];
    const map = await getLearnedConfidenceMap(1);
    assert.equal(map.get('expand-content').impactConfidence, null);
  });

  test('a real pattern of positive measured impact raises impactConfidence', async () => {
    rowsToReturn = [
      outcomeRow('expand-content', 'impact-positive'),
      outcomeRow('expand-content', 'impact-positive'),
      outcomeRow('expand-content', 'impact-positive'),
    ];
    const map = await getLearnedConfidenceMap(1);
    assert.equal(map.get('expand-content').impactConfidence, 1);
  });

  test('impact-neutral rows are recorded but excluded from the impactConfidence ratio, same as refused for confidence', async () => {
    rowsToReturn = [
      outcomeRow('expand-content', 'impact-positive'),
      outcomeRow('expand-content', 'impact-positive'),
      outcomeRow('expand-content', 'impact-positive'),
      outcomeRow('expand-content', 'impact-neutral'),
      outcomeRow('expand-content', 'impact-neutral'),
      outcomeRow('expand-content', 'impact-neutral'),
      outcomeRow('expand-content', 'impact-neutral'),
      outcomeRow('expand-content', 'impact-neutral'),
    ];
    const map = await getLearnedConfidenceMap(1);
    const entry = map.get('expand-content');
    assert.equal(entry.impactNeutral, 5);
    assert.equal(entry.impactConfidence, 1, 'neutral rows must not dilute the ratio toward 0.5');
  });

  test('a generator with no outcome history at all has no entry, for either signal', async () => {
    rowsToReturn = [];
    const map = await getLearnedConfidenceMap(1);
    assert.equal(map.has('expand-content'), false);
  });
});
